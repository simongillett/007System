/**
 * Unit tests for Income Reconciler.
 *
 * Tests the settlement event processing flow including:
 * - Duplicate detection (Requirement 4.6)
 * - 60-second reconciliation window (Requirement 4.2)
 * - Wallet credit with 6 decimal precision (Requirement 4.1)
 * - Retry logic with exponential backoff (Requirement 4.5)
 * - Flagging unreconciled transactions for manual review (Requirement 4.4)
 */

import {
  DefaultIncomeReconciler,
  IncomeReconcilerDependencies,
  SettlementEvent,
  Clock,
  OnChainConfirmationClient,
} from '../lib/payment/income-reconciler';
import { WalletManager } from '../lib/types/wallet';
import { AuditLogger, AuditRecord } from '../lib/types/audit';
import { PolicyEvaluation } from '../lib/types/spending-policy';

// --- Test Helpers ---

function createMockClock(): Clock {
  let idCounter = 0;
  return {
    now: jest.fn(() => '2025-01-15T10:00:00.000Z'),
    generateId: jest.fn(() => `corr-${++idCounter}`),
    delay: jest.fn(() => Promise.resolve()),
  };
}

function createMockOnChainClient(
  confirmAfterCalls = 1
): OnChainConfirmationClient {
  let callCount = 0;
  return {
    isConfirmed: jest.fn(async () => {
      callCount++;
      return callCount >= confirmAfterCalls;
    }),
  };
}

function createMockWalletManager(): jest.Mocked<WalletManager> {
  return {
    provisionWallet: jest.fn(),
    getBalance: jest.fn(),
    creditWallet: jest.fn().mockResolvedValue(undefined),
    getCredentials: jest.fn(),
  };
}

function createMockAuditLogger(): jest.Mocked<AuditLogger> {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    flagForReview: jest.fn().mockResolvedValue(undefined),
  };
}

function createSettlementEvent(overrides?: Partial<SettlementEvent>): SettlementEvent {
  return {
    transactionHash: '0xabc123def456',
    sourceAgentId: 'agent-buyer',
    destinationAgentId: 'agent-merchant',
    amountUsdc: '1.500000',
    settledAt: '2025-01-15T09:59:55.000Z',
    policyEvaluation: {
      agentId: 'agent-buyer',
      paymentAmount: '1.500000',
      perTransactionLimit: '10.00',
      cumulativeSpent24h: '5.00',
      cumulativeLimit: '100.00',
      approved: true,
    } as PolicyEvaluation,
    ...overrides,
  };
}

function createDeps(overrides?: Partial<IncomeReconcilerDependencies>): IncomeReconcilerDependencies {
  return {
    walletManager: createMockWalletManager(),
    auditLogger: createMockAuditLogger(),
    clock: createMockClock(),
    onChainClient: createMockOnChainClient(1),
    ...overrides,
  };
}

// --- Tests ---

describe('DefaultIncomeReconciler', () => {
  describe('processSettlement - happy path', () => {
    it('should credit the merchant wallet when on-chain confirmation is received', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('credited');
      expect(result.transactionHash).toBe('0xabc123def456');
      expect(result.correlationId).toBe('corr-1');
      expect(deps.walletManager.creditWallet).toHaveBeenCalledWith(
        'agent-merchant',
        '1.500000',
        '0xabc123def456'
      );
    });

    it('should record the income credit in the audit log', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      await reconciler.processSettlement(event);

      expect(deps.auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'corr-1',
          sourceAgentId: 'agent-buyer',
          destinationAgentId: 'agent-merchant',
          amountUsdc: '1.500000',
          transactionHash: '0xabc123def456',
          status: 'settled',
          eventType: 'income_credited',
        })
      );
    });

    it('should preserve 6 decimal places of precision in the credit amount', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent({ amountUsdc: '0.123456' });

      await reconciler.processSettlement(event);

      expect(deps.walletManager.creditWallet).toHaveBeenCalledWith(
        'agent-merchant',
        '0.123456',
        '0xabc123def456'
      );
    });
  });

  describe('processSettlement - duplicate detection (Requirement 4.6)', () => {
    it('should reject duplicate settlement events for the same transaction hash', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      // First call succeeds
      const result1 = await reconciler.processSettlement(event);
      expect(result1.status).toBe('credited');

      // Second call with same hash is rejected as duplicate
      const result2 = await reconciler.processSettlement(event);
      expect(result2.status).toBe('duplicate');
      expect(result2.error).toContain('Duplicate settlement event');
    });

    it('should record duplicate attempts in the audit log', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      await reconciler.processSettlement(event);
      await reconciler.processSettlement(event);

      // Second call should record a duplicate_detected event
      expect(deps.auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'duplicate_detected',
          transactionHash: '0xabc123def456',
          status: 'failed',
        })
      );
    });

    it('should allow different transaction hashes', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);

      const event1 = createSettlementEvent({ transactionHash: '0xhash1' });
      const event2 = createSettlementEvent({ transactionHash: '0xhash2' });

      const result1 = await reconciler.processSettlement(event1);
      const result2 = await reconciler.processSettlement(event2);

      expect(result1.status).toBe('credited');
      expect(result2.status).toBe('credited');
    });
  });

  describe('processSettlement - reconciliation window (Requirement 4.2)', () => {
    it('should wait for on-chain confirmation before crediting', async () => {
      // Confirm after 3 polls
      const onChainClient = createMockOnChainClient(3);
      const deps = createDeps({ onChainClient });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('credited');
      expect(onChainClient.isConfirmed).toHaveBeenCalledWith('0xabc123def456');
    });

    it('should flag for manual review when confirmation not received within 60 seconds', async () => {
      // Never confirms
      const onChainClient: OnChainConfirmationClient = {
        isConfirmed: jest.fn().mockResolvedValue(false),
      };
      // Use a clock that advances time to simulate timeout
      let currentTime = 0;
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => {
        currentTime += 5_000; // Advance 5s per call
        return currentTime;
      });

      const deps = createDeps({ onChainClient });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('unreconciled');
      expect(result.error).toContain('60-second reconciliation window');
      expect(deps.auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending_review',
          eventType: 'reconciliation_failed',
        })
      );
      expect(deps.auditLogger.flagForReview).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('60-second reconciliation window')
      );

      Date.now = originalDateNow;
    });
  });

  describe('processSettlement - retry logic (Requirement 4.5)', () => {
    it('should retry credit 3 times with exponential backoff on failure', async () => {
      const walletManager = createMockWalletManager();
      walletManager.creditWallet
        .mockRejectedValueOnce(new Error('Service unavailable'))
        .mockRejectedValueOnce(new Error('Service unavailable'))
        .mockResolvedValueOnce(undefined);

      const clock = createMockClock();
      const deps = createDeps({ walletManager, clock });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('credited');
      expect(walletManager.creditWallet).toHaveBeenCalledTimes(3);
      // Verify exponential backoff delays: 1s, 2s
      expect(clock.delay).toHaveBeenCalledWith(1000);
      expect(clock.delay).toHaveBeenCalledWith(2000);
    });

    it('should flag for manual review when all 3 retries fail', async () => {
      const walletManager = createMockWalletManager();
      walletManager.creditWallet.mockRejectedValue(new Error('Service unavailable'));

      const clock = createMockClock();
      const deps = createDeps({ walletManager, clock });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Failed to credit wallet after 3 attempts');
      expect(walletManager.creditWallet).toHaveBeenCalledTimes(3);
      // Verify exponential backoff delays: 1s, 2s
      expect(clock.delay).toHaveBeenCalledWith(1000);
      expect(clock.delay).toHaveBeenCalledWith(2000);
      // Verify flagged for review
      expect(deps.auditLogger.flagForReview).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Wallet credit failed after 3 retries')
      );
    });

    it('should record failure in audit log when all retries exhausted', async () => {
      const walletManager = createMockWalletManager();
      walletManager.creditWallet.mockRejectedValue(new Error('Timeout'));

      const deps = createDeps({ walletManager });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      await reconciler.processSettlement(event);

      expect(deps.auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending_review',
          eventType: 'reconciliation_failed',
          transactionHash: '0xabc123def456',
        })
      );
    });

    it('should succeed on second retry after first failure', async () => {
      const walletManager = createMockWalletManager();
      walletManager.creditWallet
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce(undefined);

      const clock = createMockClock();
      const deps = createDeps({ walletManager, clock });
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      const result = await reconciler.processSettlement(event);

      expect(result.status).toBe('credited');
      expect(walletManager.creditWallet).toHaveBeenCalledTimes(2);
      // Only one backoff delay (1s before second attempt)
      expect(clock.delay).toHaveBeenCalledWith(1000);
    });
  });

  describe('processSettlement - audit logging', () => {
    it('should include all required fields in the audit record', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);
      const event = createSettlementEvent();

      await reconciler.processSettlement(event);

      expect(deps.auditLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: expect.any(String),
          sourceAgentId: 'agent-buyer',
          destinationAgentId: 'agent-merchant',
          amountUsdc: '1.500000',
          transactionHash: '0xabc123def456',
          timestamp: expect.any(String),
          status: 'settled',
          policyEvaluation: expect.objectContaining({
            agentId: 'agent-buyer',
            approved: true,
          }),
          eventType: 'income_credited',
        })
      );
    });
  });

  describe('getProcessedHashes', () => {
    it('should track processed transaction hashes', async () => {
      const deps = createDeps();
      const reconciler = new DefaultIncomeReconciler(deps);

      expect(reconciler.getProcessedHashes().size).toBe(0);

      await reconciler.processSettlement(createSettlementEvent({ transactionHash: '0x111' }));
      await reconciler.processSettlement(createSettlementEvent({ transactionHash: '0x222' }));

      const hashes = reconciler.getProcessedHashes();
      expect(hashes.size).toBe(2);
      expect(hashes.has('0x111')).toBe(true);
      expect(hashes.has('0x222')).toBe(true);
    });
  });
});
