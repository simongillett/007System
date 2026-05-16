/**
 * Merchant Endpoint Lambda@Edge handler implementation.
 *
 * Implements the MerchantEndpoint interface for x402 paywalled services:
 * 1. Check if request has a payment receipt header
 * 2. If no receipt → return 402 with payment requirements (price, network=Base, recipient address)
 * 3. If receipt present → verify on-chain:
 *    - Correct amount paid
 *    - Correct recipient address
 *    - Not expired
 *    - Not previously redeemed (check Redeemed Receipts DynamoDB table)
 * 4. If valid → mark as redeemed in DynamoDB, pass through to serve content
 * 5. If invalid → return 402 with specific failure reason
 * 6. If verification unavailable/timeout (30s) → return 503 without consuming receipt
 *
 * Uses dependency injection for:
 * - OnChainVerifier (interface for on-chain receipt verification)
 * - RedeemedReceiptsStore (interface for DynamoDB operations)
 * - PricingConfig (endpoint pricing lookup)
 *
 * Requirements: 7.2, 7.3, 7.4, 7.5, 7.6
 */

import {
  MerchantEndpoint,
  MerchantEndpointConfig,
  PaymentReceipt,
  ReceiptVerification,
  ReceiptInvalidReason,
  CloudFrontRequest,
  CloudFrontResponse,
} from '../types/merchant';
import { PaymentRequirements } from '../types/payment';

// --- Dependency Interfaces ---

/**
 * Interface for on-chain receipt verification.
 * Verifies that a payment receipt is valid on the Base network.
 */
export interface OnChainVerifier {
  /**
   * Verify a payment receipt on-chain.
   * Checks correct amount, correct recipient, and expiration.
   * Throws VerificationUnavailableError if the chain is unreachable.
   */
  verify(receipt: PaymentReceipt, expectedAmount: string, expectedRecipient: string): Promise<{
    valid: boolean;
    reason?: 'INVALID_AMOUNT' | 'WRONG_RECIPIENT' | 'EXPIRED';
  }>;
}

/**
 * Interface for the Redeemed Receipts DynamoDB table operations.
 * Prevents double-redemption of payment receipts.
 */
export interface RedeemedReceiptsStore {
  /**
   * Check if a receipt (by transaction hash) has already been redeemed.
   * Returns true if the receipt was previously redeemed.
   */
  isRedeemed(transactionHash: string): Promise<boolean>;

  /**
   * Mark a receipt as redeemed in the store.
   * Records the transaction hash, redemption timestamp, and endpoint path.
   */
  markRedeemed(transactionHash: string, endpointPath: string): Promise<void>;
}

/**
 * Interface for endpoint pricing configuration lookup.
 * Returns pricing config for a given request path.
 */
export interface PricingConfig {
  /**
   * Look up pricing configuration for a given URI path.
   * Returns null if no pricing is configured for the path (pass-through).
   */
  getPricing(path: string): MerchantEndpointConfig | null;
}

// --- Error Types ---

/**
 * Thrown when on-chain verification is unavailable or times out.
 */
export class VerificationUnavailableError extends Error {
  constructor(message: string = 'On-chain verification unavailable') {
    super(message);
    this.name = 'VerificationUnavailableError';
  }
}

// --- Constants ---

/** x402 payment receipt header name */
const RECEIPT_HEADER = 'x-402-receipt';

/** Verification timeout in milliseconds (Requirement 7.6) */
const VERIFICATION_TIMEOUT_MS = 30_000;

// --- Dependencies Container ---

export interface MerchantEndpointDependencies {
  onChainVerifier: OnChainVerifier;
  redeemedReceiptsStore: RedeemedReceiptsStore;
  pricingConfig: PricingConfig;
}

// --- Implementation ---

/**
 * Default Merchant Endpoint implementation.
 *
 * Handles x402 paywall logic for CloudFront Lambda@Edge:
 * - Returns 402 with payment requirements for unpaid requests
 * - Verifies payment receipts on-chain with 30s timeout
 * - Prevents double-redemption via DynamoDB
 * - Returns 503 when verification is unavailable
 */
export class DefaultMerchantEndpoint implements MerchantEndpoint {
  private readonly deps: MerchantEndpointDependencies;

  constructor(deps: MerchantEndpointDependencies) {
    this.deps = deps;
  }

  /**
   * Handle an incoming CloudFront request.
   *
   * Flow:
   * 1. Look up pricing for the request path
   * 2. If no pricing configured → pass through (return request as-is response)
   * 3. Check for payment receipt header
   * 4. If no receipt → return 402 with payment requirements
   * 5. If receipt present → verify on-chain with 30s timeout
   * 6. If valid → mark as redeemed, pass through
   * 7. If invalid → return 402 with specific failure reason
   * 8. If verification unavailable/timeout → return 503
   *
   * Requirements: 7.2, 7.3, 7.4, 7.5, 7.6
   */
  async handleRequest(request: CloudFrontRequest): Promise<CloudFrontResponse> {
    const uri = request.uri;

    // Step 1: Look up pricing for this path
    const pricing = this.deps.pricingConfig.getPricing(uri);

    // Step 2: No pricing configured → pass through
    if (!pricing) {
      return this.createPassThroughResponse();
    }

    // Step 3: Check for payment receipt header
    const receiptHeader = request.headers[RECEIPT_HEADER];
    const receiptValue = receiptHeader?.[0]?.value;

    if (!receiptValue) {
      // Step 4: No receipt → return 402 with payment requirements
      return this.create402Response(
        this.generatePaymentRequirements(uri),
        'Payment Required'
      );
    }

    // Step 5: Parse and verify receipt
    let receipt: PaymentReceipt;
    try {
      receipt = JSON.parse(receiptValue);
    } catch {
      // Malformed receipt → return 402 with invalid reason
      return this.create402Response(
        this.generatePaymentRequirements(uri),
        'Invalid receipt format'
      );
    }

    // Verify the receipt
    const verification = await this.verifyReceipt(receipt, pricing);

    if (verification.valid) {
      // Step 6: Valid receipt → mark as redeemed and pass through
      await this.deps.redeemedReceiptsStore.markRedeemed(
        receipt.transactionHash,
        uri
      );
      return this.createPassThroughResponse();
    }

    // Step 7 & 8: Handle invalid receipt or verification unavailable
    if (verification.reason === 'VERIFICATION_TIMEOUT') {
      // Return 503 without consuming the receipt (Requirement 7.6)
      return this.create503Response();
    }

    // Return 402 with specific failure reason (Requirements 7.4, 7.5)
    return this.create402WithReasonResponse(
      this.generatePaymentRequirements(uri),
      verification.reason!
    );
  }

  /**
   * Verify a payment receipt on-chain.
   *
   * Checks:
   * 1. Not previously redeemed (DynamoDB lookup)
   * 2. Correct amount, correct recipient, not expired (on-chain verification)
   *
   * Returns verification result with specific failure reason.
   * If on-chain verification is unavailable or times out (30s), returns VERIFICATION_TIMEOUT.
   *
   * Requirements: 7.3, 7.4, 7.5, 7.6
   */
  async verifyReceipt(
    receipt: PaymentReceipt,
    config?: MerchantEndpointConfig
  ): Promise<ReceiptVerification> {
    // Step 1: Check for double-redemption (Requirement 7.5)
    try {
      const alreadyRedeemed = await this.deps.redeemedReceiptsStore.isRedeemed(
        receipt.transactionHash
      );
      if (alreadyRedeemed) {
        return { valid: false, reason: 'ALREADY_REDEEMED' };
      }
    } catch {
      // If we can't check redemption status, treat as verification unavailable
      return { valid: false, reason: 'VERIFICATION_TIMEOUT' };
    }

    // Step 2: On-chain verification with 30s timeout (Requirements 7.3, 7.6)
    // Determine expected values from config or receipt
    const expectedAmount = config?.priceUsdc ?? receipt.amount;
    const expectedRecipient = config?.recipientWalletAddress ?? receipt.recipientAddress;

    try {
      const result = await withTimeout(
        this.deps.onChainVerifier.verify(receipt, expectedAmount, expectedRecipient),
        VERIFICATION_TIMEOUT_MS
      );

      if (result.valid) {
        return { valid: true };
      }

      return { valid: false, reason: result.reason };
    } catch (error) {
      // Verification unavailable or timed out (Requirement 7.6)
      return { valid: false, reason: 'VERIFICATION_TIMEOUT' };
    }
  }

  /**
   * Generate payment requirements for a given endpoint path.
   *
   * Returns price in USDC, network (Base), and recipient payment address.
   *
   * Requirement: 7.2
   */
  generatePaymentRequirements(path: string): PaymentRequirements {
    const pricing = this.deps.pricingConfig.getPricing(path);

    if (!pricing) {
      // Default requirements for unconfigured paths (should not normally happen)
      return {
        recipientAddress: '',
        amount: '0',
        asset: 'USDC',
        network: 'base',
        paymentId: generatePaymentId(),
      };
    }

    return {
      recipientAddress: pricing.recipientWalletAddress,
      amount: pricing.priceUsdc,
      asset: 'USDC',
      network: 'base',
      paymentId: generatePaymentId(),
    };
  }

  // --- Private Helper Methods ---

  /**
   * Create a pass-through response indicating the request should proceed to origin.
   * In Lambda@Edge context, this means the request is forwarded to the backend.
   */
  private createPassThroughResponse(): CloudFrontResponse {
    return {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'x-402-status': [{ key: 'X-402-Status', value: 'verified' }],
      },
    };
  }

  /**
   * Create a 402 Payment Required response with payment requirements.
   * Requirement: 7.2
   */
  private create402Response(
    requirements: PaymentRequirements,
    description: string
  ): CloudFrontResponse {
    return {
      status: '402',
      statusDescription: 'Payment Required',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        'x-402-price': [{ key: 'X-402-Price', value: requirements.amount }],
        'x-402-network': [{ key: 'X-402-Network', value: requirements.network }],
        'x-402-recipient': [{ key: 'X-402-Recipient', value: requirements.recipientAddress }],
        'x-402-asset': [{ key: 'X-402-Asset', value: requirements.asset }],
        'x-402-payment-id': [{ key: 'X-402-Payment-Id', value: requirements.paymentId }],
      },
      body: JSON.stringify({
        error: description,
        price: requirements.amount,
        asset: requirements.asset,
        network: requirements.network,
        recipient: requirements.recipientAddress,
        paymentId: requirements.paymentId,
      }),
    };
  }

  /**
   * Create a 402 response with a specific validation failure reason.
   * Requirements: 7.4, 7.5
   */
  private create402WithReasonResponse(
    requirements: PaymentRequirements,
    reason: ReceiptInvalidReason
  ): CloudFrontResponse {
    const reasonMessages: Record<ReceiptInvalidReason, string> = {
      INVALID_AMOUNT: 'Payment receipt amount does not match the required price',
      WRONG_RECIPIENT: 'Payment receipt was sent to the wrong recipient address',
      EXPIRED: 'Payment receipt has expired',
      ALREADY_REDEEMED: 'Payment receipt has already been used',
      VERIFICATION_TIMEOUT: 'Verification temporarily unavailable',
    };

    return {
      status: '402',
      statusDescription: 'Payment Required',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        'x-402-price': [{ key: 'X-402-Price', value: requirements.amount }],
        'x-402-network': [{ key: 'X-402-Network', value: requirements.network }],
        'x-402-recipient': [{ key: 'X-402-Recipient', value: requirements.recipientAddress }],
        'x-402-asset': [{ key: 'X-402-Asset', value: requirements.asset }],
        'x-402-payment-id': [{ key: 'X-402-Payment-Id', value: requirements.paymentId }],
        'x-402-failure-reason': [{ key: 'X-402-Failure-Reason', value: reason }],
      },
      body: JSON.stringify({
        error: 'Payment Required',
        reason,
        message: reasonMessages[reason],
        price: requirements.amount,
        asset: requirements.asset,
        network: requirements.network,
        recipient: requirements.recipientAddress,
        paymentId: requirements.paymentId,
      }),
    };
  }

  /**
   * Create a 503 Service Unavailable response.
   * Returned when on-chain verification is unavailable or times out.
   * Does NOT consume the payment receipt (Requirement 7.6).
   */
  private create503Response(): CloudFrontResponse {
    return {
      status: '503',
      statusDescription: 'Service Unavailable',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        'retry-after': [{ key: 'Retry-After', value: '30' }],
      },
      body: JSON.stringify({
        error: 'Service Unavailable',
        message: 'On-chain verification is temporarily unavailable. Please retry later. Your payment receipt has not been consumed.',
      }),
    };
  }
}

// --- Utility Functions ---

/**
 * Wrap a promise with a timeout.
 * If the promise does not resolve within the specified time, rejects with a timeout error.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new VerificationUnavailableError(`Verification timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Generate a unique payment ID for tracking payment requirements.
 */
function generatePaymentId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `pay_${timestamp}_${random}`;
}
