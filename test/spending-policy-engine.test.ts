/**
 * Unit tests for the Spending Policy Engine.
 *
 * Tests cover:
 * - evaluate: per-transaction limit, cumulative limit, no-policy rejection
 * - updatePolicy: validation, storage
 * - getCumulativeSpend: rolling window computation
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import {
  DefaultSpendingPolicyEngine,
  PolicyStore,
  TransactionStore,
  PaymentTransaction,
  PolicyValidationError,
} from '../lib/payment/spending-policy-engine';
import { SpendingPolicy } from '../lib/types/spending-policy';

// --- Test Helpers ---

function createMockPolicyStore(
  policies: Map<string, SpendingPolicy> = new Map()
): PolicyStore {
  return {
    get: jest.fn(async (agentId: string) => policies.get(agentId) || null),
    put: jest.fn(async (policy: SpendingPolicy) => {
      policies.set(policy.agentId, policy);
    }),
  };
}

function createMockTransactionStore(
  transactions: PaymentTransaction[] = []
): TransactionStore {
  return {
    queryByAgentAndTimeRange: jest.fn(
      async (agentId: string, startTime: string) => {
        return transactions.filter(
          (tx) => tx.agentId === agentId && tx.timestamp >= startTime
        );
      }
    ),
  };
}

function createPolicy(
  agentId: string,
  perTxLimit: string,
  cumulativeLimit: string
): SpendingPolicy {
  return {
    agentId,
    perTransactionLimitUsdc: perTxLimit,
    cumulativeLimitUsdc: cumulativeLimit,
    updatedAt: new Date().toISOString(),
  };
}

function createSettledTransaction(
  agentId: string,
  amount: string,
  minutesAgo: number
): PaymentTransaction {
  const timestamp = new Date(
    Date.now() - minutesAgo * 60 * 1000
  ).toISOString();
  return {
    agentId,
    timestamp,
    amountUsdc: amount,
    transactionHash: `0x${Math.random().toString(16).slice(2)}`,
    status: 'settled',
  };
}

// --- Tests ---

describe('SpendingPolicyEngine', () => {
  describe('evaluate', () => {
    it('should reject payment when no policy exists for agent (Req 5.7)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-unknown', '1.00');

      expect(result.approved).toBe(false);
      expect(result.rejectionReason).toBe('NO_POLICY');
      expect(result.agentId).toBe('agent-unknown');
    });

    it('should approve payment within per-transaction and cumulative limits', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '10.00', '100.00'));

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '5.00');

      expect(result.approved).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
      expect(result.paymentAmount).toBe('5.00');
      expect(result.perTransactionLimit).toBe('10.00');
      expect(result.cumulativeLimit).toBe('100.00');
    });

    it('should approve payment at exactly the per-transaction limit (A == L)', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '10.00', '100.00'));

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '10.00');

      expect(result.approved).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
    });

    it('should reject payment exceeding per-transaction limit (Req 5.4)', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '10.00', '100.00'));

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '10.01');

      expect(result.approved).toBe(false);
      expect(result.rejectionReason).toBe('PER_TRANSACTION_EXCEEDED');
    });

    it('should approve payment at exactly the cumulative limit (S + A == C)', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '50.00', '100.00'));

      const transactions = [
        createSettledTransaction('agent-1', '50.00', 60), // 1 hour ago
      ];

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '50.00');

      expect(result.approved).toBe(true);
      expect(result.rejectionReason).toBeUndefined();
    });

    it('should reject payment exceeding cumulative limit (Req 5.5)', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '50.00', '100.00'));

      const transactions = [
        createSettledTransaction('agent-1', '60.00', 60), // 1 hour ago
      ];

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '50.00');

      expect(result.approved).toBe(false);
      expect(result.rejectionReason).toBe('CUMULATIVE_EXCEEDED');
    });

    it('should only count settled transactions in cumulative spend', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '50.00', '100.00'));

      const transactions: PaymentTransaction[] = [
        createSettledTransaction('agent-1', '40.00', 60),
        {
          agentId: 'agent-1',
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          amountUsdc: '50.00',
          transactionHash: '0xfailed',
          status: 'failed', // Failed transactions should not count
        },
      ];

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      // 40 (settled) + 50 (new) = 90 <= 100 cumulative limit
      const result = await engine.evaluate('agent-1', '50.00');

      expect(result.approved).toBe(true);
    });

    it('should not count transactions from other agents', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '50.00', '100.00'));

      const transactions = [
        createSettledTransaction('agent-2', '90.00', 60), // Different agent
      ];

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.evaluate('agent-1', '50.00');

      expect(result.approved).toBe(true);
    });
  });

  describe('updatePolicy', () => {
    it('should store a valid policy', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '10.00', '100.00');
      await engine.updatePolicy(policy);

      expect(policyStore.put).toHaveBeenCalledWith(policy);
    });

    it('should accept minimum valid limit (0.01)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '0.01', '0.01');
      await expect(engine.updatePolicy(policy)).resolves.toBeUndefined();
    });

    it('should accept maximum valid limit (999,999,999.99)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '999999999.99', '999999999.99');
      await expect(engine.updatePolicy(policy)).resolves.toBeUndefined();
    });

    it('should reject perTransactionLimitUsdc below minimum (Req 5.1)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '0.001', '100.00');
      await expect(engine.updatePolicy(policy)).rejects.toThrow(
        PolicyValidationError
      );
    });

    it('should reject perTransactionLimitUsdc above maximum (Req 5.1)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '1000000000.00', '100.00');
      await expect(engine.updatePolicy(policy)).rejects.toThrow(
        PolicyValidationError
      );
    });

    it('should reject cumulativeLimitUsdc below minimum (Req 5.1)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '1.00', '0.009');
      await expect(engine.updatePolicy(policy)).rejects.toThrow(
        PolicyValidationError
      );
    });

    it('should reject cumulativeLimitUsdc above maximum (Req 5.1)', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', '1.00', '9999999999.99');
      await expect(engine.updatePolicy(policy)).rejects.toThrow(
        PolicyValidationError
      );
    });

    it('should reject non-numeric limit values', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const policy = createPolicy('agent-1', 'abc', '100.00');
      await expect(engine.updatePolicy(policy)).rejects.toThrow(
        PolicyValidationError
      );
    });

    it('should update an existing policy', async () => {
      const policies = new Map<string, SpendingPolicy>();
      policies.set('agent-1', createPolicy('agent-1', '5.00', '50.00'));

      const policyStore = createMockPolicyStore(policies);
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const updatedPolicy = createPolicy('agent-1', '20.00', '200.00');
      await engine.updatePolicy(updatedPolicy);

      // Verify the new policy is used in evaluation
      const result = await engine.evaluate('agent-1', '15.00');
      expect(result.approved).toBe(true);
      expect(result.perTransactionLimit).toBe('20.00');
    });
  });

  describe('getCumulativeSpend', () => {
    it('should return 0 when no transactions exist', async () => {
      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore();
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.getCumulativeSpend('agent-1', 24);

      expect(parseFloat(result)).toBe(0);
    });

    it('should sum settled transactions within the window', async () => {
      const transactions = [
        createSettledTransaction('agent-1', '10.00', 60), // 1 hour ago
        createSettledTransaction('agent-1', '20.00', 120), // 2 hours ago
        createSettledTransaction('agent-1', '30.00', 180), // 3 hours ago
      ];

      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.getCumulativeSpend('agent-1', 24);

      expect(parseFloat(result)).toBeCloseTo(60.0, 2);
    });

    it('should exclude failed transactions from cumulative spend', async () => {
      const transactions: PaymentTransaction[] = [
        createSettledTransaction('agent-1', '10.00', 60),
        {
          agentId: 'agent-1',
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          amountUsdc: '50.00',
          transactionHash: '0xfailed',
          status: 'failed',
        },
      ];

      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.getCumulativeSpend('agent-1', 24);

      expect(parseFloat(result)).toBeCloseTo(10.0, 2);
    });

    it('should return result with 6 decimal places precision', async () => {
      const transactions = [
        createSettledTransaction('agent-1', '1.123456', 60),
      ];

      const policyStore = createMockPolicyStore();
      const transactionStore = createMockTransactionStore(transactions);
      const engine = new DefaultSpendingPolicyEngine({
        policyStore,
        transactionStore,
      });

      const result = await engine.getCumulativeSpend('agent-1', 24);

      // Should have 6 decimal places
      expect(result).toMatch(/^\d+\.\d{6}$/);
    });
  });
});
