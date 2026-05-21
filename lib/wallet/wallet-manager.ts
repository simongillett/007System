/**
 * WalletManager implementation with CDP SDK integration.
 *
 * Manages Coinbase wallets for USDC income/spending via AgentCore Identity.
 * Uses dependency injection for external services to enable testability.
 *
 * Key design decisions:
 * - Credentials are ALWAYS retrieved via Token Vault (Requirement 2.4)
 * - Balance formatted to 2 decimal places for display (Requirement 2.6)
 * - Credit amounts preserve 6 decimal places (Requirement 4.1)
 * - Provisioning must complete within 30 seconds (Requirement 2.1)
 * - Non-existent agent queries return clear error (Requirement 2.8)
 */

import {
  WalletManager,
  WalletManagerConfig,
  AgentWallet,
  WalletBalance,
  CdpCredentials,
} from '../types/wallet';

// --- Dependency Interfaces ---

/**
 * Interface for CDP SDK wallet operations.
 * Abstracts the Coinbase CDP SDK v1.49.0 for testability.
 */
export interface CdpSdkClient {
  /** Create a new wallet on the specified network */
  createWallet(params: { network: string }): Promise<{
    walletId: string;
    address: string;
    apiKeyId: string;
    apiKeySecret: string;
  }>;

  /** Query the USDC balance for a wallet address */
  getUsdcBalance(params: { address: string; network: string }): Promise<string>;

  /** Credit USDC to a wallet address */
  creditUsdc(params: {
    address: string;
    network: string;
    amount: string;
    txHash: string;
  }): Promise<void>;
}

/**
 * Interface for AWS Secrets Manager operations.
 * Used during provisioning to populate the pre-created CDP API key secret.
 */
export interface SecretsManagerClient {
  /** Update an existing secret's value (secret shell created by CDK) */
  putSecretValue(params: {
    secretId: string;
    secretValue: string;
  }): Promise<{ arn: string }>;
}

/**
 * Interface for AgentCore Identity Token Vault operations.
 * This is the EXCLUSIVE path for credential retrieval (Requirement 2.4).
 */
export interface TokenVaultClient {
  /** Retrieve credentials through the Token Vault API */
  retrieveCredentials(params: {
    agentId: string;
    credentialProviderArn: string;
  }): Promise<CdpCredentials>;
}

/**
 * Interface for AgentCore Identity management operations.
 * Used during provisioning to create Credential Providers and Workload Identities.
 */
export interface IdentityClient {
  /** Create a Credential Provider for an agent's CDP API key */
  createCredentialProvider(params: {
    agentId: string;
    secretArn: string;
    kmsKeyArn: string;
  }): Promise<{ credentialProviderArn: string }>;

  /** Create a Workload Identity scoped to the agent's Credential Provider */
  createWorkloadIdentity(params: {
    agentId: string;
    credentialProviderArn: string;
  }): Promise<{ workloadIdentityArn: string }>;
}

/**
 * Interface for wallet persistence (DynamoDB Agent Wallets table).
 */
export interface WalletStore {
  /** Save a provisioned wallet record */
  save(wallet: AgentWallet): Promise<void>;

  /** Retrieve a wallet record by agent ID, returns null if not found */
  get(agentId: string): Promise<AgentWallet | null>;
}

// --- Error Types ---

export class WalletProvisioningError extends Error {
  public readonly agentId: string;
  public readonly reason: string;

  constructor(agentId: string, reason: string) {
    super(`Wallet provisioning failed for agent ${agentId}: ${reason}`);
    this.name = 'WalletProvisioningError';
    this.agentId = agentId;
    this.reason = reason;
  }
}

export class WalletNotFoundError extends Error {
  public readonly agentId: string;

  constructor(agentId: string) {
    super(`No wallet exists for agent: ${agentId}`);
    this.name = 'WalletNotFoundError';
    this.agentId = agentId;
  }
}

export class WalletProvisioningTimeoutError extends Error {
  public readonly agentId: string;
  public readonly timeoutMs: number;

  constructor(agentId: string, timeoutMs: number) {
    super(
      `Wallet provisioning timed out for agent ${agentId} after ${timeoutMs}ms`
    );
    this.name = 'WalletProvisioningTimeoutError';
    this.agentId = agentId;
    this.timeoutMs = timeoutMs;
  }
}

// --- Dependencies Container ---

export interface WalletManagerDependencies {
  cdpSdk: CdpSdkClient;
  secretsManager: SecretsManagerClient;
  tokenVault: TokenVaultClient;
  identity: IdentityClient;
  walletStore: WalletStore;
}

// --- Secrets Manager Naming ---

const SECRETS_PREFIX = 'trading-system/agents';
const CDP_API_KEY_SUFFIX = 'cdp-api-key';

function getAgentSecretName(agentId: string): string {
  return `${SECRETS_PREFIX}/${agentId}/${CDP_API_KEY_SUFFIX}`;
}

// --- Implementation ---

/**
 * Default WalletManager implementation.
 *
 * Orchestrates wallet provisioning, balance queries, credential retrieval,
 * and income crediting using injected dependencies.
 */
export class DefaultWalletManager implements WalletManager {
  private readonly config: WalletManagerConfig;
  private readonly deps: WalletManagerDependencies;

  constructor(config: WalletManagerConfig, deps: WalletManagerDependencies) {
    this.config = config;
    this.deps = deps;
  }

  /**
   * Provision a dedicated Coinbase wallet for an agent.
   *
   * Steps:
   * 1. Create wallet via CDP SDK
   * 2. Store API key in Secrets Manager (KMS encrypted)
   * 3. Create Credential Provider in AgentCore Identity
   * 4. Create Workload Identity scoped to the Credential Provider
   * 5. Persist wallet record
   *
   * Must complete within provisioningTimeoutMs (30s).
   * Requirements: 2.1, 2.2, 2.3, 2.5, 2.9
   */
  async provisionWallet(agentId: string): Promise<AgentWallet> {
    const timeoutMs = this.config.provisioningTimeoutMs;

    const provisioningPromise = this.doProvisionWallet(agentId);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new WalletProvisioningTimeoutError(agentId, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([provisioningPromise, timeoutPromise]);
    } catch (error) {
      if (
        error instanceof WalletProvisioningTimeoutError ||
        error instanceof WalletProvisioningError
      ) {
        throw error;
      }
      throw new WalletProvisioningError(
        agentId,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  /**
   * Query the USDC balance for an agent's wallet.
   *
   * Returns balance formatted to 2 decimal places for display.
   * Returns error for non-existent agent.
   * Requirements: 2.6, 2.8
   */
  async getBalance(agentId: string): Promise<WalletBalance> {
    const wallet = await this.deps.walletStore.get(agentId);
    if (!wallet) {
      throw new WalletNotFoundError(agentId);
    }

    const rawBalance = await this.deps.cdpSdk.getUsdcBalance({
      address: wallet.address,
      network: this.config.network,
    });

    // Format to exactly 2 decimal places for display (Requirement 2.6)
    const formattedBalance = formatBalanceForDisplay(rawBalance);

    return {
      agentId,
      walletId: wallet.walletId,
      balance: formattedBalance,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Retrieve CDP credentials exclusively through the Token Vault.
   *
   * CRITICAL: This method NEVER accesses Secrets Manager directly.
   * All credential retrieval goes through AgentCore Identity Token Vault.
   * Requirement: 2.4
   */
  async getCredentials(agentId: string): Promise<CdpCredentials> {
    const wallet = await this.deps.walletStore.get(agentId);
    if (!wallet) {
      throw new WalletNotFoundError(agentId);
    }

    // Retrieve credentials EXCLUSIVELY through Token Vault (Requirement 2.4)
    return this.deps.tokenVault.retrieveCredentials({
      agentId,
      credentialProviderArn: wallet.credentialProviderArn,
    });
  }

  /**
   * Credit incoming USDC to an agent's wallet.
   *
   * Preserves 6 decimal places of precision (Requirement 4.1).
   * Requirements: 4.1
   */
  async creditWallet(
    agentId: string,
    amount: string,
    txHash: string
  ): Promise<void> {
    const wallet = await this.deps.walletStore.get(agentId);
    if (!wallet) {
      throw new WalletNotFoundError(agentId);
    }

    // Preserve 6 decimal places of precision (Requirement 4.1)
    const preciseAmount = formatAmountWithPrecision(amount, 6);

    await this.deps.cdpSdk.creditUsdc({
      address: wallet.address,
      network: this.config.network,
      amount: preciseAmount,
      txHash,
    });
  }

  // --- Private Methods ---

  private async doProvisionWallet(agentId: string): Promise<AgentWallet> {
    // Step 1: Create wallet via CDP SDK (Requirement 2.1, 2.5)
    const walletResult = await this.deps.cdpSdk.createWallet({
      network: this.config.network,
    });

    // Step 2: Populate the pre-created secret with real CDP credentials (Requirement 2.2)
    // The secret shell was created by CDK in FoundationStack with a placeholder value.
    // WalletManager overwrites it with the real API key from CDP SDK.
    const secretName = getAgentSecretName(agentId);
    const secretValue = JSON.stringify({
      apiKeyId: walletResult.apiKeyId,
      apiKeySecret: walletResult.apiKeySecret,
    });

    const secretResult = await this.deps.secretsManager.putSecretValue({
      secretId: secretName,
      secretValue,
    });

    // Step 3: Create Credential Provider in AgentCore Identity (Requirement 2.2)
    const credentialProviderResult =
      await this.deps.identity.createCredentialProvider({
        agentId,
        secretArn: secretResult.arn,
        kmsKeyArn: this.config.kmsKeyArn,
      });

    // Step 4: Create Workload Identity scoped to Credential Provider (Requirement 2.3)
    const workloadIdentityResult =
      await this.deps.identity.createWorkloadIdentity({
        agentId,
        credentialProviderArn: credentialProviderResult.credentialProviderArn,
      });

    // Step 5: Persist wallet record
    const agentWallet: AgentWallet = {
      agentId,
      walletId: walletResult.walletId,
      address: walletResult.address,
      network: this.config.network,
      asset: 'USDC',
      createdAt: new Date().toISOString(),
      workloadIdentityArn: workloadIdentityResult.workloadIdentityArn,
      credentialProviderArn: credentialProviderResult.credentialProviderArn,
    };

    await this.deps.walletStore.save(agentWallet);

    return agentWallet;
  }
}

// --- Utility Functions ---

/**
 * Format a balance string to exactly 2 decimal places for display.
 * Handles various input formats (integer, more/fewer decimals).
 *
 * Examples:
 *   "100" → "100.00"
 *   "50.1" → "50.10"
 *   "25.999" → "25.99" (truncated, not rounded — shows available balance)
 *   "0.123456" → "0.12"
 */
export function formatBalanceForDisplay(rawBalance: string): string {
  const num = parseFloat(rawBalance);
  if (isNaN(num)) {
    return '0.00';
  }
  // Truncate to 2 decimal places (don't round up — show available balance)
  const truncated = Math.floor(num * 100) / 100;
  return truncated.toFixed(2);
}

/**
 * Format an amount string to exactly the specified number of decimal places.
 * Preserves precision for on-chain operations.
 *
 * Examples (precision=6):
 *   "1.5" → "1.500000"
 *   "0.123456" → "0.123456"
 *   "100" → "100.000000"
 */
export function formatAmountWithPrecision(
  amount: string,
  decimalPlaces: number
): string {
  const num = parseFloat(amount);
  if (isNaN(num)) {
    return (0).toFixed(decimalPlaces);
  }
  return num.toFixed(decimalPlaces);
}
