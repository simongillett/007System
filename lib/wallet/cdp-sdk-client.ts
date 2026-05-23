/**
 * Concrete CdpSdkClient implementation using @coinbase/cdp-sdk.
 * Fetches bootstrap credentials from Secrets Manager, then delegates to the CDP SDK.
 */

import { CdpClient } from '@coinbase/cdp-sdk';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { CdpSdkClient } from './wallet-manager';

const BOOTSTRAP_SECRET_NAME = 'trading-system/cdp-bootstrap-key';

export interface CdpSdkClientConfig {
  /** AWS region for Secrets Manager. */
  region?: string;
  /** Override the bootstrap secret name (for testing). */
  bootstrapSecretName?: string;
}

/**
 * Creates a CdpSdkClient by fetching the bootstrap API key from Secrets Manager
 * and initializing the CDP SDK.
 */
export async function createCdpSdkClient(
  config: CdpSdkClientConfig = {}
): Promise<CdpSdkClient> {
  const region = config.region ?? 'us-east-1';
  const secretName = config.bootstrapSecretName ?? BOOTSTRAP_SECRET_NAME;

  // Fetch bootstrap credentials from Secrets Manager
  const sm = new SecretsManagerClient({ region });
  const resp = await sm.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );

  if (!resp.SecretString) {
    throw new Error(`Bootstrap secret ${secretName} has no value`);
  }

  const { apiKeyId, apiKeySecret } = JSON.parse(resp.SecretString) as {
    apiKeyId: string;
    apiKeySecret: string;
  };

  if (!apiKeyId || apiKeyId === 'PLACEHOLDER') {
    throw new Error(`Bootstrap secret ${secretName} contains placeholder values`);
  }

  // Initialize CDP SDK with the bootstrap key
  const cdp = new CdpClient({ apiKeyId, apiKeySecret });

  return {
    async createWallet(params: { network: string }) {
      // CDP SDK v2 creates "accounts" (server-managed key pairs).
      // Each agent gets a unique EVM account on the Base network.
      const account = await cdp.evm.createAccount();

      // The CDP SDK manages keys server-side. The bootstrap API key is used
      // for all operations. Per-agent secrets store the bootstrap key reference
      // so the WalletManager can attribute wallets to agents.
      return {
        walletId: account.address, // Use address as wallet ID (unique per account)
        address: account.address,
        apiKeyId,
        apiKeySecret,
      };
    },

    async getUsdcBalance(params: { address: string; network: string }) {
      const result = await cdp.evm.listTokenBalances({
        address: params.address as `0x${string}`,
        network: params.network as any,
      });

      // Find USDC in the token balances
      const usdc = result.balances.find(
        (b) =>
          b.token.symbol?.toUpperCase() === 'USDC' ||
          b.token.contractAddress?.toLowerCase() ===
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' // USDC on Base
      );

      if (!usdc) return '0';

      // Convert from atomic units (6 decimals for USDC)
      const raw = BigInt(usdc.amount.amount);
      const decimals = usdc.amount.decimals ?? '6';
      const divisor = BigInt(10) ** BigInt(decimals);
      const whole = raw / divisor;
      const frac = raw % divisor;
      return `${whole}.${frac.toString().padStart(Number(decimals), '0')}`;
    },

    async creditUsdc(_params: {
      address: string;
      network: string;
      amount: string;
      txHash: string;
    }) {
      // Credit is a ledger operation tracked externally — the CDP SDK doesn't
      // have a "credit" API. This is a no-op; the income reconciler handles
      // on-chain USDC transfers separately.
    },
  };
}
