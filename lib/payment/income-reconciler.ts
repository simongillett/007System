/**
 * Income Reconciler implementation for crediting merchant agent wallets.
 *
 * Responsibilities:
 * - Receive settlement events from Payment Executor
 * - Wait up to 60 seconds for on-chain confirmation (reconciliation window)
 * - Credit the merchant agent's wallet via WalletManager
 * - Retry failed credits 3x with exponential backoff (1s, 2s, 4s)
 * - Flag unreconciled transactions for manual review via Audit Logger
 * - Detect and reject duplicate transaction hashes
 *
 * Uses dependency injection for:
 * - WalletManager: wallet credit operations
 * - AuditLogger: audit trail and flagging for review
 * - Clock: testable time and delays
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6
 */

import { WalletManager } from '../types/wallet';
import { AuditLogger, AuditRecord } from '../types/audit';
import { PolicyEvaluation } from '../types/spending-policy';

// --- Dependency Interfaces ---

/**
 * Interface for testable time operations and delays.
 */
export interface Clock {
  /** Get the current time as ISO 8601 UTC string */
  now(): string;

  /** Generate a unique correlation ID */
  generateId(): string;

  /** Wait for the specified number of milliseconds */
  delay(ms: number): Promise<void>;
}

/**
 * Interface for checking on-chain transaction confirmation status.
 */
export interface OnChainConfirmationClient {
  /**
   * Check if a transaction has been confirmed on-chain.
   * Returns true if the transaction has at least 1 block confirmation.
   */
  isConfirmed(transactionHash: string): Promise<boolean>;
}

// --- Settlement Event ---

/**
 * Represents a payment settlement event from the Payment Executor.
 * This is the input to the reconciliation process.
 */
export interface SettlementEvent {
  /** The on-chain transaction hash */
  transactionHash: string;

  /** The source agent (payer) */
  sourceAgentId: string;

  /** The destination agent (merchant receiving income) */
  destinationAgentId: string;

  /** The USDC amount (up to 6 decimal places) */
  amountUsdc: string;

  /** When the settlement was reported */
  settledAt: string;

  /** Policy evaluation result from the payment */
  policyEvaluation: PolicyEvaluation;
}

/**
 * Result of processing a settlement event.
 */
export interface ReconciliationResult {
  status: 'credited' | 'failed' | 'duplicate' | 'unreconciled';
  transactionHash: string;
  correlationId: string;
  error?: string;
}

// --- Constants ---

/** Maximum time to wait for on-chain confirmation (Requirement 4.2) */
const RECONCILIATION_WINDOW_MS = 60_000;

/** Polling interval for on-chain confirmation checks */
const CONFIRMATION_POLL_INTERVAL_MS = 5_000;

/** Maximum number of credit retries (Requirement 4.5) */
const MAX_CREDIT_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds */
const BASE_BACKOFF_MS = 1_000;

// --- Dependencies Container ---

export interface IncomeReconcilerDependencies {
  walletManager: WalletManager;
  auditLogger: AuditLogger;
  clock: Clock;
  onChainClient: OnChainConfirmationClient;
}

// --- Error Types ---

export class DuplicateSettlementError extends Error {
  public readonly transactionHash: string;

  constructor(transactionHash: string) {
    super(`Duplicate settlement event for transaction: ${transactionHash}`);
    this.name = 'DuplicateSettlementError';
    this.transactionHash = transactionHash;
  }
}

export class ReconciliationTimeoutError extends Error {
  public readonly transactionHash: string;

  constructor(transactionHash: string) {
    super(
      `On-chain confirmation not received within 60-second reconciliation window for transaction: ${transactionHash}`
    );
    this.name = 'ReconciliationTimeoutError';
    this.transactionHash = transactionHash;
  }
}

export class CreditFailedError extends Error {
  public readonly transactionHash: string;
  public readonly attempts: number;

  constructor(transactionHash: string, attempts: number, cause: string) {
    super(
      `Failed to credit wallet after ${attempts} attempts for transaction ${transactionHash}: ${cause}`
    );
    this.name = 'CreditFailedError';
    this.transactionHash = transactionHash;
    this.attempts = attempts;
  }
}

// --- Implementation ---

/**
 * Default Income Reconciler implementation.
 *
 * Processes settlement events by:
 * 1. Checking for duplicate transaction hashes
 * 2. Waiting for on-chain confirmation within 60-second window
 * 3. Crediting the merchant agent's wallet
 * 4. Retrying failed credits with exponential backoff
 * 5. Flagging unreconciled/failed transactions for manual review
 */
export class DefaultIncomeReconciler {
  private readonly deps: IncomeReconcilerDependencies;

  /** Track processed transaction hashes for duplicate detection */
  private readonly processedHashes: Set<string> = new Set();

  constructor(deps: IncomeReconcilerDependencies) {
    this.deps = deps;
  }

  /**
   * Process a settlement event from the Payment Executor.
   *
   * Full flow:
   * 1. Check for duplicate transaction hash (Requirement 4.6)
   * 2. Wait for on-chain confirmation within 60s window (Requirement 4.2)
   * 3. Credit the merchant wallet (Requirement 4.1)
   * 4. Retry on failure with exponential backoff (Requirement 4.5)
   * 5. Flag for manual review if unreconciled or all retries fail (Requirement 4.4)
   *
   * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6
   */
  async processSettlement(event: SettlementEvent): Promise<ReconciliationResult> {
    const correlationId = this.deps.clock.generateId();

    // Step 1: Duplicate detection (Requirement 4.6)
    if (this.processedHashes.has(event.transactionHash)) {
      await this.recordDuplicateAttempt(event, correlationId);
      return {
        status: 'duplicate',
        transactionHash: event.transactionHash,
        correlationId,
        error: `Duplicate settlement event for transaction: ${event.transactionHash}`,
      };
    }

    // Mark as being processed
    this.processedHashes.add(event.transactionHash);

    // Step 2: Wait for on-chain confirmation within 60-second window (Requirement 4.2)
    const confirmed = await this.waitForConfirmation(event.transactionHash);

    if (!confirmed) {
      // Flag for manual review (Requirement 4.4)
      await this.flagUnreconciled(event, correlationId);
      return {
        status: 'unreconciled',
        transactionHash: event.transactionHash,
        correlationId,
        error: `On-chain confirmation not received within 60-second reconciliation window`,
      };
    }

    // Step 3: Credit the merchant wallet with retry logic (Requirements 4.1, 4.5)
    const creditResult = await this.creditWithRetry(event, correlationId);

    return creditResult;
  }

  /**
   * Wait for on-chain confirmation within the 60-second reconciliation window.
   * Polls every 5 seconds until confirmed or timeout.
   *
   * Requirement: 4.2
   */
  private async waitForConfirmation(transactionHash: string): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < RECONCILIATION_WINDOW_MS) {
      try {
        const confirmed = await this.deps.onChainClient.isConfirmed(transactionHash);
        if (confirmed) {
          return true;
        }
      } catch {
        // Ignore individual check failures; keep polling until timeout
      }

      // Check if we'd exceed the window with another poll
      const elapsed = Date.now() - startTime;
      if (elapsed + CONFIRMATION_POLL_INTERVAL_MS >= RECONCILIATION_WINDOW_MS) {
        break;
      }

      await this.deps.clock.delay(CONFIRMATION_POLL_INTERVAL_MS);
    }

    return false;
  }

  /**
   * Credit the merchant wallet with retry logic.
   * Retries 3x with exponential backoff (1s, 2s, 4s).
   * Flags for manual review if all retries fail.
   *
   * Requirements: 4.1, 4.5
   */
  private async creditWithRetry(
    event: SettlementEvent,
    correlationId: string
  ): Promise<ReconciliationResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_CREDIT_RETRIES; attempt++) {
      try {
        await this.deps.walletManager.creditWallet(
          event.destinationAgentId,
          event.amountUsdc,
          event.transactionHash
        );

        // Success — record the income credit in audit log
        await this.recordIncomeCredit(event, correlationId);

        return {
          status: 'credited',
          transactionHash: event.transactionHash,
          correlationId,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Wait with exponential backoff before next retry (1s, 2s, 4s)
        if (attempt < MAX_CREDIT_RETRIES - 1) {
          const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          await this.deps.clock.delay(delayMs);
        }
      }
    }

    // All retries exhausted — flag for manual review (Requirement 4.5)
    await this.flagCreditFailed(event, correlationId, lastError!);

    return {
      status: 'failed',
      transactionHash: event.transactionHash,
      correlationId,
      error: `Failed to credit wallet after ${MAX_CREDIT_RETRIES} attempts: ${lastError?.message}`,
    };
  }

  /**
   * Record a successful income credit in the audit log.
   *
   * Requirement: 4.3
   */
  private async recordIncomeCredit(
    event: SettlementEvent,
    correlationId: string
  ): Promise<void> {
    const record: AuditRecord = {
      correlationId,
      sourceAgentId: event.sourceAgentId,
      destinationAgentId: event.destinationAgentId,
      amountUsdc: event.amountUsdc,
      transactionHash: event.transactionHash,
      timestamp: this.deps.clock.now(),
      status: 'settled',
      policyEvaluation: event.policyEvaluation,
      eventType: 'income_credited',
    };

    await this.deps.auditLogger.record(record);
  }

  /**
   * Record a duplicate settlement attempt in the audit log.
   *
   * Requirement: 4.6
   */
  private async recordDuplicateAttempt(
    event: SettlementEvent,
    correlationId: string
  ): Promise<void> {
    const record: AuditRecord = {
      correlationId,
      sourceAgentId: event.sourceAgentId,
      destinationAgentId: event.destinationAgentId,
      amountUsdc: event.amountUsdc,
      transactionHash: event.transactionHash,
      timestamp: this.deps.clock.now(),
      status: 'failed',
      policyEvaluation: event.policyEvaluation,
      eventType: 'duplicate_detected',
    };

    await this.deps.auditLogger.record(record);
  }

  /**
   * Flag an unreconciled transaction for manual review.
   *
   * Requirement: 4.4
   */
  private async flagUnreconciled(
    event: SettlementEvent,
    correlationId: string
  ): Promise<void> {
    // First record the reconciliation failure
    const record: AuditRecord = {
      correlationId,
      sourceAgentId: event.sourceAgentId,
      destinationAgentId: event.destinationAgentId,
      amountUsdc: event.amountUsdc,
      transactionHash: event.transactionHash,
      timestamp: this.deps.clock.now(),
      status: 'pending_review',
      policyEvaluation: event.policyEvaluation,
      eventType: 'reconciliation_failed',
    };

    await this.deps.auditLogger.record(record);

    // Then flag for review
    await this.deps.auditLogger.flagForReview(
      correlationId,
      `On-chain confirmation not received within 60-second reconciliation window for transaction ${event.transactionHash}`
    );
  }

  /**
   * Flag a failed credit for manual review after all retries exhausted.
   *
   * Requirement: 4.5
   */
  private async flagCreditFailed(
    event: SettlementEvent,
    correlationId: string,
    error: Error
  ): Promise<void> {
    // Record the failure
    const record: AuditRecord = {
      correlationId,
      sourceAgentId: event.sourceAgentId,
      destinationAgentId: event.destinationAgentId,
      amountUsdc: event.amountUsdc,
      transactionHash: event.transactionHash,
      timestamp: this.deps.clock.now(),
      status: 'pending_review',
      policyEvaluation: event.policyEvaluation,
      eventType: 'reconciliation_failed',
    };

    await this.deps.auditLogger.record(record);

    // Flag for manual review
    await this.deps.auditLogger.flagForReview(
      correlationId,
      `Wallet credit failed after ${MAX_CREDIT_RETRIES} retries: ${error.message}`
    );
  }

  /**
   * Get the set of processed transaction hashes (for testing/monitoring).
   */
  getProcessedHashes(): ReadonlySet<string> {
    return this.processedHashes;
  }
}
