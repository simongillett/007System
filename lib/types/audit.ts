/**
 * Audit Logger interfaces for transaction recording and querying.
 * Records all payment events with correlation IDs and supports time-range queries.
 */

import { PolicyEvaluation } from './spending-policy';

export type AuditEventType =
  | 'payment_initiated'
  | 'payment_settled'
  | 'payment_failed'
  | 'income_credited'
  | 'reconciliation_failed'
  | 'duplicate_detected';

export type AuditStatus =
  | 'initiated'
  | 'settled'
  | 'failed'
  | 'pending_review';

export interface AuditRecord {
  correlationId: string;
  sourceAgentId: string;
  destinationAgentId: string;
  amountUsdc: string;
  transactionHash: string;
  timestamp: string;
  status: AuditStatus;
  policyEvaluation: PolicyEvaluation;
  eventType: AuditEventType;
}

export interface AuditQuery {
  startTime: string;
  endTime: string;
  agentId?: string;
  limit?: number;
}

export interface AuditLogger {
  record(event: AuditRecord): Promise<void>;
  query(params: AuditQuery): Promise<AuditRecord[]>;
  flagForReview(correlationId: string, reason: string): Promise<void>;
}
