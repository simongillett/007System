/**
 * Wallet Manager interfaces for CDP SDK wallet provisioning and balance management.
 * Manages Coinbase wallets for USDC income/spending via AgentCore Identity.
 */

export interface WalletManagerConfig {
  cdpApiKeySecretArn: string;
  kmsKeyArn: string;
  network: 'base';
  provisioningTimeoutMs: number;
}

export interface AgentWallet {
  agentId: string;
  walletId: string;
  address: string;
  network: 'base';
  asset: 'USDC';
  createdAt: string;
  workloadIdentityArn: string;
  credentialProviderArn: string;
}

export interface WalletBalance {
  agentId: string;
  walletId: string;
  balance: string;
  lastUpdated: string;
}

export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

export interface WalletManager {
  provisionWallet(agentId: string): Promise<AgentWallet>;
  getBalance(agentId: string): Promise<WalletBalance>;
  creditWallet(agentId: string, amount: string, txHash: string): Promise<void>;
  getCredentials(agentId: string): Promise<CdpCredentials>;
}
