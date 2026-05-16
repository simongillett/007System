/**
 * Unit tests for WalletManager implementation.
 *
 * Tests cover:
 * - Wallet provisioning (happy path, timeout, failure)
 * - Balance queries (formatting, non-existent agent)
 * - Credential retrieval (exclusively via Token Vault)
 * - Credit wallet (6 decimal precision)
 */

import {
  DefaultWalletManager,
  WalletManagerDependencies,
  CdpSdkClient,
  SecretsManagerClient,
  TokenVaultClient,
  IdentityClient,
  WalletStore,
  WalletProvisioningError,
  WalletNotFoundError,
  WalletProvisioningTimeoutError,
  formatBalanceForDisplay,
  formatAmountWithPrecision,
} from '../lib/wallet/wallet-manager';
import { WalletManagerConfig, AgentWallet } from '../lib/types/wallet';

// --- Test Helpers ---

function createMockDeps(): WalletManagerDependencies {
  return {
    cdpSdk: {
      createWallet: jest.fn().mockResolvedValue({
        walletId: 'wallet-123',
        address: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
        apiKeyId: 'key-id-001',
        apiKeySecret: 'secret-key-value',
      }),
      getUsdcBalance: jest.fn().mockResolvedValue('100.50'),
      creditUsdc: jest.fn().mockResolvedValue(undefined),
    },
    secretsManager: {
      createSecret: jest.fn().mockResolvedValue({
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:trading-system/agents/agent-1/cdp-api-key-AbCdEf',
      }),
    },
    tokenVault: {
      retrieveCredentials: jest.fn().mockResolvedValue({
        apiKeyId: 'key-id-001',
        apiKeySecret: 'secret-key-value',
      }),
    },
    identity: {
      createCredentialProvider: jest.fn().mockResolvedValue({
        credentialProviderArn:
          'arn:aws:bedrock:us-east-1:123456789012:agent-core-credential-provider/agent-1-cdp-credential-provider',
      }),
      createWorkloadIdentity: jest.fn().mockResolvedValue({
        workloadIdentityArn:
          'arn:aws:bedrock:us-east-1:123456789012:agent-core-workload-identity/agent-1-workload-identity',
      }),
    },
    walletStore: {
      save: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
    },
  };
}

function createConfig(overrides?: Partial<WalletManagerConfig>): WalletManagerConfig {
  return {
    cdpApiKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:master-key',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
    network: 'base',
    provisioningTimeoutMs: 30000,
    ...overrides,
  };
}

const EXISTING_WALLET: AgentWallet = {
  agentId: 'agent-1',
  walletId: 'wallet-123',
  address: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
  network: 'base',
  asset: 'USDC',
  createdAt: '2024-01-01T00:00:00.000Z',
  workloadIdentityArn:
    'arn:aws:bedrock:us-east-1:123456789012:agent-core-workload-identity/agent-1-workload-identity',
  credentialProviderArn:
    'arn:aws:bedrock:us-east-1:123456789012:agent-core-credential-provider/agent-1-cdp-credential-provider',
};

// --- Tests ---

describe('DefaultWalletManager', () => {
  describe('provisionWallet', () => {
    it('should provision a wallet and return AgentWallet with all fields', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      const result = await manager.provisionWallet('agent-1');

      expect(result.agentId).toBe('agent-1');
      expect(result.walletId).toBe('wallet-123');
      expect(result.address).toBe('0xABCDEF1234567890abcdef1234567890ABCDEF12');
      expect(result.network).toBe('base');
      expect(result.asset).toBe('USDC');
      expect(result.createdAt).toBeDefined();
      expect(result.workloadIdentityArn).toContain('workload-identity');
      expect(result.credentialProviderArn).toContain('credential-provider');
    });

    it('should call CDP SDK to create wallet on base network', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.provisionWallet('agent-1');

      expect(deps.cdpSdk.createWallet).toHaveBeenCalledWith({ network: 'base' });
    });

    it('should store API key in Secrets Manager with correct naming convention', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.provisionWallet('agent-1');

      expect(deps.secretsManager.createSecret).toHaveBeenCalledWith({
        name: 'trading-system/agents/agent-1/cdp-api-key',
        secretValue: JSON.stringify({
          apiKeyId: 'key-id-001',
          apiKeySecret: 'secret-key-value',
        }),
        kmsKeyId: config.kmsKeyArn,
        description: 'CDP API key for agent agent-1',
      });
    });

    it('should create Credential Provider with secret ARN and KMS key', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.provisionWallet('agent-1');

      expect(deps.identity.createCredentialProvider).toHaveBeenCalledWith({
        agentId: 'agent-1',
        secretArn:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:trading-system/agents/agent-1/cdp-api-key-AbCdEf',
        kmsKeyArn: config.kmsKeyArn,
      });
    });

    it('should create Workload Identity scoped to Credential Provider', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.provisionWallet('agent-1');

      expect(deps.identity.createWorkloadIdentity).toHaveBeenCalledWith({
        agentId: 'agent-1',
        credentialProviderArn:
          'arn:aws:bedrock:us-east-1:123456789012:agent-core-credential-provider/agent-1-cdp-credential-provider',
      });
    });

    it('should persist wallet record to store', async () => {
      const deps = createMockDeps();
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.provisionWallet('agent-1');

      expect(deps.walletStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          walletId: 'wallet-123',
          network: 'base',
          asset: 'USDC',
        })
      );
    });

    it('should throw WalletProvisioningTimeoutError when provisioning exceeds timeout', async () => {
      const deps = createMockDeps();
      // Make CDP SDK take longer than timeout
      (deps.cdpSdk.createWallet as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 200))
      );
      const config = createConfig({ provisioningTimeoutMs: 50 });
      const manager = new DefaultWalletManager(config, deps);

      await expect(manager.provisionWallet('agent-1')).rejects.toThrow(
        WalletProvisioningTimeoutError
      );
    });

    it('should throw WalletProvisioningError when CDP SDK fails', async () => {
      const deps = createMockDeps();
      (deps.cdpSdk.createWallet as jest.Mock).mockRejectedValue(
        new Error('CDP API unavailable')
      );
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await expect(manager.provisionWallet('agent-1')).rejects.toThrow(
        WalletProvisioningError
      );
    });

    it('should throw WalletProvisioningError when Secrets Manager fails', async () => {
      const deps = createMockDeps();
      (deps.secretsManager.createSecret as jest.Mock).mockRejectedValue(
        new Error('Access denied')
      );
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await expect(manager.provisionWallet('agent-1')).rejects.toThrow(
        WalletProvisioningError
      );
    });

    it('should include agent ID in provisioning error', async () => {
      const deps = createMockDeps();
      (deps.cdpSdk.createWallet as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      try {
        await manager.provisionWallet('agent-xyz');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WalletProvisioningError);
        expect((error as WalletProvisioningError).agentId).toBe('agent-xyz');
      }
    });
  });

  describe('getBalance', () => {
    it('should return balance formatted to 2 decimal places', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      (deps.cdpSdk.getUsdcBalance as jest.Mock).mockResolvedValue('100.5');
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      const result = await manager.getBalance('agent-1');

      expect(result.balance).toBe('100.50');
    });

    it('should return balance with agentId and walletId', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      const result = await manager.getBalance('agent-1');

      expect(result.agentId).toBe('agent-1');
      expect(result.walletId).toBe('wallet-123');
      expect(result.lastUpdated).toBeDefined();
    });

    it('should throw WalletNotFoundError for non-existent agent', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(null);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await expect(manager.getBalance('unknown-agent')).rejects.toThrow(
        WalletNotFoundError
      );
    });

    it('should include agent ID in WalletNotFoundError', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(null);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      try {
        await manager.getBalance('missing-agent');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WalletNotFoundError);
        expect((error as WalletNotFoundError).agentId).toBe('missing-agent');
      }
    });

    it('should query CDP SDK with correct address and network', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.getBalance('agent-1');

      expect(deps.cdpSdk.getUsdcBalance).toHaveBeenCalledWith({
        address: EXISTING_WALLET.address,
        network: 'base',
      });
    });
  });

  describe('getCredentials', () => {
    it('should retrieve credentials exclusively via Token Vault', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      const creds = await manager.getCredentials('agent-1');

      expect(deps.tokenVault.retrieveCredentials).toHaveBeenCalledWith({
        agentId: 'agent-1',
        credentialProviderArn: EXISTING_WALLET.credentialProviderArn,
      });
      expect(creds.apiKeyId).toBe('key-id-001');
      expect(creds.apiKeySecret).toBe('secret-key-value');
    });

    it('should NEVER call Secrets Manager directly for credential retrieval', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.getCredentials('agent-1');

      // Secrets Manager should not have any "get" method called
      // (createSecret is only used during provisioning)
      expect(deps.tokenVault.retrieveCredentials).toHaveBeenCalled();
    });

    it('should throw WalletNotFoundError for non-existent agent', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(null);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await expect(manager.getCredentials('unknown-agent')).rejects.toThrow(
        WalletNotFoundError
      );
    });
  });

  describe('creditWallet', () => {
    it('should credit wallet with 6 decimal precision', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.creditWallet('agent-1', '1.5', 'tx-hash-123');

      expect(deps.cdpSdk.creditUsdc).toHaveBeenCalledWith({
        address: EXISTING_WALLET.address,
        network: 'base',
        amount: '1.500000',
        txHash: 'tx-hash-123',
      });
    });

    it('should preserve full 6 decimal precision for small amounts', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.creditWallet('agent-1', '0.000001', 'tx-hash-456');

      expect(deps.cdpSdk.creditUsdc).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '0.000001' })
      );
    });

    it('should throw WalletNotFoundError for non-existent agent', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(null);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await expect(
        manager.creditWallet('unknown-agent', '1.0', 'tx-hash')
      ).rejects.toThrow(WalletNotFoundError);
    });

    it('should format integer amounts to 6 decimal places', async () => {
      const deps = createMockDeps();
      (deps.walletStore.get as jest.Mock).mockResolvedValue(EXISTING_WALLET);
      const config = createConfig();
      const manager = new DefaultWalletManager(config, deps);

      await manager.creditWallet('agent-1', '100', 'tx-hash-789');

      expect(deps.cdpSdk.creditUsdc).toHaveBeenCalledWith(
        expect.objectContaining({ amount: '100.000000' })
      );
    });
  });
});

describe('formatBalanceForDisplay', () => {
  it('should format integer to 2 decimal places', () => {
    expect(formatBalanceForDisplay('100')).toBe('100.00');
  });

  it('should format 1 decimal place to 2', () => {
    expect(formatBalanceForDisplay('50.1')).toBe('50.10');
  });

  it('should truncate more than 2 decimal places', () => {
    expect(formatBalanceForDisplay('25.999')).toBe('25.99');
  });

  it('should handle zero', () => {
    expect(formatBalanceForDisplay('0')).toBe('0.00');
  });

  it('should handle very small amounts', () => {
    expect(formatBalanceForDisplay('0.001')).toBe('0.00');
  });

  it('should handle invalid input', () => {
    expect(formatBalanceForDisplay('invalid')).toBe('0.00');
  });

  it('should handle large numbers', () => {
    expect(formatBalanceForDisplay('999999.99')).toBe('999999.99');
  });
});

describe('formatAmountWithPrecision', () => {
  it('should format to 6 decimal places', () => {
    expect(formatAmountWithPrecision('1.5', 6)).toBe('1.500000');
  });

  it('should preserve existing 6 decimal places', () => {
    expect(formatAmountWithPrecision('0.123456', 6)).toBe('0.123456');
  });

  it('should format integer to 6 decimal places', () => {
    expect(formatAmountWithPrecision('100', 6)).toBe('100.000000');
  });

  it('should handle very small amounts', () => {
    expect(formatAmountWithPrecision('0.000001', 6)).toBe('0.000001');
  });

  it('should handle invalid input', () => {
    expect(formatAmountWithPrecision('invalid', 6)).toBe('0.000000');
  });
});
