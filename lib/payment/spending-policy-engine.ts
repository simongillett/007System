/**
 * Spending Policy Engine implementation.
 *
 * Enforces per-transaction and cumulative spending limits for each agent.
 * Uses dependency injection for DynamoDB interactions to enable testability.
 *
 * Key behaviors:
 * - evaluate: checks per-transaction limit (A <= L) and cumulative 24h window (S + A <= C)
 * - updatePolicy: stores/updates policy, applies within 10 seconds (Requirement 5.6)
 * - getCumulativeSpend: queries Payment Transactions table for 24h rolling window
 * - Validates policy range [0.01, 999,999,999.99] USDC (Requirement 5.1)
 * - Rejects payments when no policy is defined for agent (Requirement 5.7)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import {
  SpendingPolicy,
  PolicyEvaluation,
  SpendingPolicyEngine,
} from '../types/spending-policy';

// --- Dependency Interfaces ---

/**
 * Interface for the Spending Policy DynamoDB table operations.
 * PK: agentId
 */
export interface PolicyStore {
  /** Retrieve a spending policy by agent ID, returns null if not found */
  get(agentId: string): Promise<SpendingPolicy | null>;

  /** Store or update a spending policy */
  put(policy: SpendingPolicy): Promise<void>;
}

/**
 * Represents a settled payment transaction in the rolling window.
 */
export interface PaymentTransaction {
  agentId: string;
  timestamp: string; // ISO 8601
  amountUsdc: string;
  transactionHash: string;
  status: 'settled' | 'failed';
}

/**
 * Interface for the Payment Transactions DynamoDB table operations.
 * PK: agentId, SK: timestamp
 */
export interface TransactionStore {
  /**
   * Query all transactions for an agent within a time range.
   * Returns transactions where timestamp >= startTime.
   */
  queryByAgentAndTimeRange(
    agentId: string,
    startTime: string
  ): Promise<PaymentTransaction[]>;
}

// --- Error Types ---

export class PolicyValidationError extends Error {
  public readonly field: string;
  public readonly value: string;

  constructor(field: string, value: string, message: string) {
    super(message);
    this.name = 'PolicyValidationError';
    this.field = field;
    this.value = value;
  }
}

// --- Constants ---

/** Minimum allowed policy limit in USDC */
const MIN_POLICY_LIMIT = 0.01;

/** Maximum allowed policy limit in USDC */
const MAX_POLICY_LIMIT = 999_999_999.99;

// --- Dependencies Container ---

export interface SpendingPolicyEngineDependencies {
  policyStore: PolicyStore;
  transactionStore: TransactionStore;
}

// --- Implementation ---

/**
 * Default Spending Policy Engine implementation.
 *
 * Evaluates payment requests against per-transaction and cumulative limits,
 * manages policy storage, and computes rolling window cumulative spend.
 */
export class DefaultSpendingPolicyEngine implements SpendingPolicyEngine {
  private readonly deps: SpendingPolicyEngineDependencies;

  constructor(deps: SpendingPolicyEngineDependencies) {
    this.deps = deps;
  }

  /**
   * Evaluate a payment request against the agent's spending policy.
   *
   * Checks:
   * 1. Policy exists for agent (Requirement 5.7)
   * 2. Amount <= per-transaction limit (Requirement 5.4)
   * 3. (Cumulative spend 24h + amount) <= cumulative limit (Requirement 5.5)
   *
   * Requirements: 5.3, 5.4, 5.5, 5.7
   */
  async evaluate(agentId: string, amount: string): Promise<PolicyEvaluation> {
    // Step 1: Retrieve policy — reject if none exists (Requirement 5.7)
    const policy = await this.deps.policyStore.get(agentId);

    if (!policy) {
      return {
        agentId,
        paymentAmount: amount,
        perTransactionLimit: '0',
        cumulativeSpent24h: '0',
        cumulativeLimit: '0',
        approved: false,
        rejectionReason: 'NO_POLICY',
      };
    }

    const paymentAmount = parseFloat(amount);
    const perTransactionLimit = parseFloat(policy.perTransactionLimitUsdc);
    const cumulativeLimit = parseFloat(policy.cumulativeLimitUsdc);

    // Step 2: Check per-transaction limit (Requirement 5.4)
    // Reject if amount is strictly greater than the limit
    if (paymentAmount > perTransactionLimit) {
      const cumulativeSpent24h = await this.getCumulativeSpend(agentId, 24);
      return {
        agentId,
        paymentAmount: amount,
        perTransactionLimit: policy.perTransactionLimitUsdc,
        cumulativeSpent24h,
        cumulativeLimit: policy.cumulativeLimitUsdc,
        approved: false,
        rejectionReason: 'PER_TRANSACTION_EXCEEDED',
      };
    }

    // Step 3: Check cumulative 24h window (Requirement 5.5)
    // Reject if (cumulative spend + amount) strictly exceeds the cumulative limit
    const cumulativeSpent24h = await this.getCumulativeSpend(agentId, 24);
    const cumulativeSpentNum = parseFloat(cumulativeSpent24h);

    if (cumulativeSpentNum + paymentAmount > cumulativeLimit) {
      return {
        agentId,
        paymentAmount: amount,
        perTransactionLimit: policy.perTransactionLimitUsdc,
        cumulativeSpent24h,
        cumulativeLimit: policy.cumulativeLimitUsdc,
        approved: false,
        rejectionReason: 'CUMULATIVE_EXCEEDED',
      };
    }

    // All checks passed — approve
    return {
      agentId,
      paymentAmount: amount,
      perTransactionLimit: policy.perTransactionLimitUsdc,
      cumulativeSpent24h,
      cumulativeLimit: policy.cumulativeLimitUsdc,
      approved: true,
    };
  }

  /**
   * Store or update a spending policy for an agent.
   *
   * Validates that limits are within the allowed range [0.01, 999,999,999.99] USDC.
   * Policy applies to subsequent payment requests within 10 seconds (Requirement 5.6).
   *
   * Requirements: 5.1, 5.6
   */
  async updatePolicy(policy: SpendingPolicy): Promise<void> {
    // Validate perTransactionLimitUsdc range (Requirement 5.1)
    validatePolicyLimit(
      'perTransactionLimitUsdc',
      policy.perTransactionLimitUsdc
    );

    // Validate cumulativeLimitUsdc range (Requirement 5.1)
    validatePolicyLimit('cumulativeLimitUsdc', policy.cumulativeLimitUsdc);

    // Store the policy — DynamoDB PutItem is effectively immediate,
    // satisfying the 10-second application requirement (Requirement 5.6)
    await this.deps.policyStore.put(policy);
  }

  /**
   * Compute the cumulative spend for an agent within a rolling window.
   *
   * Queries the Payment Transactions table for all settled transactions
   * in the preceding `windowHours` hours from the current time.
   *
   * Requirements: 5.2
   */
  async getCumulativeSpend(
    agentId: string,
    windowHours: number
  ): Promise<string> {
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - windowHours * 60 * 60 * 1000
    );
    const startTime = windowStart.toISOString();

    const transactions =
      await this.deps.transactionStore.queryByAgentAndTimeRange(
        agentId,
        startTime
      );

    // Sum only settled transactions within the window
    let total = 0;
    for (const tx of transactions) {
      if (tx.status === 'settled') {
        total += parseFloat(tx.amountUsdc);
      }
    }

    // Return as string with sufficient precision
    return total.toFixed(6);
  }
}

// --- Validation Utilities ---

/**
 * Validate that a policy limit value is within the allowed range.
 * Range: [0.01, 999,999,999.99] USDC (Requirement 5.1)
 */
function validatePolicyLimit(field: string, value: string): void {
  const num = parseFloat(value);

  if (isNaN(num)) {
    throw new PolicyValidationError(
      field,
      value,
      `${field} must be a valid number, got: ${value}`
    );
  }

  if (num < MIN_POLICY_LIMIT) {
    throw new PolicyValidationError(
      field,
      value,
      `${field} must be at least ${MIN_POLICY_LIMIT} USDC, got: ${value}`
    );
  }

  if (num > MAX_POLICY_LIMIT) {
    throw new PolicyValidationError(
      field,
      value,
      `${field} must not exceed ${MAX_POLICY_LIMIT} USDC, got: ${value}`
    );
  }
}
