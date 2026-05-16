import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface PaymentStackProps extends cdk.StackProps {
  /** ARN of the KMS CMK from FoundationStack for credential decryption */
  kmsKeyArn: string;

  /** VPC from FoundationStack for Lambda networking (outbound internet for on-chain transactions) */
  vpc: ec2.IVpc;
}

/**
 * PaymentStack provisions the payment execution infrastructure:
 *
 * - Payment Executor Lambda — handles x402 payment execution in VPC
 * - Spending Policy DynamoDB table — per-agent spending limits
 * - Payment Transactions DynamoDB table — rolling 48h window for cumulative spend tracking
 * - Agent Wallets DynamoDB table — wallet metadata with address-based GSI
 * - IAM roles with least-privilege (no wildcard actions) per Requirement 9.4
 *
 * Requirements: 9.1, 9.2, 9.4
 */
export class PaymentStack extends cdk.Stack {
  /** The Spending Policy DynamoDB table */
  public readonly spendingPolicyTable: dynamodb.Table;

  /** The Payment Transactions DynamoDB table */
  public readonly paymentTransactionsTable: dynamodb.Table;

  /** The Agent Wallets DynamoDB table */
  public readonly agentWalletsTable: dynamodb.Table;

  /** The Payment Executor Lambda function */
  public readonly paymentExecutorFunction: lambda.Function;

  /** The Payment Executor Lambda IAM role */
  public readonly paymentExecutorRole: iam.Role;

  constructor(scope: Construct, id: string, props: PaymentStackProps) {
    super(scope, id, props);

    // --- Spending Policy DynamoDB Table ---
    // PK: agentId (String)
    // Attributes: perTransactionLimitUsdc, cumulativeLimitUsdc, updatedAt
    this.spendingPolicyTable = new dynamodb.Table(this, 'SpendingPolicyTable', {
      tableName: 'trading-system-spending-policies',
      partitionKey: {
        name: 'agentId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // --- Payment Transactions DynamoDB Table ---
    // PK: agentId (String), SK: timestamp (String)
    // TTL: 48 hours (ttl attribute)
    // Used by Spending Policy Engine to compute 24-hour rolling cumulative spend
    this.paymentTransactionsTable = new dynamodb.Table(this, 'PaymentTransactionsTable', {
      tableName: 'trading-system-payment-transactions',
      partitionKey: {
        name: 'agentId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Transient data with 48h TTL
      timeToLiveAttribute: 'ttl',
    });

    // --- Agent Wallets DynamoDB Table ---
    // PK: agentId (String)
    // GSI1: address (PK) — for address-based lookups (income crediting)
    // Attributes: walletId, address, network, createdAt, workloadIdentityArn, credentialProviderArn
    this.agentWalletsTable = new dynamodb.Table(this, 'AgentWalletsTable', {
      tableName: 'trading-system-agent-wallets',
      partitionKey: {
        name: 'agentId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // GSI1: address-based lookups for income crediting
    this.agentWalletsTable.addGlobalSecondaryIndex({
      indexName: 'address-index',
      partitionKey: {
        name: 'address',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Payment Executor IAM Role ---
    // Least-privilege: no wildcard actions (Requirement 9.4)
    this.paymentExecutorRole = new iam.Role(this, 'PaymentExecutorRole', {
      roleName: 'trading-system-payment-executor-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Payment Executor Lambda — least-privilege, no wildcard actions',
    });

    // Permission: VPC networking for Lambda (required for VPC-attached Lambda)
    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'VpcNetworkingAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:CreateNetworkInterface',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DeleteNetworkInterface',
          'ec2:AssignPrivateIpAddresses',
          'ec2:UnassignPrivateIpAddresses',
        ],
        resources: ['*'], // VPC ENI operations require '*' resource — this is an AWS limitation
      })
    );

    // Permission: CloudWatch Logs for Lambda execution logs
    const logGroupArn = cdk.Arn.format(
      {
        service: 'logs',
        resource: 'log-group',
        resourceName: '/aws/lambda/trading-system-payment-executor:*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      this
    );

    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [logGroupArn],
      })
    );

    // Permission: DynamoDB read/write on Spending Policy table
    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SpendingPolicyTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
        ],
        resources: [this.spendingPolicyTable.tableArn],
      })
    );

    // Permission: DynamoDB read/write on Payment Transactions table
    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PaymentTransactionsTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [this.paymentTransactionsTable.tableArn],
      })
    );

    // Permission: DynamoDB read/write on Agent Wallets table (including GSI)
    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AgentWalletsTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [
          this.agentWalletsTable.tableArn,
          `${this.agentWalletsTable.tableArn}/index/address-index`,
        ],
      })
    );

    // Permission: KMS decrypt for Token Vault credential retrieval
    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KmsDecryptForTokenVault',
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:Decrypt',
          'kms:DescribeKey',
        ],
        resources: [props.kmsKeyArn],
      })
    );

    // Permission: Token Vault credential retrieval via AgentCore Identity
    // Scoped to the trading-system Token Vault and credential providers
    const tokenVaultArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-token-vault',
        resourceName: 'trading-system-token-vault',
      },
      this
    );

    const credentialProviderArnPattern = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-credential-provider',
        resourceName: '*-cdp-credential-provider',
      },
      this
    );

    this.paymentExecutorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TokenVaultCredentialRetrieval',
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:RetrieveAgentCoreCredential',
          'bedrock:GetAgentCoreCredentialProvider',
        ],
        resources: [
          tokenVaultArn,
          credentialProviderArnPattern,
        ],
      })
    );

    // --- Payment Executor Lambda Function ---
    // Deployed in VPC for outbound internet access (on-chain transactions via NAT)
    // Needs access to Token Vault, DynamoDB tables, and outbound internet
    this.paymentExecutorFunction = new lambda.Function(this, 'PaymentExecutorFunction', {
      functionName: 'trading-system-payment-executor',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        // Payment Executor Lambda placeholder
        // Full implementation in task 7.4
        exports.handler = async (event) => {
          return { statusCode: 200, body: JSON.stringify({ message: 'Payment Executor' }) };
        };
      `),
      role: this.paymentExecutorRole,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        SPENDING_POLICY_TABLE: this.spendingPolicyTable.tableName,
        PAYMENT_TRANSACTIONS_TABLE: this.paymentTransactionsTable.tableName,
        AGENT_WALLETS_TABLE: this.agentWalletsTable.tableName,
        KMS_KEY_ARN: props.kmsKeyArn,
        TOKEN_VAULT_ARN: tokenVaultArn,
      },
      description: 'Handles x402 payment execution: policy checks, on-chain payments, and replay',
    });

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'SpendingPolicyTableName', {
      value: this.spendingPolicyTable.tableName,
      description: 'Spending Policy DynamoDB table name',
      exportName: 'TradingSystem-SpendingPolicyTableName',
    });

    new cdk.CfnOutput(this, 'SpendingPolicyTableArn', {
      value: this.spendingPolicyTable.tableArn,
      description: 'Spending Policy DynamoDB table ARN',
      exportName: 'TradingSystem-SpendingPolicyTableArn',
    });

    new cdk.CfnOutput(this, 'PaymentTransactionsTableName', {
      value: this.paymentTransactionsTable.tableName,
      description: 'Payment Transactions DynamoDB table name',
      exportName: 'TradingSystem-PaymentTransactionsTableName',
    });

    new cdk.CfnOutput(this, 'PaymentTransactionsTableArn', {
      value: this.paymentTransactionsTable.tableArn,
      description: 'Payment Transactions DynamoDB table ARN',
      exportName: 'TradingSystem-PaymentTransactionsTableArn',
    });

    new cdk.CfnOutput(this, 'AgentWalletsTableName', {
      value: this.agentWalletsTable.tableName,
      description: 'Agent Wallets DynamoDB table name',
      exportName: 'TradingSystem-AgentWalletsTableName',
    });

    new cdk.CfnOutput(this, 'AgentWalletsTableArn', {
      value: this.agentWalletsTable.tableArn,
      description: 'Agent Wallets DynamoDB table ARN',
      exportName: 'TradingSystem-AgentWalletsTableArn',
    });

    new cdk.CfnOutput(this, 'PaymentExecutorFunctionArn', {
      value: this.paymentExecutorFunction.functionArn,
      description: 'Payment Executor Lambda function ARN',
      exportName: 'TradingSystem-PaymentExecutorFunctionArn',
    });
  }
}
