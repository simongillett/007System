import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { TokenVault } from './constructs/token-vault';
import { WorkloadIdentity } from './constructs/workload-identity';

export interface IdentityStackProps extends cdk.StackProps {
  /** ARN of the KMS CMK from FoundationStack for credential encryption */
  kmsKeyArn: string;

  /** VPC from FoundationStack for network access */
  vpc: ec2.IVpc;

  /**
   * List of agent IDs to create Workload Identities for.
   * Each agent gets its own Workload Identity, Credential Provider, and scoped IAM role.
   * Supports 1-10 agents (Requirement 1.1).
   * Defaults to a single agent if not specified.
   */
  agentIds?: string[];
}

/**
 * IdentityStack provisions AgentCore Identity resources for the trading system.
 *
 * Architecture:
 * - One Token Vault (centralized, KMS-encrypted credential storage)
 * - One Workload Identity per agent (with scoped IAM role)
 * - One Credential Provider per agent (API Key type, references Secrets Manager)
 *
 * Security guarantees:
 * - Each agent can ONLY access its own Credential Provider (per-agent isolation)
 * - Credentials are retrieved exclusively through the Token Vault API
 * - Direct Secrets Manager access is explicitly denied for agent roles
 * - No wildcard IAM actions (Requirement 9.4)
 * - All credentials encrypted at rest with KMS CMK (Requirement 2.2)
 *
 * Requirements: 2.2, 2.3, 2.4, 2.9, 9.4
 */
export class IdentityStack extends cdk.Stack {
  /** The Token Vault construct for centralized credential storage */
  public readonly tokenVault: TokenVault;

  /** Map of agent ID to their WorkloadIdentity construct */
  public readonly workloadIdentities: Map<string, WorkloadIdentity>;

  /** The Token Vault ARN for cross-stack references */
  public readonly tokenVaultArn: string;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const agentIds = props.agentIds ?? ['agent-default'];

    // Validate agent count (1-10 per Requirement 1.1)
    if (agentIds.length < 1 || agentIds.length > 10) {
      throw new Error(
        `Agent count must be between 1 and 10, got ${agentIds.length}`
      );
    }

    // --- Token Vault ---
    // Centralized credential storage encrypted with the KMS CMK from FoundationStack
    this.tokenVault = new TokenVault(this, 'TokenVault', {
      kmsKeyArn: props.kmsKeyArn,
      vaultName: 'trading-system-token-vault',
    });

    this.tokenVaultArn = this.tokenVault.vaultArn;

    // --- Per-Agent Workload Identities ---
    // Each agent gets its own identity, credential provider, and scoped IAM role
    this.workloadIdentities = new Map<string, WorkloadIdentity>();

    for (const agentId of agentIds) {
      const identity = new WorkloadIdentity(
        this,
        `WorkloadIdentity-${agentId}`,
        {
          agentId,
          kmsKeyArn: props.kmsKeyArn,
          tokenVaultArn: this.tokenVault.vaultArn,
          tokenVaultRoleArn: this.tokenVault.tokenVaultRole.roleArn,
        }
      );

      this.workloadIdentities.set(agentId, identity);
    }

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'TokenVaultArn', {
      value: this.tokenVault.vaultArn,
      description: 'AgentCore Identity Token Vault ARN',
      exportName: 'TradingSystem-TokenVaultArn',
    });

    new cdk.CfnOutput(this, 'AgentCount', {
      value: agentIds.length.toString(),
      description: 'Number of agent Workload Identities provisioned',
    });
  }
}
