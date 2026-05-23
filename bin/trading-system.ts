#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { IdentityStack } from '../lib/identity-stack';
import { AgentStack } from '../lib/agent-stack';
import { PaymentStack } from '../lib/payment-stack';
import { MerchantStack } from '../lib/merchant-stack';
import { GovernanceStack } from '../lib/governance-stack';

const app = new cdk.App();

// --- CDK App-Level Configuration ---
// Requirement 9.6: CloudFormation default behavior is to roll back all resources
// created during a failed deployment. CDK inherits this behavior by default.
// We explicitly set rollback context to ensure this is enforced.
// This means if any resource fails to provision, the entire stack update is rolled back.
app.node.setContext('@aws-cdk/core:rollbackOnFailure', true);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Agent IDs for the trading system (shared across stacks)
const agentIds = ['agent-data-provider', 'agent-market-analyst', 'agent-service-executor', 'agent-arbitrage'];

// --- Wave 1: Foundation ---
// Provides shared infrastructure: KMS CMK, VPC, Secrets Manager patterns
const foundationStack = new FoundationStack(app, 'TradingSystem-Foundation', {
  env,
  agentIds,
  // Requirement 9.6: On deployment failure, roll back all resources created during the failed deployment
  terminationProtection: false,
});

// --- Wave 2: Identity ---
// Depends on Foundation for KMS key (secrets encryption)
// Provides: per-agent WorkloadIdentities, ApiKeyCredentialProviders
const identityStack = new IdentityStack(app, 'TradingSystem-Identity', {
  env,
  agentIds,
  cdpApiKey: cdk.SecretValue.secretsManager('trading-system/cdp-bootstrap-key', { jsonField: 'apiKeySecret' }),
});
identityStack.addDependency(foundationStack);

// --- Wave 3a: Agent ---
// Depends on Identity for Token Vault ARN (agents retrieve credentials via Token Vault)
// Provides: Supervisor Agent, Specialized Agents
const agentStack = new AgentStack(app, 'TradingSystem-Agent', {
  env,
});
agentStack.addDependency(identityStack);

// --- Wave 3b: Payment ---
// Depends on Identity for Token Vault (credential retrieval at runtime)
// Depends on Foundation for KMS key (decrypt credentials) and VPC (Lambda networking)
// Provides: Payment Executor Lambda, Spending Policy table, Payment Transactions table, Agent Wallets table
const paymentStack = new PaymentStack(app, 'TradingSystem-Payment', {
  env,
  kmsKeyArn: foundationStack.kmsKeyArn,
  vpc: foundationStack.vpc,
});
paymentStack.addDependency(identityStack);

// --- Wave 4: Merchant ---
// Depends on Payment for payment executor (receipt verification) and wallet table (income crediting)
// Depends on Agent (merchant endpoints are exposed by specialized agents)
// Provides: CloudFront distribution, Lambda@Edge paywall, Redeemed Receipts table
const merchantStack = new MerchantStack(app, 'TradingSystem-Merchant', {
  env,
  paymentExecutorFunctionArn: paymentStack.paymentExecutorFunction.functionArn,
  agentWalletsTableArn: paymentStack.agentWalletsTable.tableArn,
});
merchantStack.addDependency(paymentStack);
merchantStack.addDependency(agentStack);

// --- Wave 5: Governance ---
// Depends on Agent, Payment, and Merchant — aggregates audit data from all upstream stacks
// Provides: Audit Trail table, Service Registry table, Critical Alert SNS topic
const governanceStack = new GovernanceStack(app, 'TradingSystem-Governance', {
  env,
  paymentExecutorFunctionArn: paymentStack.paymentExecutorFunction.functionArn,
  spendingPolicyTableArn: paymentStack.spendingPolicyTable.tableArn,
  paymentTransactionsTableArn: paymentStack.paymentTransactionsTable.tableArn,
  merchantDistributionDomain: merchantStack.distribution.distributionDomainName,
  redeemedReceiptsTableArn: merchantStack.redeemedReceiptsTable.tableArn,
  supervisorAgentArn: agentStack.supervisorAgentArn,
});
governanceStack.addDependency(agentStack);
governanceStack.addDependency(paymentStack);
governanceStack.addDependency(merchantStack);
