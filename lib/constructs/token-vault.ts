import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Configuration for the AgentCore Identity Token Vault.
 * The Token Vault provides centralized, KMS-encrypted credential storage
 * for all agent Workload Identities.
 */
export interface TokenVaultProps {
  /** ARN of the KMS CMK used to encrypt credentials in the vault */
  kmsKeyArn: string;

  /** Human-readable name for the Token Vault */
  vaultName?: string;
}

/**
 * TokenVault construct models the AgentCore Identity Token Vault.
 *
 * The Token Vault is the centralized credential storage layer that:
 * - Encrypts all stored credentials (API keys, OAuth tokens) with KMS
 * - Provides the retrieval interface for Workload Identities
 * - Ensures credentials are never accessed directly from Secrets Manager
 *
 * Since AgentCore Identity may not have full CDK L2 support, this uses
 * CfnResource to model the Token Vault configuration.
 */
export class TokenVault extends Construct {
  /** The logical resource representing the Token Vault */
  public readonly vaultArn: string;

  /** The IAM role that the Token Vault service assumes for KMS operations */
  public readonly tokenVaultRole: iam.IRole;

  /** The KMS key ARN used for encryption */
  public readonly kmsKeyArn: string;

  constructor(scope: Construct, id: string, props: TokenVaultProps) {
    super(scope, id);

    this.kmsKeyArn = props.kmsKeyArn;
    const vaultName = props.vaultName ?? 'trading-system-token-vault';

    // IAM Role for the Token Vault service to access KMS for encryption/decryption
    // This role is assumed by the AgentCore Identity service when storing/retrieving credentials
    const tokenVaultRole = new iam.Role(this, 'TokenVaultRole', {
      roleName: `${vaultName}-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Role assumed by AgentCore Identity Token Vault for KMS operations',
    });

    // Grant the Token Vault role specific KMS permissions (no wildcards)
    tokenVaultRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TokenVaultKmsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Decrypt',
          'kms:Encrypt',
          'kms:GenerateDataKey',
          'kms:DescribeKey',
        ],
        resources: [props.kmsKeyArn],
      })
    );

    // Grant the Token Vault role access to read secrets from Secrets Manager
    // Scoped to the trading-system/agents/* path only
    tokenVaultRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TokenVaultSecretsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: [
          cdk.Arn.format(
            {
              service: 'secretsmanager',
              resource: 'secret',
              resourceName: 'trading-system/agents/*',
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            cdk.Stack.of(this)
          ),
        ],
      })
    );

    this.tokenVaultRole = tokenVaultRole;

    // Model the Token Vault as a CfnResource (AgentCore Identity custom resource)
    // This represents the Token Vault configuration in the AgentCore Identity service
    const tokenVaultResource = new cdk.CfnResource(this, 'TokenVaultResource', {
      type: 'AWS::Bedrock::AgentCoreTokenVault',
      properties: {
        VaultName: vaultName,
        KmsKeyArn: props.kmsKeyArn,
        ServiceRoleArn: tokenVaultRole.roleArn,
        EncryptionConfiguration: {
          KmsKeyArn: props.kmsKeyArn,
          EncryptionType: 'CUSTOMER_MANAGED_KEY',
        },
      },
    });

    this.vaultArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-token-vault',
        resourceName: vaultName,
      },
      cdk.Stack.of(this)
    );

    // Output the Token Vault ARN for reference
    new cdk.CfnOutput(this, 'TokenVaultArnOutput', {
      value: this.vaultArn,
      description: 'AgentCore Identity Token Vault ARN',
    });
  }
}
