import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GovernanceStackProps extends cdk.StackProps {
  /**
   * Payment Executor Lambda function ARN from PaymentStack.
   * Referenced for audit trail correlation with payment events.
   */
  paymentExecutorFunctionArn?: string;

  /**
   * Spending Policy DynamoDB table ARN from PaymentStack.
   * Referenced for policy evaluation audit records.
   */
  spendingPolicyTableArn?: string;

  /**
   * Payment Transactions DynamoDB table ARN from PaymentStack.
   * Referenced for transaction audit correlation.
   */
  paymentTransactionsTableArn?: string;

  /**
   * CloudFront distribution domain from MerchantStack.
   * Referenced for service registry endpoint URL construction.
   */
  merchantDistributionDomain?: string;

  /**
   * Redeemed Receipts DynamoDB table ARN from MerchantStack.
   * Referenced for receipt audit correlation.
   */
  redeemedReceiptsTableArn?: string;

  /**
   * Supervisor Agent ARN from AgentStack.
   * Referenced for agent orchestration audit records.
   */
  supervisorAgentArn?: string;
}

/**
 * GovernanceStack provisions the governance layer infrastructure:
 *
 * - Audit Trail DynamoDB Table — records all payment events with correlation IDs, 90-day TTL
 *   - PK: correlationId, SK: timestamp
 *   - GSI1: sourceAgentId (PK) + timestamp (SK) — agent-filtered time-range queries
 *   - GSI2: transactionHash (PK) — duplicate detection and reconciliation
 *
 * - Service Registry DynamoDB Table — discoverable catalog of merchant endpoints
 *   - PK: endpointUrl
 *   - GSI1: agentId (PK) — agent-specific lookups
 *
 * - Alerting Construct — SNS topic for critical audit failures (when all persistence retries exhausted)
 *
 * IAM least-privilege: no wildcard actions (Requirement 9.4)
 *
 * Requirements: 6.3, 9.1, 9.2
 */
export class GovernanceStack extends cdk.Stack {
  /** The Audit Trail DynamoDB table */
  public readonly auditTrailTable: dynamodb.Table;

  /** The Service Registry DynamoDB table */
  public readonly serviceRegistryTable: dynamodb.Table;

  /** SNS topic for critical audit failure alerts */
  public readonly criticalAuditAlertTopic: sns.Topic;

  /** IAM role for the Audit Logger component */
  public readonly auditLoggerRole: iam.Role;

  constructor(scope: Construct, id: string, props?: GovernanceStackProps) {
    super(scope, id, props);

    // Store cross-stack references for runtime use
    const paymentExecutorFunctionArn = props?.paymentExecutorFunctionArn;
    const spendingPolicyTableArn = props?.spendingPolicyTableArn;
    const paymentTransactionsTableArn = props?.paymentTransactionsTableArn;
    const merchantDistributionDomain = props?.merchantDistributionDomain;
    const redeemedReceiptsTableArn = props?.redeemedReceiptsTableArn;
    const supervisorAgentArn = props?.supervisorAgentArn;

    // --- Audit Trail DynamoDB Table ---
    // PK: correlationId (String), SK: timestamp (String)
    // GSI1: sourceAgentId (PK) + timestamp (SK) — for agent-filtered time-range queries
    // GSI2: transactionHash (PK) — for duplicate detection and reconciliation
    // TTL: 90 days (ttl attribute)
    this.auditTrailTable = new dynamodb.Table(this, 'AuditTrailTable', {
      tableName: 'trading-system-audit-trail',
      partitionKey: {
        name: 'correlationId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: sourceAgentId (PK) + timestamp (SK) — for agent-filtered time-range queries
    this.auditTrailTable.addGlobalSecondaryIndex({
      indexName: 'source-agent-timestamp-index',
      partitionKey: {
        name: 'sourceAgentId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: transactionHash (PK) — for duplicate detection and reconciliation
    this.auditTrailTable.addGlobalSecondaryIndex({
      indexName: 'transaction-hash-index',
      partitionKey: {
        name: 'transactionHash',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Service Registry DynamoDB Table ---
    // PK: endpointUrl (String)
    // GSI1: agentId (PK) — for agent-specific lookups
    // Attributes: description, priceUsdc, capabilityTags, registeredAt, status
    this.serviceRegistryTable = new dynamodb.Table(this, 'ServiceRegistryTable', {
      tableName: 'trading-system-service-registry',
      partitionKey: {
        name: 'endpointUrl',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // GSI1: agentId (PK) — for agent-specific lookups
    this.serviceRegistryTable.addGlobalSecondaryIndex({
      indexName: 'agent-id-index',
      partitionKey: {
        name: 'agentId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Alerting Construct ---
    // SNS topic for critical audit failures (when all persistence retries are exhausted)
    // Requirement 6.6: emit critical alert when all three persistence retries are exhausted
    this.criticalAuditAlertTopic = new sns.Topic(this, 'CriticalAuditAlertTopic', {
      topicName: 'trading-system-critical-audit-alerts',
      displayName: 'Trading System Critical Audit Alerts',
    });

    // --- Audit Logger IAM Role ---
    // Least-privilege: no wildcard actions (Requirement 9.4)
    this.auditLoggerRole = new iam.Role(this, 'AuditLoggerRole', {
      roleName: 'trading-system-audit-logger-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for Audit Logger — least-privilege, no wildcard actions',
    });

    // Permission: CloudWatch Logs for Lambda execution logs
    const logGroupArn = cdk.Arn.format(
      {
        service: 'logs',
        resource: 'log-group',
        resourceName: '/aws/lambda/trading-system-audit-logger:*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      this
    );

    this.auditLoggerRole.addToPolicy(
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

    // Permission: DynamoDB read/write on Audit Trail table (including GSIs)
    this.auditLoggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AuditTrailTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [
          this.auditTrailTable.tableArn,
          `${this.auditTrailTable.tableArn}/index/source-agent-timestamp-index`,
          `${this.auditTrailTable.tableArn}/index/transaction-hash-index`,
        ],
      })
    );

    // Permission: DynamoDB read/write on Service Registry table (including GSI)
    this.auditLoggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ServiceRegistryTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
          'dynamodb:Scan',
        ],
        resources: [
          this.serviceRegistryTable.tableArn,
          `${this.serviceRegistryTable.tableArn}/index/agent-id-index`,
        ],
      })
    );

    // Permission: SNS publish for critical audit failure alerts
    this.auditLoggerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CriticalAuditAlertPublish',
        effect: iam.Effect.ALLOW,
        actions: [
          'sns:Publish',
        ],
        resources: [this.criticalAuditAlertTopic.topicArn],
      })
    );

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'AuditTrailTableName', {
      value: this.auditTrailTable.tableName,
      description: 'Audit Trail DynamoDB table name',
      exportName: 'TradingSystem-AuditTrailTableName',
    });

    new cdk.CfnOutput(this, 'AuditTrailTableArn', {
      value: this.auditTrailTable.tableArn,
      description: 'Audit Trail DynamoDB table ARN',
      exportName: 'TradingSystem-AuditTrailTableArn',
    });

    new cdk.CfnOutput(this, 'ServiceRegistryTableName', {
      value: this.serviceRegistryTable.tableName,
      description: 'Service Registry DynamoDB table name',
      exportName: 'TradingSystem-ServiceRegistryTableName',
    });

    new cdk.CfnOutput(this, 'ServiceRegistryTableArn', {
      value: this.serviceRegistryTable.tableArn,
      description: 'Service Registry DynamoDB table ARN',
      exportName: 'TradingSystem-ServiceRegistryTableArn',
    });

    new cdk.CfnOutput(this, 'CriticalAuditAlertTopicArn', {
      value: this.criticalAuditAlertTopic.topicArn,
      description: 'SNS topic ARN for critical audit failure alerts',
      exportName: 'TradingSystem-CriticalAuditAlertTopicArn',
    });

    new cdk.CfnOutput(this, 'AuditLoggerRoleArn', {
      value: this.auditLoggerRole.roleArn,
      description: 'Audit Logger IAM role ARN',
      exportName: 'TradingSystem-AuditLoggerRoleArn',
    });
  }
}
