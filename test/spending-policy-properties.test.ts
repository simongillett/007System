/**
 * Property-based tests for Spending Policy Engine.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 10: Spending Policy Evaluation
 * - Property 11: No-Policy Rejection
 * - Property 12: Spending Policy Range Validation
 */

import fc from 'fast-check';
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
    get: async (agentId: string) => policies.get(agentId) || null,
    put: async (policy: SpendingPolicy) => {
      policies.set(policy.agentId, policy);
    },
  };
}

function createMockTransactionStore(
  transactions: PaymentTransaction[] = []
): TransactionStore {
  return {
    queryByAgentAndTimeRange: async (agentId: string, startTime: string) => {
      return transactions.filter(
        (tx) => tx.agentId === agentId && tx.timestamp >= startTime
      );
    },
  };
}

// --- Arbitraries ---

/**
 * Generates positive USDC amounts in the valid policy range [0.01, 999,999,999.99].
 * Uses integer cents to avoid floating-point precision issues.
 */
const validUsdcAmount = fc
  .integer({ min: 1, max: 99999999999 }) // 0.01 to 999,999,999.99 in cents
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates positive USDC amounts suitable for payment amounts.
 * Range: [0.01, 10000] — reasonable payment amounts for testing.
 */
const paymentAmount = fc
  .integer({ min: 1, max: 1000000 }) // 0.01 to 10,000.00 in cents
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates per-transaction limits in valid range.
 */
const perTransactionLimit = fc
  .integer({ min: 1, max: 99999999999 })
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates cumulative limits in valid range.
 */
const cumulativeLimit = fc
  .integer({ min: 1, max: 99999999999 })
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates cumulative spend values (non-negative).
 */
const cumulativeSpend = fc
  .integer({ min: 0, max: 99999999999 })
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates random agent IDs.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 50 }
);

/**
 * Generates values below the minimum policy limit (< 0.01).
 */
const belowMinLimit = fc.oneof(
  fc.constant('0'),
  fc.constant('0.00'),
  fc.constant('0.001'),
  fc.constant('0.009'),
  fc.constant('0.0099'),
  fc.double({ min: -1000, max: 0.0099, noNaN: true, noDefaultInfinity: true })
    .filter((n) => n < 0.01)
    .map((n) => n.toFixed(6))
);

/**
 * Generates values above the maximum policy limit (> 999,999,999.99).
 */
const aboveMaxLimit = fc.oneof(
  fc.constant('1000000000.00'),
  fc.constant('1000000000.01'),
  fc.constant('9999999999.99'),
  fc.double({ min: 1000000000, max: 99999999999, noNaN: true, noDefaultInfinity: true })
    .map((n) => n.toFixed(2))
);

// --- Property Tests ---

describe('Property 10: Spending Policy Evaluation', () => {
  /**
   * **Validates: Requirements 5.3, 5.4, 5.5**
   *
   * For any payment amount A, per-transaction limit L, cumulative spend S,
   * and cumulative limit C:
   * - Approved iff A <= L AND (S + A) <= C
   * - If A > L → rejection reason is 'PER_TRANSACTION_EXCEEDED'
   * - If A <= L but (S + A) > C → rejection reason is 'CUMULATIVE_EXCEEDED'
   */
  it('should approve payment iff A <= L AND (S + A) <= C', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        paymentAmount,
        perTransactionLimit,
        cumulativeSpend,
        cumulativeLimit,
        async (agentIdVal, amountStr, perTxLimitStr, cumSpendStr, cumLimitStr) => {
          const amount = parseFloat(amountStr);
          const perTxLimit = parseFloat(perTxLimitStr);
          const cumSpent = parseFloat(cumSpendStr);
          const cumLimit = parseFloat(cumLimitStr);

          // Set up policy
          const policies = new Map<string, SpendingPolicy>();
          policies.set(agentIdVal, {
            agentId: agentIdVal,
            perTransactionLimitUsdc: perTxLimitStr,
            cumulativeLimitUsdc: cumLimitStr,
            updatedAt: new Date().toISOString(),
          });

          // Set up transactions to simulate cumulative spend
          const transactions: PaymentTransaction[] = [];
          if (cumSpent > 0) {
            transactions.push({
              agentId: agentIdVal,
              timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
              amountUsdc: cumSpendStr,
              transactionHash: '0xabc123',
              status: 'settled',
            });
          }

          const policyStore = createMockPolicyStore(policies);
          const transactionStore = createMockTransactionStore(transactions);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const result = await engine.evaluate(agentIdVal, amountStr);

          // Determine expected outcome
          const shouldApprove = amount <= perTxLimit && (cumSpent + amount) <= cumLimit;

          expect(result.approved).toBe(shouldApprove);

          if (!shouldApprove) {
            if (amount > perTxLimit) {
              expect(result.rejectionReason).toBe('PER_TRANSACTION_EXCEEDED');
            } else {
              // A <= L but (S + A) > C
              expect(result.rejectionReason).toBe('CUMULATIVE_EXCEEDED');
            }
          } else {
            expect(result.rejectionReason).toBeUndefined();
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always report PER_TRANSACTION_EXCEEDED when A > L regardless of cumulative', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Generate amount strictly greater than limit
        fc.integer({ min: 2, max: 1000000 }).chain((limitCents) =>
          fc.tuple(
            fc.constant(((limitCents - 1) / 100).toFixed(2)), // limit
            fc.constant((limitCents / 100).toFixed(2)), // amount = limit + 0.01 (exceeds)
            fc.integer({ min: 0, max: 99999999999 }).map((c) => (c / 100).toFixed(2)), // cumSpend
            fc.integer({ min: 1, max: 99999999999 }).map((c) => (c / 100).toFixed(2)) // cumLimit
          )
        ),
        async (agentIdVal, [perTxLimitStr, amountStr, cumSpendStr, cumLimitStr]) => {
          const policies = new Map<string, SpendingPolicy>();
          policies.set(agentIdVal, {
            agentId: agentIdVal,
            perTransactionLimitUsdc: perTxLimitStr,
            cumulativeLimitUsdc: cumLimitStr,
            updatedAt: new Date().toISOString(),
          });

          const transactions: PaymentTransaction[] = [];
          const cumSpent = parseFloat(cumSpendStr);
          if (cumSpent > 0) {
            transactions.push({
              agentId: agentIdVal,
              timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              amountUsdc: cumSpendStr,
              transactionHash: '0xdef456',
              status: 'settled',
            });
          }

          const policyStore = createMockPolicyStore(policies);
          const transactionStore = createMockTransactionStore(transactions);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const result = await engine.evaluate(agentIdVal, amountStr);

          expect(result.approved).toBe(false);
          expect(result.rejectionReason).toBe('PER_TRANSACTION_EXCEEDED');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should report CUMULATIVE_EXCEEDED when A <= L but (S + A) > C', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Generate scenarios where A <= L but (S + A) > C
        fc.integer({ min: 1, max: 500000 }).chain((amountCents) =>
          fc.tuple(
            fc.constant((amountCents / 100).toFixed(2)), // amount
            // limit >= amount (so A <= L)
            fc.integer({ min: amountCents, max: 99999999999 }).map((c) => (c / 100).toFixed(2)),
            // cumLimit and cumSpend such that cumSpend + amount > cumLimit
            fc.integer({ min: 1, max: 99999999999 }).chain((cumLimitCents) => {
              // cumSpend must be > cumLimit - amount to ensure (S + A) > C
              const minCumSpendCents = Math.max(0, cumLimitCents - amountCents + 1);
              if (minCumSpendCents > 99999999999) {
                return fc.constant([(cumLimitCents / 100).toFixed(2), ((cumLimitCents + 1) / 100).toFixed(2)]);
              }
              return fc.integer({ min: minCumSpendCents, max: Math.min(minCumSpendCents + 10000000, 99999999999) })
                .map((cumSpendCents) => [
                  (cumLimitCents / 100).toFixed(2),
                  (cumSpendCents / 100).toFixed(2),
                ]);
            })
          )
        ),
        async (agentIdVal, [amountStr, perTxLimitStr, [cumLimitStr, cumSpendStr]]) => {
          const policies = new Map<string, SpendingPolicy>();
          policies.set(agentIdVal, {
            agentId: agentIdVal,
            perTransactionLimitUsdc: perTxLimitStr,
            cumulativeLimitUsdc: cumLimitStr,
            updatedAt: new Date().toISOString(),
          });

          const cumSpent = parseFloat(cumSpendStr);
          const transactions: PaymentTransaction[] = [];
          if (cumSpent > 0) {
            transactions.push({
              agentId: agentIdVal,
              timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              amountUsdc: cumSpendStr,
              transactionHash: '0x789abc',
              status: 'settled',
            });
          }

          const policyStore = createMockPolicyStore(policies);
          const transactionStore = createMockTransactionStore(transactions);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const result = await engine.evaluate(agentIdVal, amountStr);

          expect(result.approved).toBe(false);
          expect(result.rejectionReason).toBe('CUMULATIVE_EXCEEDED');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 11: No-Policy Rejection', () => {
  /**
   * **Validates: Requirements 5.7**
   *
   * For any agent ID with no policy defined, ALL payment amounts
   * are rejected with 'NO_POLICY'.
   */
  it('should reject all payments with NO_POLICY when no policy exists for agent', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        paymentAmount,
        async (agentIdVal, amountStr) => {
          // Empty policy store — no policy for any agent
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const result = await engine.evaluate(agentIdVal, amountStr);

          expect(result.approved).toBe(false);
          expect(result.rejectionReason).toBe('NO_POLICY');
          expect(result.agentId).toBe(agentIdVal);
          expect(result.paymentAmount).toBe(amountStr);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject with NO_POLICY regardless of payment amount magnitude', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        // Test with a wide range of amounts including very small and very large
        fc.oneof(
          fc.constant('0.01'),
          fc.constant('999999999.99'),
          paymentAmount
        ),
        async (agentIdVal, amountStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const result = await engine.evaluate(agentIdVal, amountStr);

          expect(result.approved).toBe(false);
          expect(result.rejectionReason).toBe('NO_POLICY');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 12: Spending Policy Range Validation', () => {
  /**
   * **Validates: Requirements 5.1**
   *
   * For any limit value:
   * - Values in [0.01, 999,999,999.99] are accepted by updatePolicy
   * - Values < 0.01 or > 999,999,999.99 are rejected by updatePolicy
   */
  it('should accept any per-transaction limit in [0.01, 999,999,999.99]', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        validUsdcAmount,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: limitStr,
            cumulativeLimitUsdc: '100.00', // valid fixed value
            updatedAt: new Date().toISOString(),
          };

          // Should not throw
          await expect(engine.updatePolicy(policy)).resolves.toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept any cumulative limit in [0.01, 999,999,999.99]', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        validUsdcAmount,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: '1.00', // valid fixed value
            cumulativeLimitUsdc: limitStr,
            updatedAt: new Date().toISOString(),
          };

          // Should not throw
          await expect(engine.updatePolicy(policy)).resolves.toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject per-transaction limits below 0.01', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        belowMinLimit,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: limitStr,
            cumulativeLimitUsdc: '100.00',
            updatedAt: new Date().toISOString(),
          };

          await expect(engine.updatePolicy(policy)).rejects.toThrow(
            PolicyValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject per-transaction limits above 999,999,999.99', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        aboveMaxLimit,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: limitStr,
            cumulativeLimitUsdc: '100.00',
            updatedAt: new Date().toISOString(),
          };

          await expect(engine.updatePolicy(policy)).rejects.toThrow(
            PolicyValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject cumulative limits below 0.01', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        belowMinLimit,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: '1.00',
            cumulativeLimitUsdc: limitStr,
            updatedAt: new Date().toISOString(),
          };

          await expect(engine.updatePolicy(policy)).rejects.toThrow(
            PolicyValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject cumulative limits above 999,999,999.99', () => {
    fc.assert(
      fc.asyncProperty(
        agentId,
        aboveMaxLimit,
        async (agentIdVal, limitStr) => {
          const policyStore = createMockPolicyStore(new Map());
          const transactionStore = createMockTransactionStore([]);
          const engine = new DefaultSpendingPolicyEngine({
            policyStore,
            transactionStore,
          });

          const policy: SpendingPolicy = {
            agentId: agentIdVal,
            perTransactionLimitUsdc: '1.00',
            cumulativeLimitUsdc: limitStr,
            updatedAt: new Date().toISOString(),
          };

          await expect(engine.updatePolicy(policy)).rejects.toThrow(
            PolicyValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
