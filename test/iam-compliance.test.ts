/**
 * Property 19: IAM Least-Privilege Compliance
 *
 * For any IAM policy statement in the synthesized CloudFormation template,
 * no statement SHALL use wildcard ("*") actions and all Resource values
 * SHALL be scoped to specific resource ARNs.
 *
 * Known exceptions:
 * - VPC ENI operations (ec2:CreateNetworkInterface, ec2:DescribeNetworkInterfaces,
 *   ec2:DeleteNetworkInterface, ec2:AssignPrivateIpAddresses, ec2:UnassignPrivateIpAddresses)
 *   require Resource "*" — this is an AWS limitation for Lambda VPC networking.
 * - KMS key policies always use Resource "*" which refers to "this key" — this is
 *   standard KMS key policy syntax per AWS documentation.
 *
 * **Validates: Requirements 9.4**
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import fc from 'fast-check';
import { FoundationStack } from '../lib/foundation-stack';
import { IdentityStack } from '../lib/identity-stack';
import { AgentStack } from '../lib/agent-stack';
import { PaymentStack } from '../lib/payment-stack';
import { MerchantStack } from '../lib/merchant-stack';
import { GovernanceStack } from '../lib/governance-stack';

// --- VPC ENI actions that AWS requires Resource "*" for ---
const VPC_ENI_ACTIONS = new Set([
  'ec2:CreateNetworkInterface',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DeleteNetworkInterface',
  'ec2:AssignPrivateIpAddresses',
  'ec2:UnassignPrivateIpAddresses',
]);

/**
 * Determines if a statement is a VPC ENI statement that is allowed to use Resource "*".
 * A statement qualifies if ALL its actions are VPC ENI operations.
 */
function isVpcEniStatement(actions: string[]): boolean {
  return actions.length > 0 && actions.every((a) => VPC_ENI_ACTIONS.has(a));
}

/**
 * Determines if a statement is inside a KMS key policy.
 * KMS key policies always use Resource "*" which refers to "this key".
 */
function isKmsKeyPolicy(resourceType: string): boolean {
  return resourceType === 'AWS::KMS::Key';
}

interface PolicyStatement {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  Sid?: string;
}

interface IamViolation {
  stackName: string;
  logicalId: string;
  resourceType: string;
  sid?: string;
  violationType: 'wildcard_action' | 'unscoped_resource';
  details: string;
}

/**
 * Extracts all IAM policy statements from a CloudFormation template JSON.
 * Scans:
 * - AWS::IAM::Policy (PolicyDocument.Statement)
 * - AWS::IAM::Role (AssumeRolePolicyDocument.Statement, Policies[].PolicyDocument.Statement)
 * - AWS::IAM::ManagedPolicy (PolicyDocument.Statement)
 * - AWS::KMS::Key (KeyPolicy.Statement) — for resource scoping only (actions are KMS-specific)
 */
function extractIamStatements(
  templateJson: Record<string, unknown>,
  stackName: string
): { statements: Array<{ statement: PolicyStatement; logicalId: string; resourceType: string }>; } {
  const resources = (templateJson as { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> }).Resources ?? {};
  const results: Array<{ statement: PolicyStatement; logicalId: string; resourceType: string }> = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const resType = resource.Type;
    const props = resource.Properties ?? {};

    // AWS::IAM::Policy
    if (resType === 'AWS::IAM::Policy') {
      const policyDoc = props.PolicyDocument as { Statement?: PolicyStatement[] } | undefined;
      if (policyDoc?.Statement) {
        for (const stmt of policyDoc.Statement) {
          results.push({ statement: stmt, logicalId, resourceType: resType });
        }
      }
    }

    // AWS::IAM::Role — inline policies and assume role policy
    if (resType === 'AWS::IAM::Role') {
      // Inline policies
      const policies = props.Policies as Array<{ PolicyDocument?: { Statement?: PolicyStatement[] } }> | undefined;
      if (policies) {
        for (const policy of policies) {
          if (policy.PolicyDocument?.Statement) {
            for (const stmt of policy.PolicyDocument.Statement) {
              results.push({ statement: stmt, logicalId, resourceType: resType });
            }
          }
        }
      }
      // Note: AssumeRolePolicyDocument is not checked for wildcard actions
      // because it defines WHO can assume the role, not what actions the role can perform.
    }

    // AWS::IAM::ManagedPolicy
    if (resType === 'AWS::IAM::ManagedPolicy') {
      const policyDoc = props.PolicyDocument as { Statement?: PolicyStatement[] } | undefined;
      if (policyDoc?.Statement) {
        for (const stmt of policyDoc.Statement) {
          results.push({ statement: stmt, logicalId, resourceType: resType });
        }
      }
    }

    // AWS::KMS::Key — key policies
    if (resType === 'AWS::KMS::Key') {
      const keyPolicy = props.KeyPolicy as { Statement?: PolicyStatement[] } | undefined;
      if (keyPolicy?.Statement) {
        for (const stmt of keyPolicy.Statement) {
          results.push({ statement: stmt, logicalId, resourceType: resType });
        }
      }
    }
  }

  return { statements: results };
}

/**
 * Checks if a Resource value is a wildcard "*" (unscoped).
 * Handles string, array, and CloudFormation intrinsic function values.
 */
function isWildcardResource(resource: unknown): boolean {
  if (resource === '*') return true;
  if (Array.isArray(resource)) {
    return resource.some((r) => r === '*');
  }
  return false;
}

/**
 * Validates all IAM policy statements in a template for least-privilege compliance.
 */
function validateTemplate(
  templateJson: Record<string, unknown>,
  stackName: string
): IamViolation[] {
  const violations: IamViolation[] = [];
  const { statements } = extractIamStatements(templateJson, stackName);

  for (const { statement, logicalId, resourceType } of statements) {
    // Only check Allow statements (Deny statements are fine with wildcards)
    if (statement.Effect !== 'Allow') continue;

    // --- Check 1: No wildcard actions ---
    const actions = statement.Action
      ? Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action]
      : [];

    for (const action of actions) {
      if (action === '*') {
        violations.push({
          stackName,
          logicalId,
          resourceType,
          sid: statement.Sid,
          violationType: 'wildcard_action',
          details: `Action "*" (all actions) found in Allow statement`,
        });
      }
    }

    // --- Check 2: Resources must be scoped ---
    // Exception: VPC ENI operations require Resource "*" (AWS limitation)
    // Exception: KMS key policies use Resource "*" (refers to "this key")
    if (isKmsKeyPolicy(resourceType)) {
      // KMS key policies always use "*" for resource — this is standard
      continue;
    }

    if (isVpcEniStatement(actions)) {
      // VPC ENI operations require "*" resource — AWS limitation
      continue;
    }

    if (isWildcardResource(statement.Resource)) {
      violations.push({
        stackName,
        logicalId,
        resourceType,
        sid: statement.Sid,
        violationType: 'unscoped_resource',
        details: `Resource "*" (unscoped) found in Allow statement with actions: ${actions.join(', ')}`,
      });
    }
  }

  return violations;
}

describe('Property 19: IAM Least-Privilege Compliance', () => {
  let app: cdk.App;
  let foundationStack: FoundationStack;
  let identityStack: IdentityStack;
  let agentStack: AgentStack;
  let paymentStack: PaymentStack;
  let merchantStack: MerchantStack;
  let governanceStack: GovernanceStack;
  let templates: Map<string, Record<string, unknown>>;

  beforeAll(() => {
    // Synthesize the full CDK app with all 6 stacks wired together
    app = new cdk.App();

    const env = { account: '123456789012', region: 'us-east-1' };

    // Wave 1: Foundation
    foundationStack = new FoundationStack(app, 'TestFoundation', { env });

    // Wave 2: Identity
    identityStack = new IdentityStack(app, 'TestIdentity', {
      env,
      kmsKeyArn: foundationStack.kmsKeyArn,
      vpc: foundationStack.vpc,
    });

    // Wave 3a: Agent
    agentStack = new AgentStack(app, 'TestAgent', {
      env,
      tokenVaultArn: identityStack.tokenVaultArn,
    });

    // Wave 3b: Payment
    paymentStack = new PaymentStack(app, 'TestPayment', {
      env,
      kmsKeyArn: foundationStack.kmsKeyArn,
      vpc: foundationStack.vpc,
    });

    // Wave 4: Merchant
    merchantStack = new MerchantStack(app, 'TestMerchant', {
      env,
      paymentExecutorFunctionArn: paymentStack.paymentExecutorFunction.functionArn,
      agentWalletsTableArn: paymentStack.agentWalletsTable.tableArn,
    });

    // Wave 5: Governance
    governanceStack = new GovernanceStack(app, 'TestGovernance', {
      env,
      paymentExecutorFunctionArn: paymentStack.paymentExecutorFunction.functionArn,
      spendingPolicyTableArn: paymentStack.spendingPolicyTable.tableArn,
      paymentTransactionsTableArn: paymentStack.paymentTransactionsTable.tableArn,
      merchantDistributionDomain: merchantStack.distribution.distributionDomainName,
      redeemedReceiptsTableArn: merchantStack.redeemedReceiptsTable.tableArn,
      supervisorAgentArn: agentStack.supervisorAgentArn,
    });

    // Synthesize all templates
    templates = new Map<string, Record<string, unknown>>([
      ['Foundation', Template.fromStack(foundationStack).toJSON()],
      ['Identity', Template.fromStack(identityStack).toJSON()],
      ['Agent', Template.fromStack(agentStack).toJSON()],
      ['Payment', Template.fromStack(paymentStack).toJSON()],
      ['Merchant', Template.fromStack(merchantStack).toJSON()],
      ['Governance', Template.fromStack(governanceStack).toJSON()],
    ]);
  });

  describe('Full CDK App Synthesis', () => {
    it('synthesizes all 6 stacks without errors', () => {
      expect(templates.size).toBe(6);
      for (const [name, template] of templates) {
        expect(template).toBeDefined();
        expect((template as { Resources?: unknown }).Resources).toBeDefined();
      }
    });
  });

  describe('No Wildcard Actions (Property Test)', () => {
    it('no Allow statement in any stack uses wildcard "*" as an action', () => {
      /**
       * **Validates: Requirements 9.4**
       *
       * Property: For any IAM policy statement in the synthesized CloudFormation
       * templates, no Allow statement SHALL use wildcard ("*") actions.
       */
      fc.assert(
        fc.property(
          fc.constantFrom(...Array.from(templates.entries())),
          ([stackName, templateJson]) => {
            const violations = validateTemplate(templateJson, stackName);
            const actionViolations = violations.filter(
              (v) => v.violationType === 'wildcard_action'
            );

            if (actionViolations.length > 0) {
              const details = actionViolations
                .map(
                  (v) =>
                    `[${v.stackName}] ${v.logicalId} (${v.resourceType})${v.sid ? ` Sid: ${v.sid}` : ''}: ${v.details}`
                )
                .join('\n');
              return false;
            }
            return true;
          }
        ),
        { numRuns: templates.size } // Run once per stack (deterministic input)
      );
    });
  });

  describe('Scoped Resources (Property Test)', () => {
    it('all Allow statements have scoped resource ARNs (with known exceptions)', () => {
      /**
       * **Validates: Requirements 9.4**
       *
       * Property: For any IAM policy statement in the synthesized CloudFormation
       * templates, all Resource values SHALL be scoped to specific resource ARNs.
       *
       * Known exceptions:
       * - VPC ENI operations require Resource "*" (AWS limitation)
       * - KMS key policies use Resource "*" (refers to "this key")
       */
      fc.assert(
        fc.property(
          fc.constantFrom(...Array.from(templates.entries())),
          ([stackName, templateJson]) => {
            const violations = validateTemplate(templateJson, stackName);
            const resourceViolations = violations.filter(
              (v) => v.violationType === 'unscoped_resource'
            );

            if (resourceViolations.length > 0) {
              const details = resourceViolations
                .map(
                  (v) =>
                    `[${v.stackName}] ${v.logicalId} (${v.resourceType})${v.sid ? ` Sid: ${v.sid}` : ''}: ${v.details}`
                )
                .join('\n');
              return false;
            }
            return true;
          }
        ),
        { numRuns: templates.size } // Run once per stack (deterministic input)
      );
    });
  });

  describe('Combined IAM Compliance Validation', () => {
    it('all stacks pass IAM least-privilege compliance', () => {
      /**
       * **Validates: Requirements 9.4**
       *
       * Comprehensive check: synthesize full CDK app and verify no IAM policy
       * statement uses wildcard actions and all resources are scoped.
       */
      const allViolations: IamViolation[] = [];

      for (const [stackName, templateJson] of templates) {
        const violations = validateTemplate(templateJson, stackName);
        allViolations.push(...violations);
      }

      if (allViolations.length > 0) {
        const report = allViolations
          .map(
            (v) =>
              `[${v.stackName}] ${v.logicalId} (${v.resourceType})${v.sid ? ` Sid: ${v.sid}` : ''}\n  Type: ${v.violationType}\n  ${v.details}`
          )
          .join('\n\n');
        fail(`IAM Least-Privilege violations found:\n\n${report}`);
      }
    });
  });
});
