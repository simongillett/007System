/**
 * Property-based tests for Merchant Endpoint.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 16: Merchant 402 Response Correctness
 * - Property 17: Receipt Verification Correctness
 * - Property 18: Pricing Configuration Validation
 */

import fc from 'fast-check';
import {
  DefaultMerchantEndpoint,
  MerchantEndpointDependencies,
  OnChainVerifier,
  RedeemedReceiptsStore,
  PricingConfig,
} from '../lib/merchant/merchant-endpoint';
import {
  CloudFrontRequest,
  MerchantEndpointConfig,
  PaymentReceipt,
  ReceiptInvalidReason,
} from '../lib/types/merchant';
import { MerchantStack, EndpointPricingConfig } from '../lib/merchant-stack';
import * as cdk from 'aws-cdk-lib';

// --- Arbitraries ---

/**
 * Generates valid EVM wallet addresses (0x + 40 hex chars).
 */
const evmAddress = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((hex) => `0x${hex}`);

/**
 * Generates valid USDC prices in the merchant endpoint range [0.01, 10,000].
 * Uses integer cents to avoid floating-point precision issues.
 */
const validMerchantPrice = fc
  .integer({ min: 1, max: 1000000 }) // 0.01 to 10,000.00 in cents
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates prices below the minimum (< 0.01).
 */
const belowMinPrice = fc.oneof(
  fc.constant('0'),
  fc.constant('0.00'),
  fc.constant('0.001'),
  fc.constant('0.009'),
  fc.constant('-1.00'),
  fc.constant('-0.01')
);

/**
 * Generates prices above the maximum (> 10,000).
 */
const aboveMaxPrice = fc.oneof(
  fc.constant('10000.01'),
  fc.constant('10001.00'),
  fc.constant('50000.00'),
  fc.constant('999999.99')
);

/**
 * Generates valid endpoint paths.
 */
const endpointPath = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
    minLength: 1,
    maxLength: 30,
  })
  .map((s) => `/${s}`);

/**
 * Generates valid agent IDs.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 50 }
);

/**
 * Generates valid transaction hashes.
 */
const transactionHash = fc
  .hexaString({ minLength: 64, maxLength: 64 })
  .map((hex) => `0x${hex}`);

/**
 * Generates valid block numbers.
 */
const blockNumber = fc.integer({ min: 1, max: 100000000 });

/**
 * Generates a valid MerchantEndpointConfig.
 */
const merchantEndpointConfig = fc.tuple(endpointPath, validMerchantPrice, agentId, evmAddress).map(
  ([path, price, agentIdVal, address]): MerchantEndpointConfig => ({
    endpointPath: path,
    priceUsdc: price,
    recipientAgentId: agentIdVal,
    recipientWalletAddress: address,
    description: 'Test endpoint',
    capabilityTags: ['test'],
  })
);

/**
 * Generates a valid PaymentReceipt.
 */
const validReceipt = fc
  .tuple(transactionHash, validMerchantPrice, evmAddress, blockNumber)
  .map(([txHash, amount, recipient, block]): PaymentReceipt => ({
    transactionHash: txHash,
    amount,
    recipientAddress: recipient,
    network: 'base',
    blockNumber: block,
    timestamp: new Date().toISOString(),
  }));

/**
 * Generates one of the invalid receipt reasons (excluding VERIFICATION_TIMEOUT).
 */
const invalidReceiptReason: fc.Arbitrary<'INVALID_AMOUNT' | 'WRONG_RECIPIENT' | 'EXPIRED' | 'ALREADY_REDEEMED'> =
  fc.constantFrom('INVALID_AMOUNT', 'WRONG_RECIPIENT', 'EXPIRED', 'ALREADY_REDEEMED');

// --- Test Helpers ---

function createPricingConfig(config: MerchantEndpointConfig): PricingConfig {
  return {
    getPricing: (path: string) => {
      if (path === config.endpointPath || path.startsWith(config.endpointPath)) {
        return config;
      }
      return null;
    },
  };
}

function createRequest(uri: string, receiptValue?: string): CloudFrontRequest {
  const headers: Record<string, Array<{ key: string; value: string }>> = {};
  if (receiptValue) {
    headers['x-402-receipt'] = [{ key: 'X-402-Receipt', value: receiptValue }];
  }
  return { uri, method: 'GET', headers };
}

function createDeps(overrides: Partial<MerchantEndpointDependencies>): MerchantEndpointDependencies {
  return {
    onChainVerifier: {
      verify: jest.fn().mockResolvedValue({ valid: true }),
    },
    redeemedReceiptsStore: {
      isRedeemed: jest.fn().mockResolvedValue(false),
      markRedeemed: jest.fn().mockResolvedValue(undefined),
    },
    pricingConfig: {
      getPricing: jest.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

// --- Property Tests ---

describe('Property 16: Merchant 402 Response Correctness', () => {
  /**
   * **Validates: Requirements 7.2**
   *
   * For any request arriving at a Merchant Endpoint without a valid payment receipt,
   * the response SHALL be HTTP 402 and SHALL include payment requirement headers
   * specifying the price in USDC, the accepted network (Base), and the recipient
   * payment address.
   */
  it('should return 402 with price, network, and recipient for any unpaid request to a configured endpoint', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        async (config) => {
          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          // Request without a receipt
          const request = createRequest(config.endpointPath);
          const response = await endpoint.handleRequest(request);

          // Must be 402
          expect(response.status).toBe('402');

          // Must include x-402-price header with the configured price
          const priceHeader = response.headers['x-402-price']?.[0]?.value;
          expect(priceHeader).toBe(config.priceUsdc);

          // Must include x-402-network header with 'base'
          const networkHeader = response.headers['x-402-network']?.[0]?.value;
          expect(networkHeader).toBe('base');

          // Must include x-402-recipient header with the configured wallet address
          const recipientHeader = response.headers['x-402-recipient']?.[0]?.value;
          expect(recipientHeader).toBe(config.recipientWalletAddress);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return 402 with correct asset type (USDC) for any unpaid request', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        async (config) => {
          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath);
          const response = await endpoint.handleRequest(request);

          expect(response.status).toBe('402');
          const assetHeader = response.headers['x-402-asset']?.[0]?.value;
          expect(assetHeader).toBe('USDC');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should include a payment ID in the 402 response for any unpaid request', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        async (config) => {
          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath);
          const response = await endpoint.handleRequest(request);

          expect(response.status).toBe('402');
          const paymentIdHeader = response.headers['x-402-payment-id']?.[0]?.value;
          expect(paymentIdHeader).toBeTruthy();
          expect(paymentIdHeader).toMatch(/^pay_/);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 17: Receipt Verification Correctness', () => {
  /**
   * **Validates: Requirements 7.3, 7.4, 7.5**
   *
   * For any x402 payment receipt presented to a Merchant Endpoint:
   * - If valid (correct amount, correct recipient, not expired, not previously redeemed) → serve data (200)
   * - If invalid → return HTTP 402 with the specific validation failure reason
   */
  it('should serve data (200) for any valid receipt', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        validReceipt,
        async (config, receipt) => {
          // Make the receipt match the config
          receipt.amount = config.priceUsdc;
          receipt.recipientAddress = config.recipientWalletAddress;

          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
            onChainVerifier: {
              verify: jest.fn().mockResolvedValue({ valid: true }),
            },
            redeemedReceiptsStore: {
              isRedeemed: jest.fn().mockResolvedValue(false),
              markRedeemed: jest.fn().mockResolvedValue(undefined),
            },
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath, JSON.stringify(receipt));
          const response = await endpoint.handleRequest(request);

          // Valid receipt → pass through (200)
          expect(response.status).toBe('200');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return 402 with specific reason for any invalid receipt', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        validReceipt,
        invalidReceiptReason,
        async (config, receipt, reason) => {
          // Configure deps based on the invalid reason
          const isAlreadyRedeemed = reason === 'ALREADY_REDEEMED';
          const onChainResult = isAlreadyRedeemed
            ? { valid: true } // Won't be reached if already redeemed
            : { valid: false, reason: reason as 'INVALID_AMOUNT' | 'WRONG_RECIPIENT' | 'EXPIRED' };

          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
            onChainVerifier: {
              verify: jest.fn().mockResolvedValue(onChainResult),
            },
            redeemedReceiptsStore: {
              isRedeemed: jest.fn().mockResolvedValue(isAlreadyRedeemed),
              markRedeemed: jest.fn().mockResolvedValue(undefined),
            },
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath, JSON.stringify(receipt));
          const response = await endpoint.handleRequest(request);

          // Invalid receipt → 402 with failure reason
          expect(response.status).toBe('402');
          const failureReason = response.headers['x-402-failure-reason']?.[0]?.value;
          expect(failureReason).toBe(reason);

          // Body should also contain the reason
          const body = JSON.parse(response.body!);
          expect(body.reason).toBe(reason);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should not mark receipt as redeemed when verification fails', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        validReceipt,
        fc.constantFrom('INVALID_AMOUNT', 'WRONG_RECIPIENT', 'EXPIRED') as fc.Arbitrary<'INVALID_AMOUNT' | 'WRONG_RECIPIENT' | 'EXPIRED'>,
        async (config, receipt, reason) => {
          const markRedeemedFn = jest.fn().mockResolvedValue(undefined);

          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
            onChainVerifier: {
              verify: jest.fn().mockResolvedValue({ valid: false, reason }),
            },
            redeemedReceiptsStore: {
              isRedeemed: jest.fn().mockResolvedValue(false),
              markRedeemed: markRedeemedFn,
            },
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath, JSON.stringify(receipt));
          await endpoint.handleRequest(request);

          // Should NOT mark as redeemed when verification fails
          expect(markRedeemedFn).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should mark receipt as redeemed only when verification succeeds', () => {
    fc.assert(
      fc.asyncProperty(
        merchantEndpointConfig,
        validReceipt,
        async (config, receipt) => {
          const markRedeemedFn = jest.fn().mockResolvedValue(undefined);

          const deps = createDeps({
            pricingConfig: createPricingConfig(config),
            onChainVerifier: {
              verify: jest.fn().mockResolvedValue({ valid: true }),
            },
            redeemedReceiptsStore: {
              isRedeemed: jest.fn().mockResolvedValue(false),
              markRedeemed: markRedeemedFn,
            },
          });
          const endpoint = new DefaultMerchantEndpoint(deps);

          const request = createRequest(config.endpointPath, JSON.stringify(receipt));
          await endpoint.handleRequest(request);

          // Should mark as redeemed when verification succeeds
          expect(markRedeemedFn).toHaveBeenCalledWith(
            receipt.transactionHash,
            config.endpointPath
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 18: Pricing Configuration Validation', () => {
  /**
   * **Validates: Requirements 7.7**
   *
   * For any endpoint pricing configuration:
   * - Prices in [0.01, 10,000] USDC are accepted
   * - Prices outside this range are rejected
   */
  it('should accept any price in [0.01, 10,000] USDC', () => {
    fc.assert(
      fc.property(
        validMerchantPrice,
        evmAddress,
        agentId,
        (price, address, agentIdVal) => {
          const app = new cdk.App();

          const pricingConfig: EndpointPricingConfig[] = [
            {
              path: '/data/test',
              priceUsdc: price,
              recipientWalletAddress: address,
              recipientAgentId: agentIdVal,
            },
          ];

          // Should not throw — valid price
          expect(() => {
            new MerchantStack(app, `TestStack-${Math.random().toString(36).slice(2)}`, {
              endpointPricing: pricingConfig,
            });
          }).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any price below 0.01 USDC', () => {
    fc.assert(
      fc.property(
        belowMinPrice,
        evmAddress,
        agentId,
        (price, address, agentIdVal) => {
          const app = new cdk.App();

          const pricingConfig: EndpointPricingConfig[] = [
            {
              path: '/data/test',
              priceUsdc: price,
              recipientWalletAddress: address,
              recipientAgentId: agentIdVal,
            },
          ];

          // Should throw — invalid price
          expect(() => {
            new MerchantStack(app, `TestStack-${Math.random().toString(36).slice(2)}`, {
              endpointPricing: pricingConfig,
            });
          }).toThrow(/Invalid price/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any price above 10,000 USDC', () => {
    fc.assert(
      fc.property(
        aboveMaxPrice,
        evmAddress,
        agentId,
        (price, address, agentIdVal) => {
          const app = new cdk.App();

          const pricingConfig: EndpointPricingConfig[] = [
            {
              path: '/data/test',
              priceUsdc: price,
              recipientWalletAddress: address,
              recipientAgentId: agentIdVal,
            },
          ];

          // Should throw — invalid price
          expect(() => {
            new MerchantStack(app, `TestStack-${Math.random().toString(36).slice(2)}`, {
              endpointPricing: pricingConfig,
            });
          }).toThrow(/Invalid price/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept boundary prices: 0.01 and 10,000.00 USDC', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('0.01', '10000.00'),
        evmAddress,
        agentId,
        (price, address, agentIdVal) => {
          const app = new cdk.App();

          const pricingConfig: EndpointPricingConfig[] = [
            {
              path: '/data/test',
              priceUsdc: price,
              recipientWalletAddress: address,
              recipientAgentId: agentIdVal,
            },
          ];

          // Boundary values should be accepted
          expect(() => {
            new MerchantStack(app, `TestStack-${Math.random().toString(36).slice(2)}`, {
              endpointPricing: pricingConfig,
            });
          }).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });
});
