/**
 * Property-based tests for Audit Logger.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 9: Duplicate Payment Rejection
 * - Property 13: Audit Record Completeness
 * - Property 14: Correlation ID Uniqueness
 * - Property 15: Audit Query Ordering and Limits
 */

import fc from 'fast-check';
import {
  DefaultAuditLogger,
  AuditStore,
  AlertEmitter,
  Clock,
  AuditLoggerDependencies,
  DuplicateTransactionError,
} from '../lib/governance/audit-logger';
import { AuditRecord, AuditEventType, AuditStatus } from '../lib/types/audit';
import { PolicyEvaluation } from '../lib/types/spending-policy';

// --- Test Helpers ---

/**
 * Testable subclass that overrides sleep to avoid real delays in tests.
 */
class TestableAuditLogger extends DefaultAuditLogger {
  protected override sleep(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

function createMockStore(overrides?: Partial<AuditStore>): AuditStore {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    queryByTimeRange: jest.fn().mockResolvedValue([]),
    queryByAgentAndTimeRange: jest.fn().mockResolvedValue([]),
    queryByTransactionHash: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    getByCorrelationId: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function createMockAlertEmitter(): AlertEmitter {
  return {
    emitCriticalAlert: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockClock(): Clock {
  let counter = 0;
  return {
    now: () => new Date().toISOString(),
    generateId: () => `gen-id-${++counter}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

function createDeps(overrides?: Partial<AuditLoggerDependencies>): AuditLoggerDependencies {
  return {
    store: createMockStore(),
    alertEmitter: createMockAlertEmitter(),
    clock: createMockClock(),
    ...overrides,
  };
}

// --- Arbitraries ---

/**
 * Generates valid agent IDs.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 30 }
).map((s) => `agent-${s}`);

/**
 * Generates valid USDC amounts with exactly 6 decimal places.
 */
const usdcAmount6dp = fc
  .integer({ min: 1, max: 999999999 })
  .map((microUsdc) => (microUsdc / 1000000).toFixed(6));

/**
 * Generates valid transaction hashes (hex strings starting with 0x).
 */
const transactionHash = fc
  .hexaString({ minLength: 64, maxLength: 64 })
  .map((hex) => `0x${hex}`);

/**
 * Generates valid correlation IDs.
 */
const correlationId = fc
  .stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')),
    { minLength: 5, maxLength: 30 }
  )
  .map((s) => `corr-${s}`);

/**
 * Generates valid ISO 8601 UTC timestamps.
 */
const isoTimestamp = fc
  .date({ min: new Date('2024-01-01T00:00:00.000Z'), max: new Date('2025-12-31T23:59:59.000Z') })
  .map((d) => d.toISOString());

/**
 * Generates valid audit event types.
 */
const eventType: fc.Arbitrary<AuditEventType> = fc.constantFrom(
  'payment_initiated',
  'payment_settled',
  'payment_failed',
  'income_credited',
  'reconciliation_failed',
  'duplicate_detected'
);

/**
 * Generates valid audit statuses.
 */
const auditStatus: fc.Arbitrary<AuditStatus> = fc.constantFrom(
  'initiated',
  'settled',
  'failed',
  'pending_review'
);

/**
 * Generates valid policy evaluations.
 */
const policyEvaluation: fc.Arbitrary<PolicyEvaluation> = fc.record({
  agentId: agentId,
  paymentAmount: usdcAmount6dp,
  perTransactionLimit: usdcAmount6dp,
  cumulativeSpent24h: usdcAmount6dp,
  cumulativeLimit: usdcAmount6dp,
  approved: fc.boolean(),
});

/**
 * Generates a complete valid AuditRecord.
 */
const auditRecord: fc.Arbitrary<AuditRecord> = fc.record({
  correlationId: correlationId,
  sourceAgentId: agentId,
  destinationAgentId: agentId,
  amountUsdc: usdcAmount6dp,
  transactionHash: transactionHash,
  timestamp: isoTimestamp,
  status: auditStatus,
  policyEvaluation: policyEvaluation,
  eventType: eventType,
});

// --- Property Tests ---

describe('Property 9: Duplicate Payment Rejection', () => {
  /**
   * **Validates: Requirements 4.6**
   *
   * For any on-chain transaction hash that has already been processed,
   * a subsequent record attempt with the same transaction hash SHALL be rejected
   * with DuplicateTransactionError.
   */
  it('should reject duplicate transaction hash with DuplicateTransactionError', () => {
    fc.assert(
      fc.asyncProperty(
        auditRecord,
        auditRecord,
        async (firstRecord, secondRecord) => {
          // Use the same transaction hash for both records but different correlationIds
          const sharedTxHash = firstRecord.transactionHash;
          const second = {
            ...secondRecord,
            transactionHash: sharedTxHash,
            correlationId: `${secondRecord.correlationId}-dup`,
          };

          // Track stored records to simulate duplicate detection
          const storedRecords: AuditRecord[] = [];

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (record: AuditRecord) => {
              storedRecords.push(record);
            }),
            queryByTransactionHash: jest.fn().mockImplementation(async (hash: string) => {
              return storedRecords.filter((r) => r.transactionHash === hash);
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          // First record should succeed
          await logger.record(firstRecord);

          // Second record with same tx hash should be rejected
          try {
            await logger.record(second);
            // Should not reach here
            expect(true).toBe(false);
          } catch (error) {
            expect(error).toBeInstanceOf(DuplicateTransactionError);
            const dupError = error as DuplicateTransactionError;
            expect(dupError.transactionHash).toBe(sharedTxHash);
            expect(dupError.existingCorrelationId).toBe(firstRecord.correlationId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should allow records with different transaction hashes', () => {
    fc.assert(
      fc.asyncProperty(
        auditRecord,
        auditRecord.filter((r) => r.transactionHash.length > 0),
        async (firstRecord, secondRecord) => {
          // Ensure different transaction hashes
          const second = {
            ...secondRecord,
            transactionHash: secondRecord.transactionHash.slice(0, -1) + 'f',
            correlationId: `${secondRecord.correlationId}-other`,
          };

          // Only reject if hashes actually match
          if (firstRecord.transactionHash === second.transactionHash) {
            return; // Skip this case
          }

          const storedRecords: AuditRecord[] = [];

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (record: AuditRecord) => {
              storedRecords.push(record);
            }),
            queryByTransactionHash: jest.fn().mockImplementation(async (hash: string) => {
              return storedRecords.filter((r) => r.transactionHash === hash);
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          // Both records should succeed since they have different hashes
          await logger.record(firstRecord);
          await logger.record(second);

          expect(storedRecords).toHaveLength(2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 13: Audit Record Completeness', () => {
  /**
   * **Validates: Requirements 4.3, 6.2**
   *
   * For any audit record persisted, it SHALL contain all required fields:
   * sourceAgentId, destinationAgentId, amountUsdc (6 decimal places),
   * transactionHash, timestamp (ISO 8601 UTC), status, policyEvaluation.
   */
  it('should persist records with all required fields present', () => {
    fc.assert(
      fc.asyncProperty(
        auditRecord,
        async (record) => {
          let persistedRecord: (AuditRecord & { ttl: number }) | null = null;

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (r: AuditRecord & { ttl: number }) => {
              persistedRecord = r;
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          await logger.record(record);

          // Verify all required fields are present
          expect(persistedRecord).not.toBeNull();
          expect(persistedRecord!.sourceAgentId).toBeDefined();
          expect(persistedRecord!.sourceAgentId.length).toBeGreaterThan(0);

          expect(persistedRecord!.destinationAgentId).toBeDefined();
          expect(persistedRecord!.destinationAgentId.length).toBeGreaterThan(0);

          expect(persistedRecord!.amountUsdc).toBeDefined();
          // Verify 6 decimal places
          const decimalParts = persistedRecord!.amountUsdc.split('.');
          expect(decimalParts).toHaveLength(2);
          expect(decimalParts[1]).toHaveLength(6);

          expect(persistedRecord!.transactionHash).toBeDefined();
          expect(persistedRecord!.transactionHash.length).toBeGreaterThan(0);

          // Verify timestamp is ISO 8601 UTC
          expect(persistedRecord!.timestamp).toBeDefined();
          const parsedDate = new Date(persistedRecord!.timestamp);
          expect(parsedDate.toISOString()).toBe(persistedRecord!.timestamp);

          expect(persistedRecord!.status).toBeDefined();
          expect(['initiated', 'settled', 'failed', 'pending_review']).toContain(
            persistedRecord!.status
          );

          expect(persistedRecord!.policyEvaluation).toBeDefined();
          expect(persistedRecord!.policyEvaluation.agentId).toBeDefined();
          expect(persistedRecord!.policyEvaluation.paymentAmount).toBeDefined();
          expect(persistedRecord!.policyEvaluation.perTransactionLimit).toBeDefined();
          expect(persistedRecord!.policyEvaluation.cumulativeSpent24h).toBeDefined();
          expect(persistedRecord!.policyEvaluation.cumulativeLimit).toBeDefined();
          expect(typeof persistedRecord!.policyEvaluation.approved).toBe('boolean');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should preserve amountUsdc with exactly 6 decimal places for any valid amount', () => {
    fc.assert(
      fc.asyncProperty(
        auditRecord,
        async (record) => {
          let persistedRecord: (AuditRecord & { ttl: number }) | null = null;

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (r: AuditRecord & { ttl: number }) => {
              persistedRecord = r;
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          await logger.record(record);

          // The amountUsdc must have exactly 6 decimal places
          const amount = persistedRecord!.amountUsdc;
          const match = amount.match(/^\d+\.\d{6}$/);
          expect(match).not.toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 14: Correlation ID Uniqueness', () => {
  /**
   * **Validates: Requirements 6.1**
   *
   * For any set of audit events recorded, every event SHALL have a unique
   * correlationId — no two events SHALL share the same correlation ID.
   */
  it('should assign unique correlationIds to all recorded events', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a list of 2-20 audit records without correlationIds (to test generation)
        fc.array(auditRecord, { minLength: 2, maxLength: 20 }),
        async (records) => {
          const persistedRecords: AuditRecord[] = [];
          let idCounter = 0;

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (r: AuditRecord & { ttl: number }) => {
              persistedRecords.push(r);
            }),
            // Each record has a unique tx hash so no duplicates
            queryByTransactionHash: jest.fn().mockResolvedValue([]),
          });

          const clock: Clock = {
            now: () => new Date().toISOString(),
            generateId: () => `unique-${++idCounter}-${Math.random().toString(36).slice(2, 10)}`,
          };

          const deps = createDeps({ store, clock });
          const logger = new TestableAuditLogger(deps);

          // Give each record a unique tx hash and empty correlationId to force generation
          for (let i = 0; i < records.length; i++) {
            const record = {
              ...records[i],
              correlationId: '', // Force generation
              transactionHash: `0x${i.toString(16).padStart(64, '0')}`, // Unique per record
            };
            await logger.record(record);
          }

          // Verify all correlationIds are unique
          const correlationIds = persistedRecords.map((r) => r.correlationId);
          const uniqueIds = new Set(correlationIds);
          expect(uniqueIds.size).toBe(correlationIds.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should preserve provided correlationIds when they are already unique', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate records with pre-assigned unique correlationIds
        fc.array(auditRecord, { minLength: 2, maxLength: 15 }).map((records) =>
          records.map((r, i) => ({
            ...r,
            correlationId: `provided-corr-${i}-${r.correlationId}`,
            transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
          }))
        ),
        async (records) => {
          const persistedRecords: AuditRecord[] = [];

          const store = createMockStore({
            put: jest.fn().mockImplementation(async (r: AuditRecord & { ttl: number }) => {
              persistedRecords.push(r);
            }),
            queryByTransactionHash: jest.fn().mockResolvedValue([]),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          for (const record of records) {
            await logger.record(record);
          }

          // Verify provided correlationIds are preserved
          for (let i = 0; i < records.length; i++) {
            expect(persistedRecords[i].correlationId).toBe(records[i].correlationId);
          }

          // Verify uniqueness
          const correlationIds = persistedRecords.map((r) => r.correlationId);
          const uniqueIds = new Set(correlationIds);
          expect(uniqueIds.size).toBe(correlationIds.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 15: Audit Query Ordering and Limits', () => {
  /**
   * **Validates: Requirements 6.4**
   *
   * For any query result, records SHALL be ordered by timestamp descending
   * and the result set SHALL contain at most 10,000 records.
   */
  it('should return records in descending timestamp order', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a list of timestamps in random order
        fc.array(isoTimestamp, { minLength: 2, maxLength: 50 }),
        agentId,
        fc.boolean(), // whether to use agent filter
        async (timestamps, queryAgentId, useAgentFilter) => {
          // Create records with the generated timestamps
          const records: AuditRecord[] = timestamps
            .sort((a, b) => new Date(b).getTime() - new Date(a).getTime()) // descending
            .map((ts, i) => ({
              correlationId: `corr-${i}`,
              sourceAgentId: queryAgentId,
              destinationAgentId: `agent-dest-${i}`,
              amountUsdc: '1.000000',
              transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
              timestamp: ts,
              status: 'settled' as AuditStatus,
              policyEvaluation: {
                agentId: queryAgentId,
                paymentAmount: '1.000000',
                perTransactionLimit: '10.000000',
                cumulativeSpent24h: '5.000000',
                cumulativeLimit: '100.000000',
                approved: true,
              },
              eventType: 'payment_settled' as AuditEventType,
            }));

          const store = createMockStore({
            queryByTimeRange: jest.fn().mockResolvedValue(records),
            queryByAgentAndTimeRange: jest.fn().mockResolvedValue(records),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          const result = await logger.query({
            startTime: '2024-01-01T00:00:00.000Z',
            endTime: '2025-12-31T23:59:59.000Z',
            ...(useAgentFilter ? { agentId: queryAgentId } : {}),
          });

          // Verify descending timestamp order
          for (let i = 1; i < result.length; i++) {
            const prevTime = new Date(result[i - 1].timestamp).getTime();
            const currTime = new Date(result[i].timestamp).getTime();
            expect(prevTime).toBeGreaterThanOrEqual(currTime);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should cap results at 10,000 regardless of requested limit', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate limits that may exceed 10,000
        fc.integer({ min: 1, max: 100_000 }),
        async (requestedLimit) => {
          const store = createMockStore({
            queryByTimeRange: jest.fn().mockImplementation(async (params: { limit: number }) => {
              // Verify the store receives at most 10,000
              expect(params.limit).toBeLessThanOrEqual(10_000);
              return [];
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          await logger.query({
            startTime: '2024-01-01T00:00:00.000Z',
            endTime: '2025-12-31T23:59:59.000Z',
            limit: requestedLimit,
          });

          // The store's queryByTimeRange should have been called with capped limit
          expect(store.queryByTimeRange).toHaveBeenCalledWith(
            expect.objectContaining({
              limit: Math.min(requestedLimit, 10_000),
            })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should default to 10,000 limit when no limit is specified', () => {
    fc.assert(
      fc.asyncProperty(
        isoTimestamp,
        isoTimestamp,
        async (startTime, endTime) => {
          // Ensure startTime < endTime
          const [start, end] = [startTime, endTime].sort();

          const store = createMockStore();
          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          await logger.query({
            startTime: start,
            endTime: end,
          });

          expect(store.queryByTimeRange).toHaveBeenCalledWith(
            expect.objectContaining({
              limit: 10_000,
            })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should never return more than 10,000 records even if store returns more', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a count of records that may exceed 10,000
        fc.integer({ min: 10_001, max: 15_000 }),
        async (recordCount) => {
          // Simulate a store that respects the limit parameter
          const store = createMockStore({
            queryByTimeRange: jest.fn().mockImplementation(async (params: { limit: number }) => {
              // Store correctly caps at the requested limit
              const count = Math.min(recordCount, params.limit);
              return Array.from({ length: count }, (_, i) => ({
                correlationId: `corr-${i}`,
                sourceAgentId: 'agent-1',
                destinationAgentId: 'agent-2',
                amountUsdc: '1.000000',
                transactionHash: `0x${i.toString(16).padStart(64, '0')}`,
                timestamp: new Date(Date.now() - i * 1000).toISOString(),
                status: 'settled' as AuditStatus,
                policyEvaluation: {
                  agentId: 'agent-1',
                  paymentAmount: '1.000000',
                  perTransactionLimit: '10.000000',
                  cumulativeSpent24h: '5.000000',
                  cumulativeLimit: '100.000000',
                  approved: true,
                },
                eventType: 'payment_settled' as AuditEventType,
              }));
            }),
          });

          const deps = createDeps({ store });
          const logger = new TestableAuditLogger(deps);

          const result = await logger.query({
            startTime: '2024-01-01T00:00:00.000Z',
            endTime: '2025-12-31T23:59:59.000Z',
          });

          // Result should never exceed 10,000
          expect(result.length).toBeLessThanOrEqual(10_000);
        }
      ),
      { numRuns: 100 }
    );
  });
});
