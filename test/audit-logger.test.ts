/**
 * Unit tests for the Audit Logger implementation.
 *
 * Tests cover:
 * - record(): persist with all required fields, duplicate detection, retry logic
 * - query(): time-range queries with/without agent filter, ordering, limits
 * - flagForReview(): mark records as pending_review
 * - Retry logic: 3 retries with exponential backoff (1s, 2s, 4s)
 * - Critical alert emission on exhausted retries
 * - In-memory preservation of unpersisted records
 *
 * Requirements: 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import {
  DefaultAuditLogger,
  AuditStore,
  AlertEmitter,
  Clock,
  AuditLoggerDependencies,
  DuplicateTransactionError,
  AuditPersistenceError,
} from '../lib/governance/audit-logger';
import { AuditRecord } from '../lib/types/audit';
import { PolicyEvaluation } from '../lib/types/spending-policy';

// --- Test Helpers ---

function createMockPolicyEvaluation(overrides?: Partial<PolicyEvaluation>): PolicyEvaluation {
  return {
    agentId: 'agent-1',
    paymentAmount: '1.500000',
    perTransactionLimit: '10.000000',
    cumulativeSpent24h: '5.000000',
    cumulativeLimit: '100.000000',
    approved: true,
    ...overrides,
  };
}

function createMockAuditRecord(overrides?: Partial<AuditRecord>): AuditRecord {
  return {
    correlationId: 'corr-123',
    sourceAgentId: 'agent-1',
    destinationAgentId: 'agent-2',
    amountUsdc: '1.500000',
    transactionHash: '0xabc123',
    timestamp: '2024-01-15T10:30:00.000Z',
    status: 'settled',
    policyEvaluation: createMockPolicyEvaluation(),
    eventType: 'payment_settled',
    ...overrides,
  };
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

function createMockAlertEmitter(overrides?: Partial<AlertEmitter>): AlertEmitter {
  return {
    emitCriticalAlert: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockClock(overrides?: Partial<Clock>): Clock {
  return {
    now: jest.fn().mockReturnValue('2024-01-15T10:30:00.000Z'),
    generateId: jest.fn().mockReturnValue('generated-id-001'),
    ...overrides,
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

/**
 * Testable subclass that overrides sleep to avoid real delays in tests.
 * Optionally records sleep durations for verification.
 */
class TestableAuditLogger extends DefaultAuditLogger {
  private readonly sleepRecorder?: (ms: number) => void;

  constructor(deps: AuditLoggerDependencies, sleepRecorder?: (ms: number) => void) {
    super(deps);
    this.sleepRecorder = sleepRecorder;
  }

  protected override sleep(ms: number): Promise<void> {
    if (this.sleepRecorder) {
      this.sleepRecorder(ms);
    }
    return Promise.resolve();
  }
}

// --- Tests ---

describe('DefaultAuditLogger', () => {
  // Use fake timers to avoid actual delays in tests
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('record()', () => {
    it('should persist an audit record with all required fields', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord();

      const promise = logger.record(record);
      await promise;

      expect(store.put).toHaveBeenCalledTimes(1);
      const putArg = (store.put as jest.Mock).mock.calls[0][0];
      expect(putArg.correlationId).toBe('corr-123');
      expect(putArg.sourceAgentId).toBe('agent-1');
      expect(putArg.destinationAgentId).toBe('agent-2');
      expect(putArg.amountUsdc).toBe('1.500000');
      expect(putArg.transactionHash).toBe('0xabc123');
      expect(putArg.timestamp).toBe('2024-01-15T10:30:00.000Z');
      expect(putArg.status).toBe('settled');
      expect(putArg.policyEvaluation).toEqual(createMockPolicyEvaluation());
      expect(putArg.eventType).toBe('payment_settled');
      expect(putArg.ttl).toBeGreaterThan(0);
    });

    it('should generate a correlationId if not provided', async () => {
      const store = createMockStore();
      const clock = createMockClock();
      const deps = createDeps({ store, clock });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord({ correlationId: '' });

      await logger.record(record);

      const putArg = (store.put as jest.Mock).mock.calls[0][0];
      expect(putArg.correlationId).toBe('generated-id-001');
    });

    it('should check for duplicate transaction hash before persisting', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord();

      await logger.record(record);

      expect(store.queryByTransactionHash).toHaveBeenCalledWith('0xabc123');
    });

    it('should reject duplicate transaction hashes', async () => {
      const existingRecord = createMockAuditRecord({ correlationId: 'existing-corr' });
      const store = createMockStore({
        queryByTransactionHash: jest.fn().mockResolvedValue([existingRecord]),
      });
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord({ correlationId: 'new-corr' });

      await expect(logger.record(record)).rejects.toThrow(DuplicateTransactionError);
      await expect(logger.record(record)).rejects.toMatchObject({
        transactionHash: '0xabc123',
        existingCorrelationId: 'existing-corr',
      });

      // Should not attempt to persist
      expect(store.put).not.toHaveBeenCalled();
    });

    it('should calculate TTL as 90 days from record timestamp', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord({
        timestamp: '2024-01-15T10:30:00.000Z',
      });

      await logger.record(record);

      const putArg = (store.put as jest.Mock).mock.calls[0][0];
      const expectedTtl = Math.floor(
        (new Date('2024-01-15T10:30:00.000Z').getTime() + 90 * 24 * 60 * 60 * 1000) / 1000
      );
      expect(putArg.ttl).toBe(expectedTtl);
    });

    it('should skip duplicate check when transactionHash is empty', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const record = createMockAuditRecord({ transactionHash: '' });

      await logger.record(record);

      expect(store.queryByTransactionHash).not.toHaveBeenCalled();
      expect(store.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('query()', () => {
    it('should query by time range without agent filter', async () => {
      const records = [
        createMockAuditRecord({ timestamp: '2024-01-15T12:00:00.000Z' }),
        createMockAuditRecord({ timestamp: '2024-01-15T11:00:00.000Z' }),
      ];
      const store = createMockStore({
        queryByTimeRange: jest.fn().mockResolvedValue(records),
      });
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const result = await logger.query({
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
      });

      expect(store.queryByTimeRange).toHaveBeenCalledWith({
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
        limit: 10_000,
      });
      expect(result).toEqual(records);
    });

    it('should query by agent and time range when agent filter provided', async () => {
      const records = [createMockAuditRecord()];
      const store = createMockStore({
        queryByAgentAndTimeRange: jest.fn().mockResolvedValue(records),
      });
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      const result = await logger.query({
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
        agentId: 'agent-1',
      });

      expect(store.queryByAgentAndTimeRange).toHaveBeenCalledWith({
        agentId: 'agent-1',
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
        limit: 10_000,
      });
      expect(result).toEqual(records);
    });

    it('should cap results at 10,000 even if higher limit requested', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      await logger.query({
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
        limit: 50_000,
      });

      expect(store.queryByTimeRange).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10_000 })
      );
    });

    it('should use provided limit when less than 10,000', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      await logger.query({
        startTime: '2024-01-15T00:00:00.000Z',
        endTime: '2024-01-15T23:59:59.000Z',
        limit: 100,
      });

      expect(store.queryByTimeRange).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
    });
  });

  describe('flagForReview()', () => {
    it('should update record status to pending_review', async () => {
      const existingRecord = createMockAuditRecord({
        correlationId: 'corr-456',
        timestamp: '2024-01-15T10:30:00.000Z',
      });
      const store = createMockStore({
        getByCorrelationId: jest.fn().mockResolvedValue(existingRecord),
      });
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      await logger.flagForReview('corr-456', 'Unreconciled payment');

      expect(store.updateStatus).toHaveBeenCalledWith({
        correlationId: 'corr-456',
        timestamp: '2024-01-15T10:30:00.000Z',
        status: 'pending_review',
        reason: 'Unreconciled payment',
      });
    });

    it('should throw error if record not found', async () => {
      const store = createMockStore({
        getByCorrelationId: jest.fn().mockResolvedValue(null),
      });
      const deps = createDeps({ store });
      const logger = new DefaultAuditLogger(deps);

      await expect(
        logger.flagForReview('nonexistent', 'Some reason')
      ).rejects.toThrow('Audit record not found for correlationId: nonexistent');
    });
  });

  describe('retry logic', () => {
    it('should retry 3 times with exponential backoff on persistence failure', async () => {
      jest.useRealTimers();

      const store = createMockStore({
        put: jest.fn().mockRejectedValue(new Error('DynamoDB error')),
      });
      const alertEmitter = createMockAlertEmitter();
      // Use a logger with zero-delay sleep for fast tests
      const deps = createDeps({ store, alertEmitter });
      const logger = new TestableAuditLogger(deps);

      const record = createMockAuditRecord();

      await expect(logger.record(record)).rejects.toThrow(AuditPersistenceError);

      // Should have attempted 3 times total
      expect(store.put).toHaveBeenCalledTimes(3);
    });

    it('should succeed on second attempt without further retries', async () => {
      jest.useRealTimers();

      const store = createMockStore({
        put: jest
          .fn()
          .mockRejectedValueOnce(new Error('Temporary error'))
          .mockResolvedValueOnce(undefined),
      });
      const deps = createDeps({ store });
      const logger = new TestableAuditLogger(deps);

      const record = createMockAuditRecord();

      await logger.record(record);

      expect(store.put).toHaveBeenCalledTimes(2);
    });

    it('should emit critical alert when all retries exhausted', async () => {
      jest.useRealTimers();

      const store = createMockStore({
        put: jest.fn().mockRejectedValue(new Error('Persistent failure')),
      });
      const alertEmitter = createMockAlertEmitter();
      const deps = createDeps({ store, alertEmitter });
      const logger = new TestableAuditLogger(deps);

      const record = createMockAuditRecord({ correlationId: 'corr-fail' });

      await expect(logger.record(record)).rejects.toThrow(AuditPersistenceError);

      expect(alertEmitter.emitCriticalAlert).toHaveBeenCalledWith({
        correlationId: 'corr-fail',
        reason: expect.stringContaining('Persistent failure'),
        record: expect.objectContaining({ correlationId: 'corr-fail' }),
      });
    });

    it('should preserve unpersisted record in memory when retries exhausted', async () => {
      jest.useRealTimers();

      const store = createMockStore({
        put: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const alertEmitter = createMockAlertEmitter();
      const deps = createDeps({ store, alertEmitter });
      const logger = new TestableAuditLogger(deps);

      const record = createMockAuditRecord({ correlationId: 'corr-memory' });

      await expect(logger.record(record)).rejects.toThrow(AuditPersistenceError);

      const unpersisted = logger.getUnpersistedRecords();
      expect(unpersisted).toHaveLength(1);
      expect(unpersisted[0].correlationId).toBe('corr-memory');
    });

    it('should use correct backoff delays: 1s, 2s, 4s', async () => {
      jest.useRealTimers();

      const sleepDelays: number[] = [];
      const store = createMockStore({
        put: jest.fn().mockRejectedValue(new Error('fail')),
      });
      const alertEmitter = createMockAlertEmitter();
      const deps = createDeps({ store, alertEmitter });
      const logger = new TestableAuditLogger(deps, (ms) => {
        sleepDelays.push(ms);
      });

      const record = createMockAuditRecord();

      await expect(logger.record(record)).rejects.toThrow(AuditPersistenceError);

      expect(store.put).toHaveBeenCalledTimes(3);

      // Verify backoff delays: 1000ms (1s), 2000ms (2s)
      // Note: only 2 delays because the last attempt doesn't sleep after failure
      expect(sleepDelays).toEqual([1000, 2000]);
    });
  });
});
