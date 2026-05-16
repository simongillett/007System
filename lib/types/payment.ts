/**
 * Payment Executor interfaces for x402 micropayment execution.
 * Handles the full payment cycle: extract requirements, enforce policies, execute on-chain, replay.
 */

export interface PaymentRequirements {
  recipientAddress: string;
  amount: string;
  asset: 'USDC';
  network: 'base';
  paymentId: string;
  expiresAt?: string;
}

export interface PaymentRequest {
  requestingAgentId: string;
  merchantEndpointUrl: string;
  paymentRequirements: PaymentRequirements;
  originalRequest: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
}

export type PaymentErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'EXCEEDS_TRANSACTION_LIMIT'
  | 'EXCEEDS_CUMULATIVE_LIMIT'
  | 'NO_SPENDING_POLICY'
  | 'MISSING_FIELDS'
  | 'ON_CHAIN_FAILURE'
  | 'REPLAY_FAILED';

export interface PaymentResult {
  status: 'settled' | 'rejected' | 'failed';
  transactionHash?: string;
  replayResponse?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
  error?: {
    code: PaymentErrorCode;
    message: string;
    transactionHash?: string;
    originalRequest?: PaymentRequest['originalRequest'];
  };
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

export interface ValidationResult {
  valid: boolean;
  missingFields?: string[];
}

export interface PaymentExecutor {
  executePayment(request: PaymentRequest): Promise<PaymentResult>;
  extractRequirements(response: HttpResponse): PaymentRequirements | null;
  validateRequirements(requirements: PaymentRequirements): ValidationResult;
}
