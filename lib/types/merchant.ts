/**
 * Merchant Endpoint interfaces for x402 paywalled services.
 * Handles payment receipt verification and content serving via CloudFront + Lambda@Edge.
 */

import { PaymentRequirements } from './payment';

export interface MerchantEndpointConfig {
  endpointPath: string;
  priceUsdc: string;
  recipientAgentId: string;
  recipientWalletAddress: string;
  description: string;
  capabilityTags: string[];
}

export interface PaymentReceipt {
  transactionHash: string;
  amount: string;
  recipientAddress: string;
  network: 'base';
  blockNumber: number;
  timestamp: string;
}

export type ReceiptInvalidReason =
  | 'INVALID_AMOUNT'
  | 'WRONG_RECIPIENT'
  | 'EXPIRED'
  | 'ALREADY_REDEEMED'
  | 'VERIFICATION_TIMEOUT';

export interface ReceiptVerification {
  valid: boolean;
  reason?: ReceiptInvalidReason;
}

export interface CloudFrontRequest {
  uri: string;
  method: string;
  headers: Record<string, Array<{ key: string; value: string }>>;
  body?: {
    data: string;
    encoding: 'base64' | 'text';
  };
}

export interface CloudFrontResponse {
  status: string;
  statusDescription: string;
  headers: Record<string, Array<{ key: string; value: string }>>;
  body?: string;
}

export interface MerchantEndpoint {
  handleRequest(request: CloudFrontRequest): Promise<CloudFrontResponse>;
  verifyReceipt(receipt: PaymentReceipt): Promise<ReceiptVerification>;
  generatePaymentRequirements(path: string): PaymentRequirements;
}
