/**
 * Unit tests for Payment Executor implementation.
 *
 * Tests the full x402 payment cycle including:
 * - extractRequirements: parsing 402 response headers
 * - validateRequirements: checking required fields
 * - executePayment: full cycle with all error cases
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

import {
  DefaultPaymentExecutor,
  OnChainClient,
  HttpClient,
  OnChainTransactionError,
  ReplayError,
  PaymentExecutorDependencies,
} from '../lib/payment/payment-executor';
import {
  PaymentRequest,
  PaymentRequirements,
  HttpResponse,
} from '../lib/types/payment';
import { SpendingPolicyEngine, PolicyEvaluation } from '../lib/types/spending-policy';
import { WalletManager, WalletBalance } from '../lib/types/wallet';

// --- Mock Factories ---

function createMockSpendingPolicyEngine(
  overrides: Partial<SpendingPolicyEngine> = {}
): SpendingPolicyEngine {
  return {
    evaluate: jest.fn().mockResolvedValue({
      agentId: 'agent-1',
      paymentAmount: '1.00',
      perTransactionLimit: '10.00',
      cumulativeSpent24h: '0.000000',
      cumulativeLimit: '100.00',
      approved: true,
    } as PolicyEvaluation),
    updatePolicy: jest.fn().mockResolvedValue(undefined),
    getCumulativeSpend: jest.fn().mockResolvedValue('0.000000'),
    ...overrides,
  };
}

function createMockWalletManager(
  overrides: Partial<WalletManager> = {}
): WalletManager {
  return {
    provisionWallet: jest.fn().mockResolvedValue({
      agentId: 'agent-1',
      walletId: 'wallet-1',
      address: '0xabc123',
      network: 'base',
      asset: 'USDC',
      createdAt: '2024-01-01T00:00:00.000Z',
      workloadIdentityArn: 'arn:aws:identity:us-east-1:123456789:workload/agent-1',
      credentialProviderArn: 'arn:aws:identity:us-east-1:123456789:credential/agent-1',
    }),
    getBalance: jest.fn().mockResolvedValue({
      agentId: 'agent-1',
      walletId: 'wallet-1',
      balance: '50.00',
      lastUpdated: '2024-01-01T00:00:00.000Z',
    } as WalletBalance),
    creditWallet: jest.fn().mockResolvedValue(undefined),
    getCredentials: jest.fn().mockResolvedValue({
      apiKeyId: 'key-1',
      apiKeySecret: 'secret-1',
    }),
    ...overrides,
  };
}

function createMockOnChainClient(
  overrides: Partial<OnChainClient> = {}
): OnChainClient {
  return {
    submitPayment: jest.fn().mockResolvedValue({
      transactionHash: '0xtxhash123',
    }),
    ...overrides,
  };
}

function createMockHttpClient(
  overrides: Partial<HttpClient> = {}
): HttpClient {
  return {
    replayWithReceipt: jest.fn().mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"data": "market-feed"}',
    }),
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<PaymentExecutorDependencies> = {}
): PaymentExecutorDependencies {
  return {
    spendingPolicyEngine: createMockSpendingPolicyEngine(),
    walletManager: createMockWalletManager(),
    onChainClient: createMockOnChainClient(),
    httpClient: createMockHttpClient(),
    ...overrides,
  };
}

function createValidPaymentRequest(
  overrides: Partial<PaymentRequest> = {}
): PaymentRequest {
  return {
    requestingAgentId: 'agent-1',
    merchantEndpointUrl: 'https://merchant.example.com/data/market-feed',
    paymentRequirements: {
      recipientAddress: '0xrecipient456',
      amount: '1.50',
      asset: 'USDC',
      network: 'base',
      paymentId: 'pay-001',
    },
    originalRequest: {
      method: 'GET',
      url: 'https://merchant.example.com/data/market-feed',
      headers: { 'content-type': 'application/json' },
    },
    ...overrides,
  };
}

// --- Tests ---

describe('DefaultPaymentExecutor', () => {
  describe('extractRequirements', () => {
    it('should extract payment requirements from 402 response headers', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const response: HttpResponse = {
        statusCode: 402,
        headers: {
          'X-Payment-Recipient': '0xrecipient456',
          'X-Payment-Amount': '2.50',
          'X-Payment-Asset': 'USDC',
          'X-Payment-Network': 'base',
          'X-Payment-Id': 'pay-001',
          'X-Payment-Expires-At': '2024-12-31T23:59:59.000Z',
        },
      };

      const result = executor.extractRequirements(response);

      expect(result).toEqual({
        recipientAddress: '0xrecipient456',
        amount: '2.50',
        asset: 'USDC',
        network: 'base',
        paymentId: 'pay-001',
        expiresAt: '2024-12-31T23:59:59.000Z',
      });
    });

    it('should handle case-insensitive headers', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const response: HttpResponse = {
        statusCode: 402,
        headers: {
          'x-payment-recipient': '0xaddr',
          'x-payment-amount': '1.00',
          'x-payment-asset': 'USDC',
          'x-payment-network': 'base',
          'x-payment-id': 'pay-002',
        },
      };

      const result = executor.extractRequirements(response);

      expect(result).not.toBeNull();
      expect(result!.recipientAddress).toBe('0xaddr');
      expect(result!.amount).toBe('1.00');
    });

    it('should return null for non-402 responses', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const response: HttpResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      };

      const result = executor.extractRequirements(response);

      expect(result).toBeNull();
    });

    it('should return null when no payment headers are present in 402', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const response: HttpResponse = {
        statusCode: 402,
        headers: { 'content-type': 'text/plain' },
      };

      const result = executor.extractRequirements(response);

      expect(result).toBeNull();
    });

    it('should return partial requirements with empty strings for missing fields', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const response: HttpResponse = {
        statusCode: 402,
        headers: {
          'x-payment-recipient': '0xaddr',
          'x-payment-id': 'pay-003',
          // amount and asset missing
        },
      };

      const result = executor.extractRequirements(response);

      expect(result).not.toBeNull();
      expect(result!.recipientAddress).toBe('0xaddr');
      expect(result!.amount).toBe('');
      expect(result!.paymentId).toBe('pay-003');
    });
  });

  describe('validateRequirements', () => {
    it('should return valid for complete requirements', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const requirements: PaymentRequirements = {
        recipientAddress: '0xrecipient456',
        amount: '1.50',
        asset: 'USDC',
        network: 'base',
        paymentId: 'pay-001',
      };

      const result = executor.validateRequirements(requirements);

      expect(result).toEqual({ valid: true });
    });

    it('should return missing fields when recipientAddress is empty', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const requirements: PaymentRequirements = {
        recipientAddress: '',
        amount: '1.50',
        asset: 'USDC',
        network: 'base',
        paymentId: 'pay-001',
      };

      const result = executor.validateRequirements(requirements);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain('recipientAddress');
    });

    it('should return all missing fields', () => {
      const executor = new DefaultPaymentExecutor(createDeps());
      const requirements: PaymentRequirements = {
        recipientAddress: '',
        amount: '',
        asset: '' as 'USDC',
        network: '' as 'base',
        paymentId: '',
      };

      const result = executor.validateRequirements(requirements);

      expect(result.valid).toBe(false);
      expect(result.missingFields).toHaveLength(5);
      expect(result.missingFields).toContain('recipientAddress');
      expect(result.missingFields).toContain('amount');
      expect(result.missingFields).toContain('asset');
      expect(result.missingFields).toContain('network');
      expect(result.missingFields).toContain('paymentId');
    });
  });

  describe('executePayment', () => {
    it('should complete full payment cycle successfully', async () => {
      const deps = createDeps();
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('settled');
      expect(result.transactionHash).toBe('0xtxhash123');
      expect(result.replayResponse).toEqual({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"data": "market-feed"}',
      });
      expect(result.error).toBeUndefined();
    });

    it('should reject with MISSING_FIELDS when requirements are incomplete', async () => {
      const deps = createDeps();
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '',
          amount: '1.50',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('MISSING_FIELDS');
      expect(result.error!.message).toContain('recipientAddress');
    });

    it('should reject with NO_SPENDING_POLICY when no policy exists', async () => {
      const deps = createDeps({
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            paymentAmount: '1.50',
            perTransactionLimit: '0',
            cumulativeSpent24h: '0',
            cumulativeLimit: '0',
            approved: false,
            rejectionReason: 'NO_POLICY',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('NO_SPENDING_POLICY');
      expect(result.error!.message).toContain('No spending policy configured');
    });

    it('should reject with EXCEEDS_TRANSACTION_LIMIT when policy per-tx limit exceeded', async () => {
      const deps = createDeps({
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            paymentAmount: '5.00',
            perTransactionLimit: '2.00',
            cumulativeSpent24h: '0.000000',
            cumulativeLimit: '100.00',
            approved: false,
            rejectionReason: 'PER_TRANSACTION_EXCEEDED',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '5.00',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('EXCEEDS_TRANSACTION_LIMIT');
    });

    it('should reject with EXCEEDS_CUMULATIVE_LIMIT when 24h cumulative limit exceeded', async () => {
      const deps = createDeps({
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            paymentAmount: '5.00',
            perTransactionLimit: '10.00',
            cumulativeSpent24h: '98.000000',
            cumulativeLimit: '100.00',
            approved: false,
            rejectionReason: 'CUMULATIVE_EXCEEDED',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '5.00',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('EXCEEDS_CUMULATIVE_LIMIT');
    });

    it('should reject with INSUFFICIENT_BALANCE when wallet balance is too low', async () => {
      const deps = createDeps({
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            walletId: 'wallet-1',
            balance: '0.50',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '1.50',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.error!.message).toContain('Insufficient USDC balance');
    });

    it('should reject with EXCEEDS_TRANSACTION_LIMIT when amount exceeds 10 USDC cap', async () => {
      const deps = createDeps({
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            walletId: 'wallet-1',
            balance: '100.00',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          }),
        }),
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            paymentAmount: '15.00',
            perTransactionLimit: '20.00',
            cumulativeSpent24h: '0.000000',
            cumulativeLimit: '100.00',
            approved: true,
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '15.00',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('EXCEEDS_TRANSACTION_LIMIT');
      expect(result.error!.message).toContain('10 USDC per-transaction cap');
    });

    it('should return ON_CHAIN_FAILURE when on-chain transaction fails', async () => {
      const deps = createDeps({
        onChainClient: {
          submitPayment: jest.fn().mockRejectedValue(
            new OnChainTransactionError('gas estimation failed', '0xfailedtx')
          ),
        },
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('failed');
      expect(result.error!.code).toBe('ON_CHAIN_FAILURE');
      expect(result.error!.transactionHash).toBe('0xfailedtx');
      expect(result.error!.message).toContain('gas estimation failed');
    });

    it('should return REPLAY_FAILED with tx hash and original request when replay fails', async () => {
      const deps = createDeps({
        httpClient: {
          replayWithReceipt: jest.fn().mockRejectedValue(
            new ReplayError('Connection timeout')
          ),
        },
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('failed');
      expect(result.error!.code).toBe('REPLAY_FAILED');
      expect(result.error!.transactionHash).toBe('0xtxhash123');
      expect(result.error!.originalRequest).toEqual({
        method: 'GET',
        url: 'https://merchant.example.com/data/market-feed',
        headers: { 'content-type': 'application/json' },
      });
      expect(result.error!.message).toContain('Connection timeout');
    });

    it('should call spending policy engine before checking balance', async () => {
      const callOrder: string[] = [];
      const deps = createDeps({
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockImplementation(async () => {
            callOrder.push('policy');
            return {
              agentId: 'agent-1',
              paymentAmount: '1.50',
              perTransactionLimit: '10.00',
              cumulativeSpent24h: '0.000000',
              cumulativeLimit: '100.00',
              approved: true,
            };
          }),
        }),
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockImplementation(async () => {
            callOrder.push('balance');
            return {
              agentId: 'agent-1',
              walletId: 'wallet-1',
              balance: '50.00',
              lastUpdated: '2024-01-01T00:00:00.000Z',
            };
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      await executor.executePayment(request);

      expect(callOrder).toEqual(['policy', 'balance']);
    });

    it('should allow exactly 10 USDC payment (boundary)', async () => {
      const deps = createDeps({
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            walletId: 'wallet-1',
            balance: '50.00',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '10.00',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('settled');
    });

    it('should reject 10.01 USDC payment (just over cap)', async () => {
      const deps = createDeps({
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            walletId: 'wallet-1',
            balance: '50.00',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          }),
        }),
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest({
        paymentRequirements: {
          recipientAddress: '0xrecipient456',
          amount: '10.01',
          asset: 'USDC',
          network: 'base',
          paymentId: 'pay-001',
        },
      });

      const result = await executor.executePayment(request);

      expect(result.status).toBe('rejected');
      expect(result.error!.code).toBe('EXCEEDS_TRANSACTION_LIMIT');
    });

    // --- Edge Case Tests (Requirements 3.7, 3.8) ---

    it('should return ON_CHAIN_FAILURE with undefined transactionHash when tx was never submitted', async () => {
      // Requirement 3.8: On-chain failure returns error with failure reason
      // Edge case: the on-chain client fails before a tx hash is generated
      const deps = createDeps({
        onChainClient: {
          submitPayment: jest.fn().mockRejectedValue(
            new OnChainTransactionError('network unreachable', undefined)
          ),
        },
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('failed');
      expect(result.error!.code).toBe('ON_CHAIN_FAILURE');
      expect(result.error!.message).toContain('network unreachable');
      expect(result.error!.transactionHash).toBeUndefined();
      expect(result.transactionHash).toBeUndefined();
    });

    it('should include both transaction hash and failure reason in ON_CHAIN_FAILURE error', async () => {
      // Requirement 3.8: error includes tx hash AND failure reason
      const deps = createDeps({
        onChainClient: {
          submitPayment: jest.fn().mockRejectedValue(
            new OnChainTransactionError('insufficient gas', '0xpartial_tx_abc')
          ),
        },
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const result = await executor.executePayment(request);

      expect(result.status).toBe('failed');
      expect(result.error!.code).toBe('ON_CHAIN_FAILURE');
      expect(result.error!.transactionHash).toBe('0xpartial_tx_abc');
      expect(result.transactionHash).toBe('0xpartial_tx_abc');
      expect(result.error!.message).toContain('insufficient gas');
    });

    it('should complete full payment cycle within 5 seconds (timing constraint)', async () => {
      // Requirement 3.7: Full payment cycle (402 receipt → payment → replay) < 5 seconds
      // With fast mocks, the cycle should complete well under the 5-second budget
      const deps = createDeps({
        spendingPolicyEngine: createMockSpendingPolicyEngine({
          evaluate: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            paymentAmount: '1.50',
            perTransactionLimit: '10.00',
            cumulativeSpent24h: '0.000000',
            cumulativeLimit: '100.00',
            approved: true,
          }),
        }),
        walletManager: createMockWalletManager({
          getBalance: jest.fn().mockResolvedValue({
            agentId: 'agent-1',
            walletId: 'wallet-1',
            balance: '50.00',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          }),
        }),
        onChainClient: {
          submitPayment: jest.fn().mockResolvedValue({
            transactionHash: '0xtiming_test_hash',
          }),
        },
        httpClient: {
          replayWithReceipt: jest.fn().mockResolvedValue({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: '{"data": "market-feed"}',
          }),
        },
      });
      const executor = new DefaultPaymentExecutor(deps);
      const request = createValidPaymentRequest();

      const startTime = Date.now();
      const result = await executor.executePayment(request);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('settled');
      expect(result.transactionHash).toBe('0xtiming_test_hash');
      // The full cycle must complete within 5 seconds (5000ms)
      // With mocked dependencies, this should be nearly instant
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
