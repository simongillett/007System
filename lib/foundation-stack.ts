import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Secrets Manager naming convention for per-agent CDP API keys.
 * Pattern: trading-system/agents/{agentId}/cdp-api-key
 * Individual secrets are created at runtime by WalletManager during agent provisioning.
 */
export const SECRETS_PREFIX = 'trading-system/agents';
export const CDP_API_KEY_SUFFIX = 'cdp-api-key';

/**
 * Returns the Secrets Manager secret name for a given agent's CDP API key.
 */
export function getAgentSecretName(agentId: string): string {
  return `${SECRETS_PREFIX}/${agentId}/${CDP_API_KEY_SUFFIX}`;
}

export interface FoundationStackProps extends cdk.StackProps {
  /**
   * List of agent IDs to pre-create Secrets Manager secrets for.
   * Each agent gets an empty CDP API key secret that is populated at runtime
   * by the WalletManager during wallet provisioning.
   * Defaults to a single agent if not specified.
   */
  agentIds?: string[];
}

/**
 * FoundationStack provides shared infrastructure for the trading system:
 * - KMS CMK for encrypting all secrets (CDP keys, tokens)
 * - VPC with private subnets and NAT gateway for Lambda networking
 * - Per-agent Secrets Manager secrets (empty shells, populated at runtime)
 * - Exports for dependent stacks (IdentityStack, PaymentStack)
 */
export class FoundationStack extends cdk.Stack {
  /** ARN of the KMS CMK used for encrypting all secrets */
  public readonly kmsKeyArn: string;

  /** The KMS key construct */
  public readonly kmsKey: kms.IKey;

  /** VPC for Lambda functions requiring network access */
  public readonly vpc: ec2.IVpc;

  /** Private subnet IDs for Lambda placement */
  public readonly privateSubnetIds: string[];

  /** Security group for Lambda functions in the VPC */
  public readonly lambdaSecurityGroupId: string;

  /** Map of agent ID to their Secrets Manager secret ARN */
  public readonly agentSecretArns: Map<string, string>;

  /** Map of agent ID to their Secrets Manager Secret construct */
  public readonly agentSecrets: Map<string, secretsmanager.ISecret>;

  constructor(scope: Construct, id: string, props?: FoundationStackProps) {
    super(scope, id, props);

    const agentIds = props?.agentIds ?? ['agent-default'];

    // --- KMS Customer-Managed Key ---
    // Used to encrypt all Secrets Manager secrets (CDP API keys, tokens)
    // Key rotation enabled for compliance
    const key = new kms.Key(this, 'TradingSystemKey', {
      alias: 'trading-system/secrets-encryption',
      description: 'CMK for encrypting trading system secrets (CDP API keys, tokens)',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Key policy: least-privilege — only allow specific principals
      policy: new iam.PolicyDocument({
        statements: [
          // Allow account root to administer the key (required for CDK management)
          new iam.PolicyStatement({
            sid: 'AllowKeyAdministration',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              'kms:Create*',
              'kms:Describe*',
              'kms:Enable*',
              'kms:List*',
              'kms:Put*',
              'kms:Update*',
              'kms:Revoke*',
              'kms:Disable*',
              'kms:Get*',
              'kms:Delete*',
              'kms:TagResource',
              'kms:UntagResource',
              'kms:ScheduleKeyDeletion',
              'kms:CancelKeyDeletion',
            ],
            resources: ['*'], // Key policy resource is always '*' (refers to this key)
          }),
          // Allow Secrets Manager to use the key for encryption/decryption
          new iam.PolicyStatement({
            sid: 'AllowSecretsManagerUsage',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal('secretsmanager.amazonaws.com')],
            actions: [
              'kms:Decrypt',
              'kms:GenerateDataKey',
              'kms:DescribeKey',
            ],
            resources: ['*'], // Key policy resource is always '*' (refers to this key)
            conditions: {
              StringEquals: {
                'kms:CallerAccount': cdk.Aws.ACCOUNT_ID,
              },
            },
          }),
        ],
      }),
    });

    this.kmsKey = key;
    this.kmsKeyArn = key.keyArn;

    // --- VPC for Lambda Networking ---
    // Private subnets with NAT gateway for outbound internet access
    // (required for CDP SDK calls to Coinbase APIs)
    const vpc = new ec2.Vpc(this, 'TradingSystemVpc', {
      vpcName: 'trading-system-vpc',
      maxAzs: 2,
      natGateways: 1, // Single NAT gateway to minimize cost while providing outbound access
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    this.vpc = vpc;
    this.privateSubnetIds = vpc.privateSubnets.map((subnet) => subnet.subnetId);

    // Security group for Lambda functions in the VPC
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      securityGroupName: 'trading-system-lambda-sg',
      description: 'Security group for trading system Lambda functions',
      allowAllOutbound: true, // Lambda needs outbound for CDP SDK calls
    });

    this.lambdaSecurityGroupId = lambdaSecurityGroup.securityGroupId;

    // --- SSM Parameters for cross-stack references ---
    // Store VPC and subnet references for dependent stacks
    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: '/trading-system/foundation/vpc-id',
      stringValue: vpc.vpcId,
      description: 'VPC ID for the trading system',
    });

    new ssm.StringParameter(this, 'PrivateSubnetIdsParam', {
      parameterName: '/trading-system/foundation/private-subnet-ids',
      stringValue: cdk.Fn.join(',', this.privateSubnetIds),
      description: 'Comma-separated private subnet IDs for Lambda placement',
    });

    new ssm.StringParameter(this, 'LambdaSecurityGroupIdParam', {
      parameterName: '/trading-system/foundation/lambda-security-group-id',
      stringValue: lambdaSecurityGroup.securityGroupId,
      description: 'Security group ID for Lambda functions in the VPC',
    });

    // --- Per-Agent Secrets Manager Secrets ---
    // Create empty secret shells for each agent's CDP API key.
    // These are populated at runtime by the WalletManager during wallet provisioning.
    // Creating them in CDK ensures:
    // - IAM policies reference concrete ARNs (no wildcards)
    // - KMS encryption is configured from day one
    // - Credential Providers can reference real secret ARNs at deploy time
    this.agentSecretArns = new Map<string, string>();
    this.agentSecrets = new Map<string, secretsmanager.ISecret>();

    for (const agentId of agentIds) {
      const secretName = getAgentSecretName(agentId);
      const secret = new secretsmanager.Secret(this, `CdpApiKey-${agentId}`, {
        secretName,
        encryptionKey: key,
        description: `CDP API key for agent ${agentId} — populated at runtime by WalletManager`,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        // Placeholder value — WalletManager will overwrite with real credentials
        secretStringValue: cdk.SecretValue.unsafePlainText(
          JSON.stringify({ apiKeyId: 'PLACEHOLDER', apiKeySecret: 'PLACEHOLDER' })
        ),
      });

      this.agentSecretArns.set(agentId, secret.secretArn);
      this.agentSecrets.set(agentId, secret);
    }

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'KmsKeyArnOutput', {
      value: key.keyArn,
      description: 'KMS CMK ARN for secrets encryption',
      exportName: 'TradingSystem-KmsKeyArn',
    });

    new cdk.CfnOutput(this, 'VpcIdOutput', {
      value: vpc.vpcId,
      description: 'VPC ID for Lambda networking',
      exportName: 'TradingSystem-VpcId',
    });

    new cdk.CfnOutput(this, 'LambdaSecurityGroupIdOutput', {
      value: lambdaSecurityGroup.securityGroupId,
      description: 'Security group for Lambda functions',
      exportName: 'TradingSystem-LambdaSecurityGroupId',
    });
  }
}
