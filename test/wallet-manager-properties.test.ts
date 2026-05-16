/**
 * Property-based tests for WalletManager.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 3: Balance Display Precision
 * - Property 4: Non-Existent Wallet Error
 * - Property 8: Income Precision Preservation
 */

import fc from 'fast-check';
import {
  DefaultWalletManager,
  WalletManagerDependencies,
  WalletStore,
  WalletNotFoundError,
  formatBalanceForDisplay,
  formatAmountWithPrecision,
} from '../lib/wallet/wallet-manager';
import { WalletManagerConfig, AgentWallet } from '../lib/types/wallet';

// --- Test Helpers ---

function createConfig(): WalletManagerConfig {
  return {
    cdpApiKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:master-key',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
    network: 'base',
    provisioningTimeoutMs: 30000,
  };
}

function createMockDeps(walletStore?: Partial<WalletStore>): WalletManagerDependencies {
  return {
    cdpSdk: {
      createWallet: jest.fn().mockResolvedValue({
        walletId: 'wallet-123',
        address: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
        apiKeyId: 'key-id-001',
        apiKeySecret: 'secret-key-value',
      }),
      getUsdcBalance: jest.fn().mockResolvedValue('0.00'),
      creditUsdc: jest.fn().mockResolvedValue(undefined),
    },
    secretsManager: {
      createSecret: jest.fn().mockResolvedValue({ arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test' }),
    },
    tokenVault: {
      retrieveCredentials: jest.fn().mockResolvedValue({
        apiKeyId: 'key-id-001',
        apiKeySecret: 'secret-key-value',
      }),
    },
    identity: {
      createCredentialProvider: jest.fn().mockResolvedValue({ credentialProviderArn: 'arn:credential-provider' }),
      createWorkloadIdentity: jest.fn().mockResolvedValue({ workloadIdentityArn: 'arn:workload-identity' }),
    },
    walletStore: {
      save: jest.fn().mockResolvedValue(undefined),
      get: walletStore?.get ?? jest.fn().mockResolvedValue(null),
    },
  };
}

// --- Arbitraries ---

/**
 * Generates positive USDC balance values as strings.
 * Covers integers, 1-6 decimal places, and various magnitudes.
 */
const positiveUsdcBalance = fc.oneof(
  // Integers
  fc.integer({ min: 0, max: 999999999 }).map(n => n.toString()),
  // Numbers with 1-6 decimal places
  fc.tuple(
    fc.integer({ min: 0, max: 999999999 }),
    fc.integer({ min: 1, max: 6 })
  ).map(([whole, decimals]) => {
    const frac = fc.sample(fc.integer({ min: 1, max: Math.pow(10, decimals) - 1 }), 1)[0];
    return `${whole}.${frac.toString().padStart(decimals, '0')}`;
  }),
  // Simple decimals with various places
  fc.double({ min: 0, max: 999999999, noNaN: true, noDefaultInfinity: true })
    .filter(n => n >= 0 && isFinite(n))
    .map(n => n.toString())
);

/**
 * Generates valid positive USDC amounts with up to 6 decimal places.
 */
const positiveUsdcAmount = fc.tuple(
  fc.integer({ min: 0, max: 999999 }),
  fc.integer({ min: 0, max: 999999 })
).map(([whole, frac]) => {
  if (frac === 0) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}).filter(s => parseFloat(s) >= 0);

/**
 * Generates random agent IDs that are non-empty strings.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 50 }
);

// --- Property Tests ---

describe('Property 3: Balance Display Precision', () => {
  /**
   * **Validates: Requirements 2.6**
   *
   * For any valid USDC balance value (positive numbers, various decimal places),
   * formatBalanceForDisplay SHALL return a string with exactly 2 decimal places
   * (matches regex /^\d+\.\d{2}$/).
   */
  it('should always format balance to exactly 2 decimal places', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 999999999.999999, noNaN: true, noDefaultInfinity: true }),
        (balance) => {
          const balanceStr = balance.toString();
          const result = formatBalanceForDisplay(balanceStr);

          // Must match exactly: digits, dot, exactly 2 digits
          expect(result).toMatch(/^\d+\.\d{2}$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should format integer balance strings to exactly 2 decimal places', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        (balance) => {
          const result = formatBalanceForDisplay(balance.toString());
          expect(result).toMatch(/^\d+\.\d{2}$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should format balances with various decimal places to exactly 2', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999 }),
        fc.integer({ min: 0, max: 999999 }),
        (whole, frac) => {
          // Create a balance string with up to 6 decimal places
          const fracStr = frac.toString().padStart(6, '0');
          const balanceStr = `${whole}.${fracStr}`;
          const result = formatBalanceForDisplay(balanceStr);

          expect(result).toMatch(/^\d+\.\d{2}$/);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Non-Existent Wallet Error', () => {
  /**
   * **Validates: Requirements 2.8**
   *
   * For any agent ID that is NOT in the wallet store,
   * getBalance SHALL throw a WalletNotFoundError containing that agent ID.
   */
  it('should throw WalletNotFoundError for any agent ID not in the wallet store', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        async (unknownAgentId) => {
          // Create a wallet manager with an empty store (always returns null)
          const deps = createMockDeps({
            get: jest.fn().mockResolvedValue(null),
          });
          const config = createConfig();
          const manager = new DefaultWalletManager(config, deps);

          try {
            await manager.getBalance(unknownAgentId);
            // Should never reach here
            throw new Error('Expected WalletNotFoundError to be thrown');
          } catch (error) {
            expect(error).toBeInstanceOf(WalletNotFoundError);
            expect((error as WalletNotFoundError).agentId).toBe(unknownAgentId);
            expect((error as WalletNotFoundError).message).toContain(unknownAgentId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should include the agent ID in the error message for any non-existent agent', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        async (unknownAgentId) => {
          const deps = createMockDeps({
            get: jest.fn().mockResolvedValue(null),
          });
          const config = createConfig();
          const manager = new DefaultWalletManager(config, deps);

          await expect(manager.getBalance(unknownAgentId)).rejects.toThrow(
            WalletNotFoundError
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 8: Income Precision Preservation', () => {
  /**
   * **Validates: Requirements 4.1**
   *
   * For any valid USDC amount (positive numbers with up to 6 decimal places),
   * formatAmountWithPrecision(amount, 6) SHALL return a string with exactly 6 decimal places.
   */
  it('should always format amounts to exactly 6 decimal places', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 999999999.999999, noNaN: true, noDefaultInfinity: true }),
        (amount) => {
          const amountStr = amount.toString();
          const result = formatAmountWithPrecision(amountStr, 6);

          // Must match exactly: digits, dot, exactly 6 digits
          expect(result).toMatch(/^\d+\.\d{6}$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should format integer amounts to exactly 6 decimal places', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999999 }),
        (amount) => {
          const result = formatAmountWithPrecision(amount.toString(), 6);
          expect(result).toMatch(/^\d+\.\d{6}$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should preserve precision for amounts with various decimal places', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999999 }),
        fc.integer({ min: 0, max: 999999 }),
        (whole, frac) => {
          const fracStr = frac.toString().padStart(6, '0');
          const amountStr = `${whole}.${fracStr}`;
          const result = formatAmountWithPrecision(amountStr, 6);

          expect(result).toMatch(/^\d+\.\d{6}$/);
        }
      ),
      { numRuns: 100 }
    );
  });
});
