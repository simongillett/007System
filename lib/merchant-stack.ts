import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Configuration for a single merchant endpoint path with pricing.
 * Price must be in the range [0.01, 10,000] USDC.
 */
export interface EndpointPricingConfig {
  /** The endpoint path (e.g., '/data/market-feed') */
  path: string;

  /** Price in USDC for accessing this endpoint (0.01–10,000) */
  priceUsdc: string;

  /** Recipient wallet address for payments */
  recipientWalletAddress: string;

  /** Agent ID that owns this endpoint */
  recipientAgentId: string;
}

export interface MerchantStackProps extends cdk.StackProps {
  /**
   * Pricing configuration per endpoint path.
   * Each entry defines a path, its price in USDC, and the recipient wallet address.
   * Prices must be in the range [0.01, 10,000] USDC.
   */
  endpointPricing?: EndpointPricingConfig[];

  /**
   * Payment Executor Lambda function ARN from PaymentStack.
   * Used by merchant endpoints to invoke payment verification.
   */
  paymentExecutorFunctionArn?: string;

  /**
   * Agent Wallets DynamoDB table ARN from PaymentStack.
   * Used for wallet address lookups during income crediting.
   */
  agentWalletsTableArn?: string;
}

/**
 * MerchantStack provisions the x402 merchant endpoint infrastructure:
 *
 * - CloudFront Distribution — serves merchant endpoints with Lambda@Edge for x402 paywall logic
 * - Lambda@Edge Function — intercepts requests to check for payment receipts, returns 402 if unpaid
 * - Redeemed Receipts DynamoDB Table — prevents double-redemption of payment receipts (7-day TTL)
 * - Pricing Configuration — configurable per endpoint path, range [0.01, 10,000] USDC
 * - IAM roles with least-privilege (no wildcard actions) per Requirement 9.4
 *
 * Note: Lambda@Edge must be deployed in us-east-1 (CloudFront requirement).
 *
 * Requirements: 7.1, 7.7, 9.1, 9.2
 */
export class MerchantStack extends cdk.Stack {
  /** The Redeemed Receipts DynamoDB table */
  public readonly redeemedReceiptsTable: dynamodb.Table;

  /** The Lambda@Edge function for x402 paywall logic */
  public readonly paywallEdgeFunction: lambda.Function;

  /** The CloudFront distribution for merchant endpoints */
  public readonly distribution: cloudfront.Distribution;

  /** The Lambda@Edge IAM role */
  public readonly paywallEdgeRole: iam.Role;

  /** Validated endpoint pricing configuration */
  public readonly endpointPricing: EndpointPricingConfig[];

  constructor(scope: Construct, id: string, props?: MerchantStackProps) {
    super(scope, id, props);

    // --- Validate and store endpoint pricing configuration ---
    this.endpointPricing = this.validatePricingConfig(props?.endpointPricing ?? [
      {
        path: '/data/*',
        priceUsdc: '0.10',
        recipientWalletAddress: '0x0000000000000000000000000000000000000000',
        recipientAgentId: 'default-data-agent',
      },
      {
        path: '/services/*',
        priceUsdc: '1.00',
        recipientWalletAddress: '0x0000000000000000000000000000000000000000',
        recipientAgentId: 'default-service-agent',
      },
    ]);

    // --- Redeemed Receipts DynamoDB Table ---
    // PK: transactionHash (String)
    // Attributes: redeemedAt, endpointPath
    // TTL: 7 days (ttl attribute)
    // Used by Merchant Endpoints to prevent double-redemption of payment receipts
    this.redeemedReceiptsTable = new dynamodb.Table(this, 'RedeemedReceiptsTable', {
      tableName: 'trading-system-redeemed-receipts',
      partitionKey: {
        name: 'transactionHash',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Transient data with 7-day TTL
      timeToLiveAttribute: 'ttl',
    });

    // --- Lambda@Edge IAM Role ---
    // Lambda@Edge requires edgelambda.amazonaws.com and lambda.amazonaws.com as principals
    // Least-privilege: no wildcard actions (Requirement 9.4)
    this.paywallEdgeRole = new iam.Role(this, 'PaywallEdgeRole', {
      roleName: 'trading-system-paywall-edge-role',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
      description: 'IAM role for x402 paywall Lambda@Edge — least-privilege, no wildcard actions',
    });

    // Permission: CloudWatch Logs for Lambda@Edge execution logs
    // Lambda@Edge creates log groups in the region where it executes (any CloudFront edge location)
    // We scope to the specific function name pattern
    const logGroupArn = cdk.Arn.format(
      {
        service: 'logs',
        resource: 'log-group',
        resourceName: '/aws/lambda/us-east-1.trading-system-paywall-edge:*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      this
    );

    // Lambda@Edge logs are created in the region where the function executes,
    // so we need a broader log group pattern for edge locations
    const edgeLogGroupArn = cdk.Arn.format(
      {
        service: 'logs',
        resource: 'log-group',
        resourceName: '/aws/lambda/*.trading-system-paywall-edge:*',
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        region: '*',
      },
      this
    );

    this.paywallEdgeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [logGroupArn, edgeLogGroupArn],
      })
    );

    // Permission: DynamoDB read/write on Redeemed Receipts table
    // Lambda@Edge needs to check and record redeemed receipts
    this.paywallEdgeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RedeemedReceiptsTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
        ],
        resources: [this.redeemedReceiptsTable.tableArn],
      })
    );

    // --- Lambda@Edge Function for x402 Paywall ---
    // Must be deployed in us-east-1 (CloudFront requirement)
    // Placeholder implementation — full logic in task 9.2
    this.paywallEdgeFunction = new lambda.Function(this, 'PaywallEdgeFunction', {
      functionName: 'trading-system-paywall-edge',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(this.generateEdgeFunctionCode()),
      role: this.paywallEdgeRole,
      timeout: cdk.Duration.seconds(5), // Lambda@Edge max is 5s for viewer request
      memorySize: 128,
      description: 'x402 paywall Lambda@Edge: checks payment receipts, returns 402 if unpaid',
    });

    // Publish a version for Lambda@Edge (required by CloudFront)
    const edgeFunctionVersion = this.paywallEdgeFunction.currentVersion;

    // --- S3 Origin Bucket (placeholder for backend services) ---
    // In production, this would be replaced with actual backend service origins
    const originBucket = new s3.Bucket(this, 'MerchantOriginBucket', {
      bucketName: `trading-system-merchant-origin-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // --- CloudFront Distribution ---
    // Serves merchant endpoints with Lambda@Edge for x402 paywall logic
    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'MerchantOAI', {
      comment: 'OAI for trading system merchant endpoints',
    });

    // Grant OAI read access to the origin bucket
    originBucket.grantRead(originAccessIdentity);

    this.distribution = new cloudfront.Distribution(this, 'MerchantDistribution', {
      comment: 'Trading System Merchant Endpoints — x402 paywalled',
      defaultBehavior: {
        origin: new origins.S3Origin(originBucket, {
          originAccessIdentity,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // No caching for paywalled content
        edgeLambdas: [
          {
            functionVersion: edgeFunctionVersion,
            eventType: cloudfront.LambdaEdgeEventType.VIEWER_REQUEST,
          },
        ],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
    });

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'RedeemedReceiptsTableName', {
      value: this.redeemedReceiptsTable.tableName,
      description: 'Redeemed Receipts DynamoDB table name',
      exportName: 'TradingSystem-RedeemedReceiptsTableName',
    });

    new cdk.CfnOutput(this, 'RedeemedReceiptsTableArn', {
      value: this.redeemedReceiptsTable.tableArn,
      description: 'Redeemed Receipts DynamoDB table ARN',
      exportName: 'TradingSystem-RedeemedReceiptsTableArn',
    });

    new cdk.CfnOutput(this, 'PaywallEdgeFunctionArn', {
      value: this.paywallEdgeFunction.functionArn,
      description: 'Paywall Lambda@Edge function ARN',
      exportName: 'TradingSystem-PaywallEdgeFunctionArn',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name for merchant endpoints',
      exportName: 'TradingSystem-MerchantDistributionDomain',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: 'TradingSystem-MerchantDistributionId',
    });

    new cdk.CfnOutput(this, 'EndpointPricingConfig', {
      value: JSON.stringify(this.endpointPricing),
      description: 'Endpoint pricing configuration (JSON)',
      exportName: 'TradingSystem-EndpointPricingConfig',
    });
  }

  /**
   * Validates pricing configuration entries.
   * Each price must be in the range [0.01, 10,000] USDC.
   * Throws an error if any price is outside the valid range.
   */
  private validatePricingConfig(configs: EndpointPricingConfig[]): EndpointPricingConfig[] {
    const MIN_PRICE = 0.01;
    const MAX_PRICE = 10000;

    for (const config of configs) {
      const price = parseFloat(config.priceUsdc);
      if (isNaN(price) || price < MIN_PRICE || price > MAX_PRICE) {
        throw new Error(
          `Invalid price for endpoint '${config.path}': ${config.priceUsdc} USDC. ` +
          `Price must be between ${MIN_PRICE} and ${MAX_PRICE} USDC.`
        );
      }
      if (!config.path || config.path.trim() === '') {
        throw new Error('Endpoint path must not be empty.');
      }
      if (!config.recipientWalletAddress || config.recipientWalletAddress.trim() === '') {
        throw new Error(`Recipient wallet address must not be empty for endpoint '${config.path}'.`);
      }
      if (!config.recipientAgentId || config.recipientAgentId.trim() === '') {
        throw new Error(`Recipient agent ID must not be empty for endpoint '${config.path}'.`);
      }
    }

    return configs;
  }

  /**
   * Generates the Lambda@Edge function code for x402 paywall logic.
   * This is a placeholder implementation — full logic will be implemented in task 9.2.
   *
   * The function:
   * 1. Checks if the request includes a valid x402 payment receipt header
   * 2. If no receipt: returns HTTP 402 with payment requirements
   * 3. If receipt present: passes through to origin (full verification in task 9.2)
   */
  private generateEdgeFunctionCode(): string {
    // Serialize pricing config for embedding in the Lambda function
    const pricingJson = JSON.stringify(this.endpointPricing);

    return `
'use strict';

// Endpoint pricing configuration (injected at deploy time)
const ENDPOINT_PRICING = ${pricingJson};

// x402 payment receipt header name
const RECEIPT_HEADER = 'x-402-receipt';

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // Find matching pricing config for this path
  const pricing = findPricing(uri);

  // If no pricing configured for this path, pass through
  if (!pricing) {
    return request;
  }

  // Check for payment receipt header
  const receiptHeader = request.headers[RECEIPT_HEADER];
  if (receiptHeader && receiptHeader.length > 0 && receiptHeader[0].value) {
    // Receipt present — pass through to origin
    // Full verification logic will be implemented in task 9.2
    return request;
  }

  // No receipt — return 402 Payment Required with payment requirements
  return {
    status: '402',
    statusDescription: 'Payment Required',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'application/json' }],
      'x-402-price': [{ key: 'X-402-Price', value: pricing.priceUsdc }],
      'x-402-network': [{ key: 'X-402-Network', value: 'base' }],
      'x-402-recipient': [{ key: 'X-402-Recipient', value: pricing.recipientWalletAddress }],
      'x-402-asset': [{ key: 'X-402-Asset', value: 'USDC' }],
      'x-402-agent-id': [{ key: 'X-402-Agent-Id', value: pricing.recipientAgentId }],
    },
    body: JSON.stringify({
      error: 'Payment Required',
      price: pricing.priceUsdc,
      asset: 'USDC',
      network: 'base',
      recipient: pricing.recipientWalletAddress,
      agentId: pricing.recipientAgentId,
    }),
  };
};

function findPricing(uri) {
  for (const config of ENDPOINT_PRICING) {
    if (matchPath(config.path, uri)) {
      return config;
    }
  }
  return null;
}

function matchPath(pattern, uri) {
  // Support wildcard patterns (e.g., '/data/*')
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // Remove trailing '*'
    return uri.startsWith(prefix);
  }
  // Exact match
  return uri === pattern;
}
`;
  }
}
