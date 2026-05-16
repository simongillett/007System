import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { getAgentSecretName } from '../foundation-stack';

/**
 * Configuration for a single agent's Workload Identity in AgentCore Identity.
 */
export interface WorkloadIdentityProps {
  /** Unique identifier for the agent */
  agentId: string;

  /** ARN of the KMS CMK used for credential encryption */
  kmsKeyArn: string;

  /** ARN of the Token Vault this identity retrieves credentials from */
  tokenVaultArn: string;

  /** IAM Role ARN of the Token Vault (for trust relationship) */
  tokenVaultRoleArn: string;
}

/**
 * WorkloadIdentity construct models a single agent's identity in AgentCore Identity.
 *
 * Each agent gets:
 * 1. A Workload Identity — represents the agent's identity
 * 2. A Credential Provider (API Key type) — references the agent's Secrets Manager secret
 * 3. An IAM Role — scoped to access ONLY this agent's own Credential Provider
 *
 * This enforces per-agent credential isolation: Agent A cannot access Agent B's credentials.
 *
 * Security model (Requirement 9.4 — IAM least-privilege):
 * - No wildcard actions in any policy statement
 * - Resource ARNs scoped to the specific agent's resources only
 * - Cross-agent access is explicitly denied by omission
 */
export class WorkloadIdentity extends Construct {
  /** The IAM role representing this agent's Workload Identity */
  public readonly workloadRole: iam.IRole;

  /** ARN of the Workload Identity resource */
  public readonly workloadIdentityArn: string;

  /** ARN of the Credential Provider for this agent */
  public readonly credentialProviderArn: string;

  /** The agent ID this identity belongs to */
  public readonly agentId: string;

  /** The Secrets Manager secret ARN for this agent's CDP API key */
  public readonly secretArn: string;

  constructor(scope: Construct, id: string, props: WorkloadIdentityProps) {
    super(scope, id);

    this.agentId = props.agentId;

    // Compute the Secrets Manager secret ARN for this agent's CDP API key
    // Pattern: trading-system/agents/{agentId}/cdp-api-key
    const secretName = getAgentSecretName(props.agentId);
    this.secretArn = cdk.Arn.format(
      {
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: `${secretName}-??????`, // Secrets Manager appends random suffix
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      cdk.Stack.of(this)
    );

    // --- Credential Provider (API Key type) ---
    // References the Secrets Manager secret ARN for this agent's CDP API key
    const credentialProvider = new cdk.CfnResource(this, 'CredentialProvider', {
      type: 'AWS::Bedrock::AgentCoreCredentialProvider',
      properties: {
        Name: `${props.agentId}-cdp-credential-provider`,
        CredentialProviderType: 'API_KEY',
        ApiKeyConfiguration: {
          SecretArn: this.secretArn,
          KmsKeyArn: props.kmsKeyArn,
        },
        TokenVaultArn: props.tokenVaultArn,
      },
    });

    this.credentialProviderArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-credential-provider',
        resourceName: `${props.agentId}-cdp-credential-provider`,
      },
      cdk.Stack.of(this)
    );

    // --- Workload Identity IAM Role ---
    // This role represents the agent's identity and is scoped to access
    // ONLY its own Credential Provider via the Token Vault.
    // No cross-agent access is possible.
    const workloadRole = new iam.Role(this, 'WorkloadRole', {
      roleName: `trading-system-agent-${props.agentId}-identity`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Workload Identity role for agent ${props.agentId} — scoped to its own Credential Provider`,
    });

    // Permission: Retrieve credentials ONLY through the Token Vault API
    // This enforces Requirement 2.4: credentials retrieved exclusively through Token Vault
    workloadRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RetrieveOwnCredentialsThroughTokenVault',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:RetrieveAgentCoreCredential',
          'bedrock:GetAgentCoreCredentialProvider',
        ],
        resources: [this.credentialProviderArn],
      })
    );

    // Permission: Use KMS to decrypt credentials retrieved from Token Vault
    workloadRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptOwnCredentials',
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Decrypt',
          'kms:DescribeKey',
        ],
        resources: [props.kmsKeyArn],
      })
    );

    // Explicit deny: Prevent direct Secrets Manager access
    // This enforces Requirement 2.4: never access Secrets Manager directly
    workloadRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DenyDirectSecretsManagerAccess',
        effect: iam.Effect.DENY,
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecrets',
        ],
        resources: ['*'],
      })
    );

    this.workloadRole = workloadRole;

    // --- Workload Identity Resource ---
    // Registers this agent's identity in AgentCore Identity
    const workloadIdentity = new cdk.CfnResource(this, 'WorkloadIdentityResource', {
      type: 'AWS::Bedrock::AgentCoreWorkloadIdentity',
      properties: {
        Name: `${props.agentId}-workload-identity`,
        AgentId: props.agentId,
        RoleArn: workloadRole.roleArn,
        CredentialProviderArns: [this.credentialProviderArn],
        TokenVaultArn: props.tokenVaultArn,
      },
    });

    this.workloadIdentityArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-workload-identity',
        resourceName: `${props.agentId}-workload-identity`,
      },
      cdk.Stack.of(this)
    );
  }
}
