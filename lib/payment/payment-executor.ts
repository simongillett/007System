/**
 * Payment Executor implementation for x402 micropayment execution.
 *
 * Handles the full payment cycle:
 * 1. Extract payment requirements from HTTP 402 response headers
 * 2. Validate all required fields are present
 * 3. Check spending policy (via SpendingPolicyEngine)
 * 4. Check wallet balance (sufficient USDC)
 * 5. Check 10 USDC per-transaction cap
 * 6. Submit on-chain payment (via OnChainClient)
 * 7. Replay original request with payment receipt (via HttpClient)
 * 8. Return result (or error at any step)
 *
 * Error codes:
 * - MISSING_FIELDS — required fields absent in 402 response
 * - INSUFFICIENT_BALANCE — wallet doesn't have enough USDC
 * - EXCEEDS_TRANSACTION_LIMIT — amount > 10 USDC cap
 * - NO_SPENDING_POLICY — no policy defined for agent
 * - EXCEEDS_CUMULATIVE_LIMIT — cumulative 24h limit exceeded
 * - ON_CHAIN_FAILURE — on-chain transaction failed
 * - REPLAY_FAILED — replay after successful payment failed (includes tx hash + original request)
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

import {
  PaymentExecutor,
  PaymentRequest,
  PaymentResult,
  PaymentRequirements,
  HttpResponse,
  ValidationResult,
} from '../types/payment';
import { SpendingPolicyEngine } from '../types/spending-policy';
import { WalletManager } from '../types/wallet';

// --- Dependency Interfaces ---

/**
 * Interface for submitting on-chain USDC transactions via CDP SDK.
 */
export interface OnChainClient {
  /**
   * Submit a USDC transfer on-chain.
   * Returns the transaction hash on success.
   * Throws OnChainTransactionError on failure.
   */
  submitPayment(params: {
    fromAgentId: string;
    recipientAddress: string;
    amount: string;
    network: 'base';
  }): Promise<{ transactionHash: string }>;
}

/**
 * Interface for replaying HTTP requests with payment receipts.
 */
export interface HttpClient {
  /**
   * Replay the original request with the payment receipt attached.
   * Returns the response from the merchant endpoint.
   */
  replayWithReceipt(params: {
    originalRequest: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    };
    receipt: {
      transactionHash: string;
      amount: string;
      recipientAddress: string;
      network: 'base';
    };
  }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }>;
}

// --- Error Types ---

export class OnChainTransactionError extends Error {
  public readonly transactionHash?: string;
  public readonly reason: string;

  constructor(reason: string, transactionHash?: string) {
    super(`On-chain transaction failed: ${reason}`);
    this.name = 'OnChainTransactionError';
    this.reason = reason;
    this.transactionHash = transactionHash;
  }
}

export class ReplayError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(`Replay request failed: ${reason}`);
    this.name = 'ReplayError';
    this.reason = reason;
  }
}

// --- Constants ---

/** Maximum USDC amount per transaction (Requirement 3.3) */
const MAX_TRANSACTION_USDC = 10;

// --- Header Keys for x402 Payment Requirements ---

const HEADER_RECIPIENT = 'x-payment-recipient';
const HEADER_AMOUNT = 'x-payment-amount';
const HEADER_ASSET = 'x-payment-asset';
const HEADER_NETWORK = 'x-payment-network';
const HEADER_PAYMENT_ID = 'x-payment-id';
const HEADER_EXPIRES_AT = 'x-payment-expires-at';

// --- Dependencies Container ---

export interface PaymentExecutorDependencies {
  spendingPolicyEngine: SpendingPolicyEngine;
  walletManager: WalletManager;
  onChainClient: OnChainClient;
  httpClient: HttpClient;
}

// --- Implementation ---

/**
 * Default Payment Executor implementation.
 *
 * Orchestrates the full x402 payment cycle with dependency injection
 * for all external services.
 */
export class DefaultPaymentExecutor implements PaymentExecutor {
  private readonly deps: PaymentExecutorDependencies;

  constructor(deps: PaymentExecutorDependencies) {
    this.deps = deps;
  }

  /**
   * Extract payment requirements from an HTTP 402 response.
   *
   * Parses the response headers for recipient address, amount, asset type,
   * network, payment ID, and optional expiration.
   *
   * Returns null if the response is not a 402 or lacks the minimum required headers.
   *
   * Requirement: 3.1
   */
  extractRequirements(response: HttpResponse): PaymentRequirements | null {
    if (response.statusCode !== 402) {
      return null;
    }

    // Normalize headers to lowercase for case-insensitive lookup
    const headers = normalizeHeaders(response.headers);

    const recipientAddress = headers[HEADER_RECIPIENT];
    const amount = headers[HEADER_AMOUNT];
    const asset = headers[HEADER_ASSET];
    const network = headers[HEADER_NETWORK];
    const paymentId = headers[HEADER_PAYMENT_ID];
    const expiresAt = headers[HEADER_EXPIRES_AT];

    // If none of the payment headers are present, return null
    if (!recipientAddress && !amount && !asset && !paymentId) {
      return null;
    }

    // Build requirements with whatever is available
    return {
      recipientAddress: recipientAddress || '',
      amount: amount || '',
      asset: (asset as 'USDC') || 'USDC',
      network: (network as 'base') || 'base',
      paymentId: paymentId || '',
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  /**
   * Validate that all required payment fields are present.
   *
   * Required fields: recipientAddress, amount, asset, network, paymentId
   *
   * Requirement: 3.2
   */
  validateRequirements(requirements: PaymentRequirements): ValidationResult {
    const missingFields: string[] = [];

    if (!requirements.recipientAddress) {
      missingFields.push('recipientAddress');
    }
    if (!requirements.amount) {
      missingFields.push('amount');
    }
    if (!requirements.asset) {
      missingFields.push('asset');
    }
    if (!requirements.network) {
      missingFields.push('network');
    }
    if (!requirements.paymentId) {
      missingFields.push('paymentId');
    }

    if (missingFields.length > 0) {
      return { valid: false, missingFields };
    }

    return { valid: true };
  }

  /**
   * Execute the full x402 payment cycle.
   *
   * Steps:
   * 1. Validate payment requirements fields (Requirement 3.2)
   * 2. Check spending policy (Requirements 5.3, 5.4, 5.5, 5.7)
   * 3. Check wallet balance (Requirement 3.3)
   * 4. Check 10 USDC per-transaction cap (Requirement 3.3)
   * 5. Submit on-chain payment (Requirement 3.5)
   * 6. Replay original request with receipt (Requirement 3.5)
   * 7. Return result or error
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
   */
  async executePayment(request: PaymentRequest): Promise<PaymentResult> {
    const { requestingAgentId, paymentRequirements, originalRequest } = request;

    // Step 1: Validate required fields (Requirement 3.2)
    const validation = this.validateRequirements(paymentRequirements);
    if (!validation.valid) {
      return {
        status: 'rejected',
        error: {
          code: 'MISSING_FIELDS',
          message: `Payment requirements missing required fields: ${validation.missingFields!.join(', ')}`,
        },
      };
    }

    const paymentAmount = parseFloat(paymentRequirements.amount);

    // Step 2: Check spending policy (Requirements 5.3, 5.4, 5.5, 5.7)
    const policyEvaluation = await this.deps.spendingPolicyEngine.evaluate(
      requestingAgentId,
      paymentRequirements.amount
    );

    if (!policyEvaluation.approved) {
      const errorCode = mapPolicyRejectionToErrorCode(
        policyEvaluation.rejectionReason!
      );
      return {
        status: 'rejected',
        error: {
          code: errorCode,
          message: getPolicyRejectionMessage(
            policyEvaluation.rejectionReason!,
            paymentRequirements.amount,
            policyEvaluation
          ),
        },
      };
    }

    // Step 3: Check wallet balance (Requirement 3.3)
    const walletBalance = await this.deps.walletManager.getBalance(
      requestingAgentId
    );
    const balance = parseFloat(walletBalance.balance);

    if (balance < paymentAmount) {
      return {
        status: 'rejected',
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Insufficient USDC balance. Required: ${paymentRequirements.amount}, Available: ${walletBalance.balance}`,
        },
      };
    }

    // Step 4: Check 10 USDC per-transaction cap (Requirement 3.3, 3.4)
    if (paymentAmount > MAX_TRANSACTION_USDC) {
      return {
        status: 'rejected',
        error: {
          code: 'EXCEEDS_TRANSACTION_LIMIT',
          message: `Payment amount ${paymentRequirements.amount} USDC exceeds the ${MAX_TRANSACTION_USDC} USDC per-transaction cap`,
        },
      };
    }

    // Step 5: Submit on-chain payment (Requirement 3.5, 3.8)
    let transactionHash: string;
    try {
      const result = await this.deps.onChainClient.submitPayment({
        fromAgentId: requestingAgentId,
        recipientAddress: paymentRequirements.recipientAddress,
        amount: paymentRequirements.amount,
        network: paymentRequirements.network,
      });
      transactionHash = result.transactionHash;
    } catch (error) {
      const txError = error as OnChainTransactionError;
      return {
        status: 'failed',
        transactionHash: txError.transactionHash,
        error: {
          code: 'ON_CHAIN_FAILURE',
          message: `On-chain payment failed: ${txError.reason || (error instanceof Error ? error.message : 'Unknown error')}`,
          transactionHash: txError.transactionHash,
        },
      };
    }

    // Step 6: Replay original request with payment receipt (Requirement 3.5, 3.6)
    try {
      const replayResponse = await this.deps.httpClient.replayWithReceipt({
        originalRequest,
        receipt: {
          transactionHash,
          amount: paymentRequirements.amount,
          recipientAddress: paymentRequirements.recipientAddress,
          network: paymentRequirements.network,
        },
      });

      // Success — payment settled and replay succeeded
      return {
        status: 'settled',
        transactionHash,
        replayResponse,
      };
    } catch (error) {
      // Replay failed after successful on-chain payment (Requirement 3.6)
      const replayError = error as ReplayError;
      const reason =
        replayError.reason ||
        (error instanceof Error ? error.message : 'Unknown replay error');

      return {
        status: 'failed',
        transactionHash,
        error: {
          code: 'REPLAY_FAILED',
          message: `Replay failed after successful payment: ${reason}`,
          transactionHash,
          originalRequest,
        },
      };
    }
  }
}

// --- Utility Functions ---

/**
 * Normalize HTTP headers to lowercase keys for case-insensitive lookup.
 */
function normalizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

/**
 * Map spending policy rejection reasons to PaymentErrorCode.
 */
function mapPolicyRejectionToErrorCode(
  reason: 'PER_TRANSACTION_EXCEEDED' | 'CUMULATIVE_EXCEEDED' | 'NO_POLICY'
):
  | 'NO_SPENDING_POLICY'
  | 'EXCEEDS_TRANSACTION_LIMIT'
  | 'EXCEEDS_CUMULATIVE_LIMIT' {
  switch (reason) {
    case 'NO_POLICY':
      return 'NO_SPENDING_POLICY';
    case 'PER_TRANSACTION_EXCEEDED':
      return 'EXCEEDS_TRANSACTION_LIMIT';
    case 'CUMULATIVE_EXCEEDED':
      return 'EXCEEDS_CUMULATIVE_LIMIT';
  }
}

/**
 * Generate a human-readable message for policy rejection.
 */
function getPolicyRejectionMessage(
  reason: 'PER_TRANSACTION_EXCEEDED' | 'CUMULATIVE_EXCEEDED' | 'NO_POLICY',
  amount: string,
  evaluation: {
    perTransactionLimit: string;
    cumulativeSpent24h: string;
    cumulativeLimit: string;
  }
): string {
  switch (reason) {
    case 'NO_POLICY':
      return 'No spending policy configured for this agent';
    case 'PER_TRANSACTION_EXCEEDED':
      return `Payment amount ${amount} USDC exceeds per-transaction limit of ${evaluation.perTransactionLimit} USDC`;
    case 'CUMULATIVE_EXCEEDED':
      return `Payment would exceed cumulative 24h limit. Current spend: ${evaluation.cumulativeSpent24h} USDC, Limit: ${evaluation.cumulativeLimit} USDC, Requested: ${amount} USDC`;
  }
}
