/**
 * Spending Policy Engine interfaces for per-transaction and cumulative spending limits.
 * Enforces configurable spending controls per agent.
 */

export type PolicyRejectionReason =
  | 'PER_TRANSACTION_EXCEEDED'
  | 'CUMULATIVE_EXCEEDED'
  | 'NO_POLICY';

export interface SpendingPolicy {
  agentId: string;
  perTransactionLimitUsdc: string;
  cumulativeLimitUsdc: string;
  updatedAt: string;
}

export interface PolicyEvaluation {
  agentId: string;
  paymentAmount: string;
  perTransactionLimit: string;
  cumulativeSpent24h: string;
  cumulativeLimit: string;
  approved: boolean;
  rejectionReason?: PolicyRejectionReason;
}

export interface SpendingPolicyEngine {
  evaluate(agentId: string, amount: string): Promise<PolicyEvaluation>;
  updatePolicy(policy: SpendingPolicy): Promise<void>;
  getCumulativeSpend(agentId: string, windowHours: number): Promise<string>;
}
