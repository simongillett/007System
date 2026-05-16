/**
 * Integration tests for end-to-end flows.
 *
 * Tests the full system flows by wiring together actual implementations
 * with mocked external dependencies (CDP SDK, DynamoDB, on-chain clients).
 *
 * Requirements: 2.1, 2.4, 3.7, 5.6, 10.3
 */

import {
  DefaultPaymentExecutor,
  OnChainClient,
  HttpClient,
  PaymentExecutorDependencies,
} from '../lib/payment/payment-executor';
import {
  DefaultMerchantEndpoint,
  OnChainVerifier,
  RedeemedReceiptsStore,
  PricingConfig,
  MerchantEndpointDependencies,
} from '../lib/merchant/merchant-endpoint';
import {
  DefaultWalletManager,
  CdpSdkClient,
  SecretsManagerClient,
  TokenVaultClient,
  IdentityClient,
  WalletStore,
  WalletManagerDependencies,
} from '../lib/wallet/wallet-manager';
import {
  DefaultSpendingPolicyEngine,
  PolicyStore,
  TransactionStore,
  PaymentTransaction,
  SpendingPolicyEngineDependencies,
} from '../lib/payment/spending-policy-engine';
import {
  DefaultServiceRegistry,
  RegistryStore,
  RegistryClock,
  ServiceRegistryDependencies,
} from '../lib/governance/service-registry';
import { AgentWallet, WalletManagerConfig } from '../lib/types/wallet';
import { ServiceRegistryEntry } from '../lib/types/service-registry';
import { SpendingPolicy } from '../lib/types/spending-policy';
import { MerchantEndpointConfig } from '../lib/types/merchant';

// --- In-Memory Store Implementations ---

/**
 * In-memory wallet store for integration testing.
 */
class InMemoryWalletStore implements WalletStore {
  private wallets = new Map<string, AgentWallet>();

  async save(wallet: AgentWallet): Promise<void> {
    this.wallets.set(wallet.agentId, wallet);
  }

  async get(agentId: string): Promise<AgentWallet | null> {
    return this.wallets.get(agentId) || null;
  }
}

/**
 * In-memory policy store for integration testing.
 */
class InMemoryPolicyStore implements PolicyStore {
  private policies = new Map<string, SpendingPolicy>();

  async get(agentId: string): Promise<SpendingPolicy | null> {
    return this.policies.get(agentId) || null;
  }

  async put(policy: SpendingPolicy): Promise<void> {
    this.policies.set(policy.agentId, policy);
  }
}

/**
 * In-memory transaction store for integration testing.
 */
class InMemoryTransactionStore implements TransactionStore {
  private transactions: PaymentTransaction[] = [];

  async queryByAgentAndTimeRange(
    agentId: string,
    startTime: string
  ): Promise<PaymentTransaction[]> {
    return this.transactions.filter(
      (tx) => tx.agentId === agentId && tx.timestamp >= startTime
    );
  }

  addTransaction(tx: PaymentTransaction): void {
    this.transactions.push(tx);
  }
}

/**
 * In-memory registry store for integration testing.
 */
class InMemoryRegistryStore implements RegistryStore {
  private entries = new Map<string, ServiceRegistryEntry>();

  async put(entry: ServiceRegistryEntry): Promise<void> {
    this.entries.set(entry.endpointUrl, entry);
  }

  async updateStatus(params: { endpointUrl: string; status: string }): Promise<void> {
    const entry = this.entries.get(params.endpointUrl);
    if (entry) {
      entry.status = params.status as 'active' | 'decommissioned';
    }
  }

  async queryByTags(params: { tags: string[]; limit: number }): Promise<ServiceRegistryEntry[]> {
    const results: ServiceRegistryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status !== 'active') continue;
      const hasMatchingTag = entry.capabilityTags.some((tag) =>
        params.tags.includes(tag)
      );
      if (hasMatchingTag) {
        results.push(entry);
        if (results.length >= params.limit) break;
      }
    }
    return results;
  }

  async getByEndpointUrl(endpointUrl: string): Promise<ServiceRegistryEntry | null> {
    return this.entries.get(endpointUrl) || null;
  }
}

/**
 * In-memory redeemed receipts store for integration testing.
 */
class InMemoryRedeemedReceiptsStore implements RedeemedReceiptsStore {
  private redeemed = new Set<string>();

  async isRedeemed(transactionHash: string): Promise<boolean> {
    return this.redeemed.has(transactionHash);
  }

  async markRedeemed(transactionHash: string, _endpointPath: string): Promise<void> {
    this.redeemed.add(transactionHash);
  }
}

// --- Integration Tests ---

describe('Integration: Full x402 Payment Cycle', () => {
  /**
   * Tests the complete x402 payment flow:
   * 1. Merchant endpoint returns 402 with payment requirements
   * 2. Payment Executor extracts requirements, checks policy, checks balance
   * 3. Submits on-chain payment
   * 4. Replays original request with receipt
   *
   * Validates: Requirement 3.7
   */
  it('should complete full 402 → pay → replay cycle', async () => {
    // Set up in-memory stores
    const policyStore = new InMemoryPolicyStore();
    const transactionStore = new InMemoryTransactionStore();
    const walletStore = new InMemoryWalletStore();

    // Pre-provision a wallet for the agent
    const agentWallet: AgentWallet = {
      agentId: 'agent-buyer',
      walletId: 'wallet-buyer-001',
      address: '0xBuyerAddress123',
      network: 'base',
      asset: 'USDC',
      createdAt: '2024-01-01T00:00:00.000Z',
      workloadIdentityArn: 'arn:aws:identity:us-east-1:123456789:workload/agent-buyer',
      credentialProviderArn: 'arn:aws:identity:us-east-1:123456789:credential/agent-buyer',
    };
    await walletStore.save(agentWallet);

    // Set up spending policy for the agent
    await policyStore.put({
      agentId: 'agent-buyer',
      perTransactionLimitUsdc: '5.00',
      cumulativeLimitUsdc: '50.00',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Create the spending policy engine with real implementation
    const spendingPolicyEngine = new DefaultSpendingPolicyEngine({
      policyStore,
      transactionStore,
    });

    // Create wallet manager with mocked CDP SDK
    const mockCdpSdk: CdpSdkClient = {
      createWallet: jest.fn(),
      getUsdcBalance: jest.fn().mockResolvedValue('25.500000'),
      creditUsdc: jest.fn(),
    };

    const walletManager = new DefaultWalletManager(
      {
        cdpApiKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789:secret:cdp-key',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789:key/test-key',
        network: 'base',
        provisioningTimeoutMs: 30000,
      },
      {
        cdpSdk: mockCdpSdk,
        secretsManager: { createSecret: jest.fn() } as unknown as SecretsManagerClient,
        tokenVault: { retrieveCredentials: jest.fn() } as unknown as TokenVaultClient,
        identity: { createCredentialProvider: jest.fn(), createWorkloadIdentity: jest.fn() } as unknown as IdentityClient,
        walletStore,
      }
    );

    // Create on-chain client mock
    const mockOnChainClient: OnChainClient = {
      submitPayment: jest.fn().mockResolvedValue({
        transactionHash: '0xIntegrationTxHash_abc123',
      }),
    };

    // Create HTTP client mock that simulates replay success
    const mockHttpClient: HttpClient = {
      replayWithReceipt: jest.fn().mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: 'premium-market-feed', timestamp: '2024-01-01T12:00:00Z' }),
      }),
    };

    // Wire up the Payment Executor with real spending policy engine and wallet manager
    const paymentExecutor = new DefaultPaymentExecutor({
      spendingPolicyEngine,
      walletManager,
      onChainClient: mockOnChainClient,
      httpClient: mockHttpClient,
    });

    // Set up the Merchant Endpoint
    const merchantPricingConfig: PricingConfig = {
      getPricing: (path: string) => {
        if (path === '/data/market-feed') {
          return {
            endpointPath: '/data/market-feed',
            priceUsdc: '2.50',
            recipientAgentId: 'agent-seller',
            recipientWalletAddress: '0xSellerAddress456',
            description: 'Premium market feed data',
            capabilityTags: ['market-data'],
          };
        }
        return null;
      },
    };

    const merchantEndpoint = new DefaultMerchantEndpoint({
      onChainVerifier: {
        verify: jest.fn().mockResolvedValue({ valid: true }),
      },
      redeemedReceiptsStore: new InMemoryRedeemedReceiptsStore(),
      pricingConfig: merchantPricingConfig,
    });

    // --- Execute the full cycle ---

    // Step 1: Agent makes request to merchant, gets 402
    const initialRequest = {
      uri: '/data/market-feed',
      method: 'GET',
      headers: {} as Record<string, Array<{ key: string; value: string }>>,
    };
    const merchantResponse = await merchantEndpoint.handleRequest(initialRequest);

    // Verify 402 response with payment requirements
    expect(merchantResponse.status).toBe('402');
    expect(merchantResponse.headers['x-402-price']?.[0]?.value).toBe('2.50');
    expect(merchantResponse.headers['x-402-network']?.[0]?.value).toBe('base');
    expect(merchantResponse.headers['x-402-recipient']?.[0]?.value).toBe('0xSellerAddress456');

    // Step 2: Payment Executor extracts requirements from 402 response
    const httpResponse = {
      statusCode: 402,
      headers: {
        'x-payment-recipient': '0xSellerAddress456',
        'x-payment-amount': '2.50',
        'x-payment-asset': 'USDC',
        'x-payment-network': 'base',
        'x-payment-id': merchantResponse.headers['x-402-payment-id']?.[0]?.value || 'pay-int-001',
      },
    };

    const requirements = paymentExecutor.extractRequirements(httpResponse);
    expect(requirements).not.toBeNull();
    expect(requirements!.recipientAddress).toBe('0xSellerAddress456');
    expect(requirements!.amount).toBe('2.50');

    // Step 3: Execute payment (policy check → balance check → on-chain → replay)
    const startTime = Date.now();
    const paymentResult = await paymentExecutor.executePayment({
      requestingAgentId: 'agent-buyer',
      merchantEndpointUrl: 'https://merchant.example.com/data/market-feed',
      paymentRequirements: requirements!,
      originalRequest: {
        method: 'GET',
        url: 'https://merchant.example.com/data/market-feed',
        headers: { 'content-type': 'application/json' },
      },
    });
    const elapsed = Date.now() - startTime;

    // Verify full cycle completed successfully
    expect(paymentResult.status).toBe('settled');
    expect(paymentResult.transactionHash).toBe('0xIntegrationTxHash_abc123');
    expect(paymentResult.replayResponse?.statusCode).toBe(200);
    expect(JSON.parse(paymentResult.replayResponse!.body)).toHaveProperty('data', 'premium-market-feed');

    // Verify timing constraint (< 5 seconds)
    expect(elapsed).toBeLessThan(5000);

    // Verify on-chain client was called with correct params
    expect(mockOnChainClient.submitPayment).toHaveBeenCalledWith({
      fromAgentId: 'agent-buyer',
      recipientAddress: '0xSellerAddress456',
      amount: '2.50',
      network: 'base',
    });

    // Verify replay was called with receipt
    expect(mockHttpClient.replayWithReceipt).toHaveBeenCalledWith({
      originalRequest: {
        method: 'GET',
        url: 'https://merchant.example.com/data/market-feed',
        headers: { 'content-type': 'application/json' },
      },
      receipt: {
        transactionHash: '0xIntegrationTxHash_abc123',
        amount: '2.50',
        recipientAddress: '0xSellerAddress456',
        network: 'base',
      },
    });
  });
});

describe('Integration: Wallet Provisioning → Credential Retrieval via Token Vault', () => {
  /**
   * Tests the wallet provisioning flow and verifies credentials
   * are retrieved exclusively through the Token Vault.
   *
   * Validates: Requirements 2.1, 2.4
   */
  it('should provision wallet and retrieve credentials exclusively via Token Vault', async () => {
    const walletStore = new InMemoryWalletStore();

    // Mock CDP SDK - simulates wallet creation
    const mockCdpSdk: CdpSdkClient = {
      createWallet: jest.fn().mockResolvedValue({
        walletId: 'cdp-wallet-new-001',
        address: '0xNewAgentAddress789',
        apiKeyId: 'cdp-api-key-id-001',
        apiKeySecret: 'cdp-api-key-secret-001',
      }),
      getUsdcBalance: jest.fn().mockResolvedValue('0.000000'),
      creditUsdc: jest.fn(),
    };

    // Mock Secrets Manager - stores the CDP key
    const mockSecretsManager: SecretsManagerClient = {
      createSecret: jest.fn().mockResolvedValue({
        arn: 'arn:aws:secretsmanager:us-east-1:123456789:secret:trading-system/agents/agent-new/cdp-api-key',
      }),
    };

    // Mock Token Vault - the EXCLUSIVE path for credential retrieval
    const mockTokenVault: TokenVaultClient = {
      retrieveCredentials: jest.fn().mockResolvedValue({
        apiKeyId: 'cdp-api-key-id-001',
        apiKeySecret: 'cdp-api-key-secret-001',
      }),
    };

    // Mock Identity client - creates credential provider and workload identity
    const mockIdentity: IdentityClient = {
      createCredentialProvider: jest.fn().mockResolvedValue({
        credentialProviderArn: 'arn:aws:identity:us-east-1:123456789:credential/agent-new',
      }),
      createWorkloadIdentity: jest.fn().mockResolvedValue({
        workloadIdentityArn: 'arn:aws:identity:us-east-1:123456789:workload/agent-new',
      }),
    };

    const config: WalletManagerConfig = {
      cdpApiKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789:secret:cdp-master-key',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789:key/test-kms-key',
      network: 'base',
      provisioningTimeoutMs: 30000,
    };

    const walletManager = new DefaultWalletManager(config, {
      cdpSdk: mockCdpSdk,
      secretsManager: mockSecretsManager,
      tokenVault: mockTokenVault,
      identity: mockIdentity,
      walletStore,
    });

    // --- Step 1: Provision wallet ---
    const wallet = await walletManager.provisionWallet('agent-new');

    // Verify wallet was created
    expect(wallet.agentId).toBe('agent-new');
    expect(wallet.walletId).toBe('cdp-wallet-new-001');
    expect(wallet.address).toBe('0xNewAgentAddress789');
    expect(wallet.network).toBe('base');
    expect(wallet.asset).toBe('USDC');

    // Verify CDP SDK was called to create wallet
    expect(mockCdpSdk.createWallet).toHaveBeenCalledWith({ network: 'base' });

    // Verify secret was stored in Secrets Manager
    expect(mockSecretsManager.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/test-kms-key',
        description: 'CDP API key for agent agent-new',
      })
    );

    // Verify Credential Provider was created
    expect(mockIdentity.createCredentialProvider).toHaveBeenCalledWith({
      agentId: 'agent-new',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789:secret:trading-system/agents/agent-new/cdp-api-key',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789:key/test-kms-key',
    });

    // Verify Workload Identity was created
    expect(mockIdentity.createWorkloadIdentity).toHaveBeenCalledWith({
      agentId: 'agent-new',
      credentialProviderArn: 'arn:aws:identity:us-east-1:123456789:credential/agent-new',
    });

    // --- Step 2: Retrieve credentials via Token Vault ---
    const credentials = await walletManager.getCredentials('agent-new');

    // Verify credentials were retrieved
    expect(credentials.apiKeyId).toBe('cdp-api-key-id-001');
    expect(credentials.apiKeySecret).toBe('cdp-api-key-secret-001');

    // CRITICAL: Verify Token Vault was used (Requirement 2.4)
    expect(mockTokenVault.retrieveCredentials).toHaveBeenCalledWith({
      agentId: 'agent-new',
      credentialProviderArn: 'arn:aws:identity:us-east-1:123456789:credential/agent-new',
    });

    // Verify Token Vault was the ONLY credential retrieval path
    // (Secrets Manager createSecret is called during provisioning, but never for retrieval)
    expect(mockTokenVault.retrieveCredentials).toHaveBeenCalledTimes(1);
  });
});

describe('Integration: Merchant Endpoint Registration → Service Discovery Query', () => {
  /**
   * Tests registering a merchant endpoint and discovering it via capability tags.
   *
   * Validates: Requirement 10.3
   */
  it('should register endpoint and discover it via capability tag query', async () => {
    const registryStore = new InMemoryRegistryStore();
    const clock: RegistryClock = {
      now: () => '2024-06-15T10:00:00.000Z',
    };

    const serviceRegistry = new DefaultServiceRegistry({
      store: registryStore,
      clock,
    });

    // --- Step 1: Register a merchant endpoint ---
    const entry: ServiceRegistryEntry = {
      endpointUrl: 'https://data-provider.example.com/api/market-feed',
      agentId: 'agent-data-provider',
      description: 'Real-time market data feed with 1-second granularity',
      priceUsdc: '0.50',
      capabilityTags: ['market-data', 'real-time', 'trading'],
      registeredAt: '',
      status: 'active',
    };

    await serviceRegistry.register(entry);

    // Register a second endpoint with different tags
    const entry2: ServiceRegistryEntry = {
      endpointUrl: 'https://analytics.example.com/api/sentiment',
      agentId: 'agent-analyst',
      description: 'Sentiment analysis for crypto markets',
      priceUsdc: '1.00',
      capabilityTags: ['analytics', 'sentiment', 'trading'],
      registeredAt: '',
      status: 'active',
    };

    await serviceRegistry.register(entry2);

    // Register a third endpoint with non-overlapping tags
    const entry3: ServiceRegistryEntry = {
      endpointUrl: 'https://storage.example.com/api/archive',
      agentId: 'agent-storage',
      description: 'Historical data archival service',
      priceUsdc: '0.10',
      capabilityTags: ['storage', 'archive'],
      registeredAt: '',
      status: 'active',
    };

    await serviceRegistry.register(entry3);

    // --- Step 2: Query by capability tags ---

    // Query for 'market-data' should return only the first endpoint
    const marketDataResults = await serviceRegistry.query({
      capabilityTags: ['market-data'],
    });
    expect(marketDataResults).toHaveLength(1);
    expect(marketDataResults[0].endpointUrl).toBe('https://data-provider.example.com/api/market-feed');
    expect(marketDataResults[0].agentId).toBe('agent-data-provider');
    expect(marketDataResults[0].priceUsdc).toBe('0.50');

    // Query for 'trading' should return both trading-tagged endpoints
    const tradingResults = await serviceRegistry.query({
      capabilityTags: ['trading'],
    });
    expect(tradingResults).toHaveLength(2);
    const tradingUrls = tradingResults.map((r) => r.endpointUrl);
    expect(tradingUrls).toContain('https://data-provider.example.com/api/market-feed');
    expect(tradingUrls).toContain('https://analytics.example.com/api/sentiment');

    // Query for 'storage' should return only the archive endpoint
    const storageResults = await serviceRegistry.query({
      capabilityTags: ['storage'],
    });
    expect(storageResults).toHaveLength(1);
    expect(storageResults[0].endpointUrl).toBe('https://storage.example.com/api/archive');

    // Query for non-existent tag should return empty
    const emptyResults = await serviceRegistry.query({
      capabilityTags: ['non-existent-capability'],
    });
    expect(emptyResults).toHaveLength(0);
  });

  it('should not return decommissioned endpoints in query results', async () => {
    const registryStore = new InMemoryRegistryStore();
    const clock: RegistryClock = {
      now: () => '2024-06-15T10:00:00.000Z',
    };

    const serviceRegistry = new DefaultServiceRegistry({
      store: registryStore,
      clock,
    });

    // Register an endpoint
    await serviceRegistry.register({
      endpointUrl: 'https://old-service.example.com/api/data',
      agentId: 'agent-old',
      description: 'Old data service being retired',
      priceUsdc: '0.25',
      capabilityTags: ['data-service'],
      registeredAt: '',
      status: 'active',
    });

    // Verify it's discoverable
    let results = await serviceRegistry.query({ capabilityTags: ['data-service'] });
    expect(results).toHaveLength(1);

    // Decommission the endpoint
    await serviceRegistry.decommission('https://old-service.example.com/api/data');

    // Verify it's no longer discoverable
    results = await serviceRegistry.query({ capabilityTags: ['data-service'] });
    expect(results).toHaveLength(0);
  });
});

describe('Integration: Spending Policy Update Propagation', () => {
  /**
   * Tests that spending policy updates are applied to subsequent payment
   * evaluations immediately (within 10 seconds as per Requirement 5.6).
   *
   * Validates: Requirement 5.6
   */
  it('should apply updated spending policy to subsequent payment evaluations within 10 seconds', async () => {
    const policyStore = new InMemoryPolicyStore();
    const transactionStore = new InMemoryTransactionStore();

    const spendingPolicyEngine = new DefaultSpendingPolicyEngine({
      policyStore,
      transactionStore,
    });

    // --- Step 1: Set initial policy with low per-transaction limit ---
    await spendingPolicyEngine.updatePolicy({
      agentId: 'agent-spender',
      perTransactionLimitUsdc: '1.00',
      cumulativeLimitUsdc: '50.00',
      updatedAt: new Date().toISOString(),
    });

    // Verify: a 2.00 USDC payment should be REJECTED (exceeds 1.00 per-tx limit)
    const rejectedEval = await spendingPolicyEngine.evaluate('agent-spender', '2.00');
    expect(rejectedEval.approved).toBe(false);
    expect(rejectedEval.rejectionReason).toBe('PER_TRANSACTION_EXCEEDED');

    // --- Step 2: Update policy to raise the per-transaction limit ---
    const updateStart = Date.now();
    await spendingPolicyEngine.updatePolicy({
      agentId: 'agent-spender',
      perTransactionLimitUsdc: '5.00',
      cumulativeLimitUsdc: '50.00',
      updatedAt: new Date().toISOString(),
    });

    // --- Step 3: Immediately evaluate the same payment amount ---
    const approvedEval = await spendingPolicyEngine.evaluate('agent-spender', '2.00');
    const propagationTime = Date.now() - updateStart;

    // Verify: the 2.00 USDC payment should now be APPROVED
    expect(approvedEval.approved).toBe(true);
    expect(approvedEval.perTransactionLimit).toBe('5.00');

    // Verify propagation happened within 10 seconds (Requirement 5.6)
    expect(propagationTime).toBeLessThan(10000);
  });

  it('should apply cumulative limit changes to subsequent evaluations', async () => {
    const policyStore = new InMemoryPolicyStore();
    const transactionStore = new InMemoryTransactionStore();

    const spendingPolicyEngine = new DefaultSpendingPolicyEngine({
      policyStore,
      transactionStore,
    });

    // Set initial policy with low cumulative limit
    await spendingPolicyEngine.updatePolicy({
      agentId: 'agent-heavy-spender',
      perTransactionLimitUsdc: '10.00',
      cumulativeLimitUsdc: '5.00',
      updatedAt: new Date().toISOString(),
    });

    // Add some prior spending in the 24h window
    transactionStore.addTransaction({
      agentId: 'agent-heavy-spender',
      timestamp: new Date().toISOString(),
      amountUsdc: '4.00',
      transactionHash: '0xprior_tx_1',
      status: 'settled',
    });

    // Verify: a 2.00 USDC payment should be REJECTED (4.00 + 2.00 > 5.00 cumulative)
    const rejectedEval = await spendingPolicyEngine.evaluate('agent-heavy-spender', '2.00');
    expect(rejectedEval.approved).toBe(false);
    expect(rejectedEval.rejectionReason).toBe('CUMULATIVE_EXCEEDED');

    // Update cumulative limit to 20.00
    const updateStart = Date.now();
    await spendingPolicyEngine.updatePolicy({
      agentId: 'agent-heavy-spender',
      perTransactionLimitUsdc: '10.00',
      cumulativeLimitUsdc: '20.00',
      updatedAt: new Date().toISOString(),
    });

    // Immediately evaluate again
    const approvedEval = await spendingPolicyEngine.evaluate('agent-heavy-spender', '2.00');
    const propagationTime = Date.now() - updateStart;

    // Verify: the 2.00 USDC payment should now be APPROVED (4.00 + 2.00 <= 20.00)
    expect(approvedEval.approved).toBe(true);
    expect(approvedEval.cumulativeLimit).toBe('20.00');

    // Verify propagation within 10 seconds
    expect(propagationTime).toBeLessThan(10000);
  });

  it('should reject payments when policy is removed (no policy defined)', async () => {
    const policyStore = new InMemoryPolicyStore();
    const transactionStore = new InMemoryTransactionStore();

    const spendingPolicyEngine = new DefaultSpendingPolicyEngine({
      policyStore,
      transactionStore,
    });

    // Agent with no policy should be rejected
    const evaluation = await spendingPolicyEngine.evaluate('agent-no-policy', '1.00');
    expect(evaluation.approved).toBe(false);
    expect(evaluation.rejectionReason).toBe('NO_POLICY');
  });
});
