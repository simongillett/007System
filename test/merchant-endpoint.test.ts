/**
 * Unit tests for the Merchant Endpoint Lambda@Edge handler.
 *
 * Tests cover:
 * - handleRequest: 402 response for unpaid requests
 * - handleRequest: pass-through for valid receipts
 * - handleRequest: 402 with failure reason for invalid receipts
 * - handleRequest: 503 for verification unavailable/timeout
 * - generatePaymentRequirements: correct payment requirements generation
 * - verifyReceipt: on-chain verification with double-redemption check
 *
 * Requirements: 7.2, 7.3, 7.4, 7.5, 7.6
 */

import {
  DefaultMerchantEndpoint,
  MerchantEndpointDependencies,
  OnChainVerifier,
  RedeemedReceiptsStore,
  PricingConfig,
  VerificationUnavailableError,
} from '../lib/merchant/merchant-endpoint';
import {
  CloudFrontRequest,
  MerchantEndpointConfig,
  PaymentReceipt,
} from '../lib/types/merchant';

// --- Test Helpers ---

function createMockDependencies(overrides?: Partial<MerchantEndpointDependencies>): MerchantEndpointDependencies {
  const defaultPricing: MerchantEndpointConfig = {
    endpointPath: '/data/market-feed',
    priceUsdc: '0.50',
    recipientAgentId: 'agent-data-provider',
    recipientWalletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    description: 'Market feed data',
    capabilityTags: ['market-data'],
  };

  return {
    onChainVerifier: {
      verify: jest.fn().mockResolvedValue({ valid: true }),
    },
    redeemedReceiptsStore: {
      isRedeemed: jest.fn().mockResolvedValue(false),
      markRedeemed: jest.fn().mockResolvedValue(undefined),
    },
    pricingConfig: {
      getPricing: jest.fn().mockImplementation((path: string) => {
        if (path.startsWith('/data/')) {
          return defaultPricing;
        }
        return null;
      }),
    },
    ...overrides,
  };
}

function createRequest(uri: string, receiptValue?: string): CloudFrontRequest {
  const headers: Record<string, Array<{ key: string; value: string }>> = {};

  if (receiptValue) {
    headers['x-402-receipt'] = [{ key: 'X-402-Receipt', value: receiptValue }];
  }

  return {
    uri,
    method: 'GET',
    headers,
  };
}

function createValidReceipt(): PaymentReceipt {
  return {
    transactionHash: '0xabc123def456',
    amount: '0.50',
    recipientAddress: '0x1234567890abcdef1234567890abcdef12345678',
    network: 'base',
    blockNumber: 12345,
    timestamp: new Date().toISOString(),
  };
}

// --- Tests ---

describe('DefaultMerchantEndpoint', () => {
  describe('handleRequest', () => {
    it('should return 402 with payment requirements when no receipt is present', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const request = createRequest('/data/market-feed');

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      expect(response.statusDescription).toBe('Payment Required');
      expect(response.headers['x-402-price']?.[0]?.value).toBe('0.50');
      expect(response.headers['x-402-network']?.[0]?.value).toBe('base');
      expect(response.headers['x-402-recipient']?.[0]?.value).toBe(
        '0x1234567890abcdef1234567890abcdef12345678'
      );
      expect(response.headers['x-402-asset']?.[0]?.value).toBe('USDC');
    });

    it('should pass through when no pricing is configured for the path', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const request = createRequest('/free/resource');

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('200');
      expect(response.headers['x-402-status']?.[0]?.value).toBe('verified');
    });

    it('should pass through and mark as redeemed when receipt is valid', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('200');
      expect(deps.redeemedReceiptsStore.markRedeemed).toHaveBeenCalledWith(
        receipt.transactionHash,
        '/data/market-feed'
      );
    });

    it('should return 402 with INVALID_AMOUNT reason when amount is wrong', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockResolvedValue({ valid: false, reason: 'INVALID_AMOUNT' }),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      receipt.amount = '0.25'; // Wrong amount
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      expect(response.headers['x-402-failure-reason']?.[0]?.value).toBe('INVALID_AMOUNT');
      const body = JSON.parse(response.body!);
      expect(body.reason).toBe('INVALID_AMOUNT');
    });

    it('should return 402 with WRONG_RECIPIENT reason when recipient is wrong', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockResolvedValue({ valid: false, reason: 'WRONG_RECIPIENT' }),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      receipt.recipientAddress = '0xwrongaddress';
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      expect(response.headers['x-402-failure-reason']?.[0]?.value).toBe('WRONG_RECIPIENT');
    });

    it('should return 402 with EXPIRED reason when receipt is expired', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockResolvedValue({ valid: false, reason: 'EXPIRED' }),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      expect(response.headers['x-402-failure-reason']?.[0]?.value).toBe('EXPIRED');
    });

    it('should return 402 with ALREADY_REDEEMED reason when receipt was already used', async () => {
      const deps = createMockDependencies({
        redeemedReceiptsStore: {
          isRedeemed: jest.fn().mockResolvedValue(true),
          markRedeemed: jest.fn().mockResolvedValue(undefined),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      expect(response.headers['x-402-failure-reason']?.[0]?.value).toBe('ALREADY_REDEEMED');
    });

    it('should return 503 when on-chain verification is unavailable', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockRejectedValue(
            new VerificationUnavailableError('Chain unreachable')
          ),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('503');
      expect(response.statusDescription).toBe('Service Unavailable');
      const body = JSON.parse(response.body!);
      expect(body.message).toContain('temporarily unavailable');
      expect(body.message).toContain('not been consumed');
    });

    it('should return 503 when on-chain verification times out', async () => {
      // Simulate a timeout by making verify never resolve within the timeout
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockImplementation(
            () => new Promise((_, reject) => {
              setTimeout(() => reject(new VerificationUnavailableError('Timeout')), 50);
            })
          ),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('503');
    });

    it('should return 402 when receipt JSON is malformed', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const request = createRequest('/data/market-feed', 'not-valid-json');

      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe('402');
      const body = JSON.parse(response.body!);
      expect(body.error).toContain('Invalid receipt format');
    });

    it('should not mark receipt as redeemed when verification fails', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockResolvedValue({ valid: false, reason: 'INVALID_AMOUNT' }),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      await endpoint.handleRequest(request);

      expect(deps.redeemedReceiptsStore.markRedeemed).not.toHaveBeenCalled();
    });

    it('should not consume receipt when returning 503', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockRejectedValue(new VerificationUnavailableError()),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const request = createRequest('/data/market-feed', JSON.stringify(receipt));

      await endpoint.handleRequest(request);

      expect(deps.redeemedReceiptsStore.markRedeemed).not.toHaveBeenCalled();
    });
  });

  describe('generatePaymentRequirements', () => {
    it('should return correct payment requirements for a configured path', () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);

      const requirements = endpoint.generatePaymentRequirements('/data/market-feed');

      expect(requirements.amount).toBe('0.50');
      expect(requirements.asset).toBe('USDC');
      expect(requirements.network).toBe('base');
      expect(requirements.recipientAddress).toBe(
        '0x1234567890abcdef1234567890abcdef12345678'
      );
      expect(requirements.paymentId).toBeTruthy();
      expect(requirements.paymentId).toMatch(/^pay_/);
    });

    it('should return default requirements for unconfigured path', () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);

      const requirements = endpoint.generatePaymentRequirements('/unknown/path');

      expect(requirements.amount).toBe('0');
      expect(requirements.asset).toBe('USDC');
      expect(requirements.network).toBe('base');
    });
  });

  describe('verifyReceipt', () => {
    it('should return valid when receipt passes all checks', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();

      const result = await endpoint.verifyReceipt(receipt);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return ALREADY_REDEEMED when receipt was previously used', async () => {
      const deps = createMockDependencies({
        redeemedReceiptsStore: {
          isRedeemed: jest.fn().mockResolvedValue(true),
          markRedeemed: jest.fn().mockResolvedValue(undefined),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();

      const result = await endpoint.verifyReceipt(receipt);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('ALREADY_REDEEMED');
    });

    it('should return VERIFICATION_TIMEOUT when redemption check fails', async () => {
      const deps = createMockDependencies({
        redeemedReceiptsStore: {
          isRedeemed: jest.fn().mockRejectedValue(new Error('DynamoDB unavailable')),
          markRedeemed: jest.fn().mockResolvedValue(undefined),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();

      const result = await endpoint.verifyReceipt(receipt);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('VERIFICATION_TIMEOUT');
    });

    it('should return VERIFICATION_TIMEOUT when on-chain verifier throws', async () => {
      const deps = createMockDependencies({
        onChainVerifier: {
          verify: jest.fn().mockRejectedValue(new VerificationUnavailableError()),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();

      const result = await endpoint.verifyReceipt(receipt);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('VERIFICATION_TIMEOUT');
    });

    it('should pass expected amount and recipient from config to verifier', async () => {
      const deps = createMockDependencies();
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();
      const config: MerchantEndpointConfig = {
        endpointPath: '/data/market-feed',
        priceUsdc: '1.00',
        recipientAgentId: 'agent-1',
        recipientWalletAddress: '0xexpectedrecipient',
        description: 'Test',
        capabilityTags: ['test'],
      };

      await endpoint.verifyReceipt(receipt, config);

      expect(deps.onChainVerifier.verify).toHaveBeenCalledWith(
        receipt,
        '1.00',
        '0xexpectedrecipient'
      );
    });

    it('should check redemption before on-chain verification', async () => {
      const callOrder: string[] = [];
      const deps = createMockDependencies({
        redeemedReceiptsStore: {
          isRedeemed: jest.fn().mockImplementation(async () => {
            callOrder.push('isRedeemed');
            return true;
          }),
          markRedeemed: jest.fn().mockResolvedValue(undefined),
        },
        onChainVerifier: {
          verify: jest.fn().mockImplementation(async () => {
            callOrder.push('verify');
            return { valid: true };
          }),
        },
      });
      const endpoint = new DefaultMerchantEndpoint(deps);
      const receipt = createValidReceipt();

      await endpoint.verifyReceipt(receipt);

      // Should check redemption first and not call on-chain verify
      expect(callOrder).toEqual(['isRedeemed']);
      expect(deps.onChainVerifier.verify).not.toHaveBeenCalled();
    });
  });
});
