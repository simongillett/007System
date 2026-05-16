/**
 * Audit Logger implementation for transaction recording and querying.
 *
 * Responsibilities:
 * - Record all payment events with correlation IDs and required fields
 * - Query by time range with optional agent filter (descending order, max 10,000)
 * - Flag unreconciled transactions for manual review
 * - Retry persistence 3x with exponential backoff (1s, 2s, 4s)
 * - Emit critical alert and preserve in memory when all retries exhausted
 * - Detect duplicate payments via GSI2 (transactionHash)
 *
 * Uses dependency injection for:
 * - AuditStore: DynamoDB operations (put, query, update, queryByHash)
 * - AlertEmitter: SNS publish for critical alerts
 * - Clock: testable timestamps and ID generation
 *
 * Requirements: 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import {
  AuditLogger,
  AuditRecord,
  AuditQuery,
} from '../types/audit';

// --- Dependency Interfaces ---

/**
 * Interface for DynamoDB operations on the Audit Trail table.
 */
export interface AuditStore {
  /**
   * Put an audit record into the table.
   * Throws on DynamoDB errors.
   */
  put(record: AuditRecord & { ttl: number }): Promise<void>;

  /**
   * Query records by time range (scan by timestamp).
   * Returns records in descending timestamp order.
   */
  queryByTimeRange(params: {
    startTime: string;
    endTime: string;
    limit: number;
  }): Promise<AuditRecord[]>;

  /**
   * Query records by agent ID and time range using GSI1.
   * Returns records in descending timestamp order.
   */
  queryByAgentAndTimeRange(params: {
    agentId: string;
    startTime: string;
    endTime: string;
    limit: number;
  }): Promise<AuditRecord[]>;

  /**
   * Query records by transaction hash using GSI2.
   * Used for duplicate detection.
   */
  queryByTransactionHash(transactionHash: string): Promise<AuditRecord[]>;

  /**
   * Update a record's status and add a review reason.
   */
  updateStatus(params: {
    correlationId: string;
    timestamp: string;
    status: string;
    reason: string;
  }): Promise<void>;

  /**
   * Get a record by correlationId (to retrieve timestamp for updates).
   */
  getByCorrelationId(correlationId: string): Promise<AuditRecord | null>;
}

/**
 * Interface for emitting critical alerts (SNS publish).
 */
export interface AlertEmitter {
  /**
   * Emit a critical alert when all persistence retries are exhausted.
   */
  emitCriticalAlert(params: {
    correlationId: string;
    reason: string;
    record: AuditRecord;
  }): Promise<void>;
}

/**
 * Interface for testable time and ID generation.
 */
export interface Clock {
  /**
   * Get the current time as ISO 8601 UTC string.
   */
  now(): string;

  /**
   * Generate a unique correlation ID.
   */
  generateId(): string;
}

// --- Constants ---

/** Maximum number of results for a query (Requirement 6.4) */
const MAX_QUERY_RESULTS = 10_000;

/** Number of retry attempts for persistence (Requirement 6.5) */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff in milliseconds (Requirement 6.5) */
const BASE_DELAY_MS = 1000;

/** TTL for audit records: 90 days in seconds (Requirement 6.3) */
const AUDIT_TTL_DAYS = 90;

// --- Dependencies Container ---

export interface AuditLoggerDependencies {
  store: AuditStore;
  alertEmitter: AlertEmitter;
  clock: Clock;
}

// --- Error Types ---

export class DuplicateTransactionError extends Error {
  public readonly transactionHash: string;
  public readonly existingCorrelationId: string;

  constructor(transactionHash: string, existingCorrelationId: string) {
    super(
      `Duplicate transaction detected: hash ${transactionHash} already recorded as ${existingCorrelationId}`
    );
    this.name = 'DuplicateTransactionError';
    this.transactionHash = transactionHash;
    this.existingCorrelationId = existingCorrelationId;
  }
}

export class AuditPersistenceError extends Error {
  public readonly correlationId: string;

  constructor(correlationId: string, cause: string) {
    super(`Failed to persist audit record ${correlationId}: ${cause}`);
    this.name = 'AuditPersistenceError';
    this.correlationId = correlationId;
  }
}

// --- Implementation ---

/**
 * Default Audit Logger implementation.
 *
 * Implements the AuditLogger interface with:
 * - Duplicate detection via GSI2 before recording
 * - Retry logic with exponential backoff (1s, 2s, 4s)
 * - Critical alert emission on exhausted retries
 * - In-memory preservation of unpersisted records
 * - Time-range queries with optional agent filter
 * - Flag for review functionality
 */
export class DefaultAuditLogger implements AuditLogger {
  private readonly deps: AuditLoggerDependencies;

  /**
   * In-memory buffer for records that failed all persistence retries.
   * Preserved until the next retry cycle (Requirement 6.6).
   */
  private readonly unpersistedRecords: AuditRecord[] = [];

  constructor(deps: AuditLoggerDependencies) {
    this.deps = deps;
  }

  /**
   * Get the list of unpersisted records (for testing/monitoring).
   */
  getUnpersistedRecords(): AuditRecord[] {
    return [...this.unpersistedRecords];
  }

  /**
   * Record an audit event with all required fields.
   *
   * Steps:
   * 1. Generate unique correlationId if not provided
   * 2. Check for duplicate transaction hash via GSI2 (Requirement 4.6)
   * 3. Persist with retry logic (3 retries, exponential backoff 1s, 2s, 4s)
   * 4. On exhausted retries: emit critical alert + preserve in memory (Requirement 6.6)
   *
   * Requirements: 4.3, 4.6, 6.1, 6.2, 6.5, 6.6
   */
  async record(event: AuditRecord): Promise<void> {
    // Ensure correlationId is set (Requirement 6.1)
    const record: AuditRecord = {
      ...event,
      correlationId: event.correlationId || this.deps.clock.generateId(),
      timestamp: event.timestamp || this.deps.clock.now(),
    };

    // Step 1: Check for duplicate transaction hash (Requirement 4.6)
    if (record.transactionHash) {
      const existing = await this.deps.store.queryByTransactionHash(
        record.transactionHash
      );
      if (existing.length > 0) {
        throw new DuplicateTransactionError(
          record.transactionHash,
          existing[0].correlationId
        );
      }
    }

    // Step 2: Persist with retry logic (Requirement 6.5)
    const ttl = this.calculateTtl(record.timestamp);
    const recordWithTtl = { ...record, ttl };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.deps.store.put(recordWithTtl);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Wait with exponential backoff before next retry (1s, 2s, 4s)
        if (attempt < MAX_RETRIES - 1) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          await this.sleep(delayMs);
        }
      }
    }

    // Step 3: All retries exhausted — emit critical alert and preserve in memory (Requirement 6.6)
    this.unpersistedRecords.push(record);

    await this.deps.alertEmitter.emitCriticalAlert({
      correlationId: record.correlationId,
      reason: `All ${MAX_RETRIES} persistence retries exhausted: ${lastError?.message || 'Unknown error'}`,
      record,
    });

    throw new AuditPersistenceError(
      record.correlationId,
      lastError?.message || 'Unknown error'
    );
  }

  /**
   * Query audit records by time range with optional agent filter.
   *
   * - Uses GSI1 (sourceAgentId + timestamp) when agent filter is provided
   * - Otherwise scans by timestamp range
   * - Returns descending timestamp order
   * - Maximum 10,000 results
   * - Must complete within 5 seconds
   *
   * Requirement: 6.4
   */
  async query(params: AuditQuery): Promise<AuditRecord[]> {
    const limit = Math.min(params.limit || MAX_QUERY_RESULTS, MAX_QUERY_RESULTS);

    if (params.agentId) {
      // Use GSI1 for agent-filtered queries
      return this.deps.store.queryByAgentAndTimeRange({
        agentId: params.agentId,
        startTime: params.startTime,
        endTime: params.endTime,
        limit,
      });
    }

    // Scan by timestamp range
    return this.deps.store.queryByTimeRange({
      startTime: params.startTime,
      endTime: params.endTime,
      limit,
    });
  }

  /**
   * Flag a transaction for manual review.
   *
   * Updates the record's status to 'pending_review' with the provided reason.
   *
   * Requirement: 4.4
   */
  async flagForReview(correlationId: string, reason: string): Promise<void> {
    // Retrieve the record to get its timestamp (needed for composite key update)
    const record = await this.deps.store.getByCorrelationId(correlationId);
    if (!record) {
      throw new Error(
        `Audit record not found for correlationId: ${correlationId}`
      );
    }

    await this.deps.store.updateStatus({
      correlationId,
      timestamp: record.timestamp,
      status: 'pending_review',
      reason,
    });
  }

  /**
   * Calculate TTL epoch for 90-day retention (Requirement 6.3).
   */
  private calculateTtl(timestamp: string): number {
    const recordTime = new Date(timestamp).getTime();
    const ttlMs = AUDIT_TTL_DAYS * 24 * 60 * 60 * 1000;
    return Math.floor((recordTime + ttlMs) / 1000);
  }

  /**
   * Sleep for the specified duration (used for exponential backoff).
   * Protected to allow overriding in tests.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
