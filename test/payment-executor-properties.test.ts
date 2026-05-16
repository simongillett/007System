/**
 * Property-based tests for Payment Executor.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 5: Payment Requirements Extraction
 * - Property 6: Payment Eligibility Validation
 * - Property 7: Replay Failure Error Completeness
 */

import fc from 'fast-check';
import {
  DefaultPaymentExecutor,
  OnChainClient,
  HttpClient,
  ReplayError,
  PaymentExecutorDependencies,
} from '../lib/payment/payment-executor';
import {
  PaymentRequirements,
  PaymentRequest,
  HttpResponse,
} from '../lib/types/payment';
import { SpendingPolicyEngine, PolicyEvaluation } from '../lib/types/spending-policy';
import { WalletManager, WalletBalance } from '../lib/types/wallet';

// --- Test Helpers ---

function createApprovedPolicyEngine(): SpendingPolicyEngine {
  return {
    evaluate: async (agentId: string, amount: string): Promise<PolicyEvaluation> => ({
      agentId,
      paymentAmount: amount,
      perTransactionLimit: '999999999.99',
      cumulativeSpent24h: '0.000000',
      cumulativeLimit: '999999999.99',
      approved: true,
    }),
    updatePolicy: async () => {},
    getCumulativeSpend: async () => '0.000000',
  };
}

function createWalletManagerWithBalance(balance: string): WalletManager {
  return {
    provisionWallet: async () => ({
      agentId: 'agent-1',
      walletId: 'wallet-1',
      address: '0xabc',
      network: 'base' as const,
      asset: 'USDC' as const,
      createdAt: new Date().toISOString(),
      workloadIdentityArn: 'arn:aws:identity:us-east-1:123:workload/agent-1',
      credentialProviderArn: 'arn:aws:identity:us-east-1:123:credential/agent-1',
    }),
    getBalance: async (agentId: string): Promise<WalletBalance> => ({
      agentId,
      walletId: 'wallet-1',
      balance,
      lastUpdated: new Date().toISOString(),
    }),
    creditWallet: async () => {},
    getCredentials: async () => ({ apiKeyId: 'key-1', apiKeySecret: 'secret-1' }),
  };
}

function createSuccessfulOnChainClient(txHash: string = '0xtxhash123'): OnChainClient {
  return {
    submitPayment: async () => ({ transactionHash: txHash }),
  };
}

function createSuccessfulHttpClient(): HttpClient {
  return {
    replayWithReceipt: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"data": "ok"}',
    }),
  };
}

function createDeps(overrides: Partial<PaymentExecutorDependencies> = {}): PaymentExecutorDependencies {
  return {
    spendingPolicyEngine: createApprovedPolicyEngine(),
    walletManager: createWalletManagerWithBalance('1000.00'),
    onChainClient: createSuccessfulOnChainClient(),
    httpClient: createSuccessfulHttpClient(),
    ...overrides,
  };
}

// --- Arbitraries ---

/**
 * Generates valid EVM-like addresses (hex strings starting with 0x).
 */
const evmAddress = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((hex) => `0x${hex}`);

/**
 * Generates valid USDC amount strings (positive, up to 2 decimal places).
 */
const usdcAmount = fc
  .integer({ min: 1, max: 1000000 }) // 0.01 to 10,000.00 in cents
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates valid payment IDs.
 */
const paymentId = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
    minLength: 1,
    maxLength: 30,
  })
  .map((s) => `pay-${s}`);

/**
 * Generates random agent IDs.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 50 }
);

/**
 * Generates valid HTTP method strings.
 */
const httpMethod = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH');

/**
 * Generates valid URL strings.
 */
const httpUrl = fc
  .tuple(
    fc.constantFrom('https://merchant-', 'https://api-', 'https://data-'),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 3,
      maxLength: 20,
    }),
    fc.constantFrom('.example.com/data', '.example.com/services', '.example.com/feed')
  )
  .map(([prefix, mid, suffix]) => `${prefix}${mid}${suffix}`);

/**
 * Generates non-empty header key-value pairs.
 */
const httpHeaders = fc.dictionary(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-'.split('')), {
    minLength: 1,
    maxLength: 20,
  }),
  fc.string({ minLength: 1, maxLength: 50 }),
  { minKeys: 0, maxKeys: 5 }
);

/**
 * Generates optional body strings.
 */
const optionalBody = fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined });

/**
 * Generates a complete original request object.
 */
const originalRequest = fc.tuple(httpMethod, httpUrl, httpHeaders, optionalBody).map(
  ([method, url, headers, body]) => ({
    method,
    url,
    headers,
    ...(body !== undefined ? { body } : {}),
  })
);

/**
 * Generates replay failure reason strings.
 */
const replayFailureReason = fc.constantFrom(
  'Connection timeout',
  'Service unavailable',
  'Internal server error',
  'Gateway timeout',
  'Rate limited',
  'Invalid receipt format',
  'Endpoint not found'
);

/**
 * Generates transaction hash strings.
 */
const transactionHash = fc
  .hexaString({ minLength: 64, maxLength: 64 })
  .map((hex) => `0x${hex}`);

// --- Property Tests ---

describe('Property 5: Payment Requirements Extraction', () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For any HTTP 402 response:
   * - If all required headers (recipient, amount, asset) are present → extractRequirements returns them correctly
   * - If any required field is absent → validateRequirements returns the specific missing fields
   */
  it('should correctly extract all payment requirement fields when all headers are present', () => {
    fc.assert(
      fc.property(
        evmAddress,
        usdcAmount,
        paymentId,
        fc.option(fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()), { nil: undefined }),
        (recipient, amount, payId, expiresAt) => {
          const executor = new DefaultPaymentExecutor(createDeps());

          const headers: Record<string, string> = {
            'X-Payment-Recipient': recipient,
            'X-Payment-Amount': amount,
            'X-Payment-Asset': 'USDC',
            'X-Payment-Network': 'base',
            'X-Payment-Id': payId,
          };
          if (expiresAt !== undefined) {
            headers['X-Payment-Expires-At'] = expiresAt;
          }

          const response: HttpResponse = {
            statusCode: 402,
            headers,
          };

          const result = executor.extractRequirements(response);

          // Should extract all fields correctly
          expect(result).not.toBeNull();
          expect(result!.recipientAddress).toBe(recipient);
          expect(result!.amount).toBe(amount);
          expect(result!.asset).toBe('USDC');
          expect(result!.network).toBe('base');
          expect(result!.paymentId).toBe(payId);
          if (expiresAt !== undefined) {
            expect(result!.expiresAt).toBe(expiresAt);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should identify specific missing fields when required headers are absent', () => {
    // Generate subsets of required fields to omit
    const requiredFields = ['recipientAddress', 'amount', 'asset', 'network', 'paymentId'] as const;

    fc.assert(
      fc.property(
        evmAddress,
        usdcAmount,
        paymentId,
        // Generate a non-empty subset of fields to omit
        fc.subarray(
          ['recipientAddress', 'amount', 'paymentId'] as const,
          { minLength: 1, maxLength: 3 }
        ),
        (recipient, amount, payId, fieldsToOmit) => {
          const executor = new DefaultPaymentExecutor(createDeps());

          // Build headers, omitting selected fields
          const headers: Record<string, string> = {};

          if (!fieldsToOmit.includes('recipientAddress')) {
            headers['X-Payment-Recipient'] = recipient;
          }
          if (!fieldsToOmit.includes('amount')) {
            headers['X-Payment-Amount'] = amount;
          }
          // Always include asset and network so we get a non-null result from extractRequirements
          headers['X-Payment-Asset'] = 'USDC';
          headers['X-Payment-Network'] = 'base';
          if (!fieldsToOmit.includes('paymentId')) {
            headers['X-Payment-Id'] = payId;
          }

          // Need at least one payment header for extractRequirements to return non-null
          // We always have asset, so this is guaranteed

          const response: HttpResponse = {
            statusCode: 402,
            headers,
          };

          const extracted = executor.extractRequirements(response);

          // extractRequirements returns partial results with empty strings for missing fields
          // validateRequirements then identifies the missing fields
          if (extracted !== null) {
            const validation = executor.validateRequirements(extracted);

            expect(validation.valid).toBe(false);
            expect(validation.missingFields).toBeDefined();

            // Each omitted field should appear in missingFields
            for (const field of fieldsToOmit) {
              expect(validation.missingFields).toContain(field);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return null for any non-402 status code', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }).filter((code) => code !== 402),
        evmAddress,
        usdcAmount,
        (statusCode, recipient, amount) => {
          const executor = new DefaultPaymentExecutor(createDeps());

          const response: HttpResponse = {
            statusCode,
            headers: {
              'X-Payment-Recipient': recipient,
              'X-Payment-Amount': amount,
              'X-Payment-Asset': 'USDC',
              'X-Payment-Network': 'base',
              'X-Payment-Id': 'pay-001',
            },
          };

          const result = executor.extractRequirements(response);
          expect(result).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should handle case-insensitive header extraction for any casing', () => {
    fc.assert(
      fc.property(
        evmAddress,
        usdcAmount,
        paymentId,
        // Generate random casing for header keys
        fc.constantFrom(
          'x-payment-recipient',
          'X-Payment-Recipient',
          'X-PAYMENT-RECIPIENT',
          'x-Payment-Recipient'
        ),
        (recipient, amount, payId, headerCase) => {
          const executor = new DefaultPaymentExecutor(createDeps());

          const response: HttpResponse = {
            statusCode: 402,
            headers: {
              [headerCase]: recipient,
              'x-payment-amount': amount,
              'x-payment-asset': 'USDC',
              'x-payment-network': 'base',
              'x-payment-id': payId,
            },
          };

          const result = executor.extractRequirements(response);

          expect(result).not.toBeNull();
          expect(result!.recipientAddress).toBe(recipient);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 6: Payment Eligibility Validation', () => {
  /**
   * **Validates: Requirements 3.3, 3.4**
   *
   * For any payment amount A and wallet balance B:
   * - Payment approved iff B >= A AND A <= 10 USDC
   * - If B < A → error code is INSUFFICIENT_BALANCE
   * - If A > 10 → error code is EXCEEDS_TRANSACTION_LIMIT
   */
  it('should approve payment iff balance >= amount AND amount <= 10 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Generate amount in range [0.01, 20.00] to test both sides of the 10 USDC cap
        fc.integer({ min: 1, max: 2000 }).map((cents) => (cents / 100).toFixed(2)),
        // Generate balance in range [0.01, 50.00]
        fc.integer({ min: 1, max: 5000 }).map((cents) => (cents / 100).toFixed(2)),
        async (agentIdVal, amountStr, balanceStr) => {
          const amount = parseFloat(amountStr);
          const balance = parseFloat(balanceStr);

          const deps = createDeps({
            walletManager: createWalletManagerWithBalance(balanceStr),
          });
          const executor = new DefaultPaymentExecutor(deps);

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: 'https://merchant.example.com/data',
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: amountStr,
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-test-001',
            },
            originalRequest: {
              method: 'GET',
              url: 'https://merchant.example.com/data',
              headers: { 'content-type': 'application/json' },
            },
          };

          const result = await executor.executePayment(request);

          const shouldApprove = balance >= amount && amount <= 10;

          if (shouldApprove) {
            // Payment should be settled (approved and executed)
            expect(result.status).toBe('settled');
          } else {
            // Payment should be rejected
            expect(result.status).toBe('rejected');
            expect(result.error).toBeDefined();

            // The implementation checks balance before the 10 USDC cap,
            // so when both conditions fail, INSUFFICIENT_BALANCE takes priority.
            if (balance < amount) {
              expect(result.error!.code).toBe('INSUFFICIENT_BALANCE');
            } else if (amount > 10) {
              expect(result.error!.code).toBe('EXCEEDS_TRANSACTION_LIMIT');
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always reject with EXCEEDS_TRANSACTION_LIMIT when amount > 10 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Generate amounts strictly greater than 10 USDC
        fc.integer({ min: 1001, max: 100000 }).map((cents) => (cents / 100).toFixed(2)),
        // Generate large balances so balance is never the issue
        fc.integer({ min: 100001, max: 1000000 }).map((cents) => (cents / 100).toFixed(2)),
        async (agentIdVal, amountStr, balanceStr) => {
          const deps = createDeps({
            walletManager: createWalletManagerWithBalance(balanceStr),
          });
          const executor = new DefaultPaymentExecutor(deps);

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: 'https://merchant.example.com/data',
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: amountStr,
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-test-002',
            },
            originalRequest: {
              method: 'GET',
              url: 'https://merchant.example.com/data',
              headers: {},
            },
          };

          const result = await executor.executePayment(request);

          expect(result.status).toBe('rejected');
          expect(result.error!.code).toBe('EXCEEDS_TRANSACTION_LIMIT');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always reject with INSUFFICIENT_BALANCE when balance < amount and amount <= 10', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Generate amount in [0.02, 10.00] so we can always have a balance strictly less
        fc.integer({ min: 2, max: 1000 }).chain((amountCents) =>
          fc.tuple(
            fc.constant((amountCents / 100).toFixed(2)),
            // Balance strictly less than amount (at least 0.01 less)
            fc.integer({ min: 1, max: amountCents - 1 }).map((c) => (c / 100).toFixed(2))
          )
        ),
        async (agentIdVal, [amountStr, balanceStr]) => {
          const deps = createDeps({
            walletManager: createWalletManagerWithBalance(balanceStr),
          });
          const executor = new DefaultPaymentExecutor(deps);

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: 'https://merchant.example.com/data',
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: amountStr,
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-test-003',
            },
            originalRequest: {
              method: 'GET',
              url: 'https://merchant.example.com/data',
              headers: {},
            },
          };

          const result = await executor.executePayment(request);

          expect(result.status).toBe('rejected');
          expect(result.error!.code).toBe('INSUFFICIENT_BALANCE');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should approve exactly 10 USDC when balance is sufficient (boundary)', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Balance >= 10 USDC
        fc.integer({ min: 1000, max: 100000 }).map((cents) => (cents / 100).toFixed(2)),
        async (agentIdVal, balanceStr) => {
          const deps = createDeps({
            walletManager: createWalletManagerWithBalance(balanceStr),
          });
          const executor = new DefaultPaymentExecutor(deps);

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: 'https://merchant.example.com/data',
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: '10.00',
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-test-boundary',
            },
            originalRequest: {
              method: 'GET',
              url: 'https://merchant.example.com/data',
              headers: {},
            },
          };

          const result = await executor.executePayment(request);

          expect(result.status).toBe('settled');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 7: Replay Failure Error Completeness', () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * For any replay failure occurring after a successful on-chain payment:
   * - Error contains the transaction hash
   * - Error contains the replay failure reason
   * - Error contains the complete original request details
   */
  it('should include transaction hash, failure reason, and original request in replay failure error', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        transactionHash,
        replayFailureReason,
        originalRequest,
        // Amount within valid range (0.01 to 10.00)
        fc.integer({ min: 1, max: 1000 }).map((cents) => (cents / 100).toFixed(2)),
        async (agentIdVal, txHash, failureReason, origRequest, amountStr) => {
          const deps = createDeps({
            onChainClient: {
              submitPayment: async () => ({ transactionHash: txHash }),
            },
            httpClient: {
              replayWithReceipt: async () => {
                throw new ReplayError(failureReason);
              },
            },
          });
          const executor = new DefaultPaymentExecutor(deps);

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: 'https://merchant.example.com/data',
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: amountStr,
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-replay-test',
            },
            originalRequest: origRequest,
          };

          const result = await executor.executePayment(request);

          // Should be a failed status (not rejected — payment went through on-chain)
          expect(result.status).toBe('failed');
          expect(result.error).toBeDefined();
          expect(result.error!.code).toBe('REPLAY_FAILED');

          // Must contain the transaction hash
          expect(result.error!.transactionHash).toBe(txHash);
          expect(result.transactionHash).toBe(txHash);

          // Must contain the replay failure reason in the message
          expect(result.error!.message).toContain(failureReason);

          // Must contain the complete original request details
          expect(result.error!.originalRequest).toBeDefined();
          expect(result.error!.originalRequest!.method).toBe(origRequest.method);
          expect(result.error!.originalRequest!.url).toBe(origRequest.url);
          expect(result.error!.originalRequest!.headers).toEqual(origRequest.headers);
          if (origRequest.body !== undefined) {
            expect(result.error!.originalRequest!.body).toBe(origRequest.body);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should preserve all original request fields regardless of request complexity', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        transactionHash,
        replayFailureReason,
        httpMethod,
        httpUrl,
        // Generate more complex headers
        fc.dictionary(
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-'.split('')), {
            minLength: 1,
            maxLength: 15,
          }),
          fc.string({ minLength: 1, maxLength: 100 }),
          { minKeys: 1, maxKeys: 10 }
        ),
        fc.option(fc.json(), { nil: undefined }),
        fc.integer({ min: 1, max: 1000 }).map((cents) => (cents / 100).toFixed(2)),
        async (agentIdVal, txHash, failureReason, method, url, headers, body, amountStr) => {
          const deps = createDeps({
            onChainClient: {
              submitPayment: async () => ({ transactionHash: txHash }),
            },
            httpClient: {
              replayWithReceipt: async () => {
                throw new ReplayError(failureReason);
              },
            },
          });
          const executor = new DefaultPaymentExecutor(deps);

          const origRequest = {
            method,
            url,
            headers,
            ...(body !== undefined ? { body } : {}),
          };

          const request: PaymentRequest = {
            requestingAgentId: agentIdVal,
            merchantEndpointUrl: url,
            paymentRequirements: {
              recipientAddress: '0xrecipient456abc789def012345678901234567890a',
              amount: amountStr,
              asset: 'USDC',
              network: 'base',
              paymentId: 'pay-replay-complex',
            },
            originalRequest: origRequest,
          };

          const result = await executor.executePayment(request);

          expect(result.status).toBe('failed');
          expect(result.error!.code).toBe('REPLAY_FAILED');

          // The original request in the error must be the exact same object
          expect(result.error!.originalRequest).toEqual(origRequest);
        }
      ),
      { numRuns: 100 }
    );
  });
});
