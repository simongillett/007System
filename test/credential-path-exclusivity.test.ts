/**
 * Property 2: Credential Retrieval Path Exclusivity
 *
 * For any specialized agent requesting its CDP credentials at runtime,
 * the retrieval path SHALL go exclusively through the AgentCore Identity
 * Token Vault API and SHALL never invoke Secrets Manager directly.
 *
 * Feature: multi-agent-trading-system, Property 2: Credential Retrieval Path Exclusivity
 *
 * **Validates: Requirements 2.4**
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import fc from 'fast-check';
import { FoundationStack } from '../lib/foundation-stack';
import { IdentityStack } from '../lib/identity-stack';

/**
 * Generator for valid agent IDs: alphanumeric + hyphens, 3-50 characters.
 * Agent IDs must start and end with alphanumeric characters.
 */
const agentIdArb = fc
  .stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')
    ),
    { minLength: 3, maxLength: 50 }
  )
  .filter((s) => /^[a-z0-9]/.test(s) && /[a-z0-9]$/.test(s) && !s.includes('--'));

describe('Feature: multi-agent-trading-system, Property 2: Credential Retrieval Path Exclusivity', () => {
  it('For any agent ID, the IAM policy ALLOWS credential retrieval through Token Vault (bedrock:RetrieveAgentCoreCredential) and DENIES direct Secrets Manager access', () => {
    fc.assert(
      fc.property(agentIdArb, (agentId) => {
        // Synthesize a stack with the generated agent ID
        const app = new cdk.App();
        const foundationStack = new FoundationStack(app, 'TestFoundation', {
          env: { account: '123456789012', region: 'us-east-1' },
        });

        const identityStack = new IdentityStack(app, 'TestIdentity', {
          env: { account: '123456789012', region: 'us-east-1' },
          kmsKeyArn: foundationStack.kmsKeyArn,
          vpc: foundationStack.vpc,
          agentIds: [agentId],
        });

        const template = Template.fromStack(identityStack);
        const json = template.toJSON();
        const resources = json.Resources || {};

        // Collect all IAM Policy resources (inline policies attached to roles)
        const policyResources = Object.entries(resources).filter(
          ([_, resource]) => (resource as { Type: string }).Type === 'AWS::IAM::Policy'
        );

        // Find the workload role's policy (contains the agent-specific statements)
        let foundTokenVaultAllow = false;
        let foundSecretsManagerDeny = false;
        let hasSecretsManagerAllow = false;

        for (const [logicalId, resource] of policyResources) {
          const res = resource as {
            Type: string;
            Properties?: {
              PolicyDocument?: {
                Statement?: Array<{
                  Sid?: string;
                  Effect: string;
                  Action: string | string[];
                  Resource?: unknown;
                }>;
              };
            };
          };

          const statements = res.Properties?.PolicyDocument?.Statement ?? [];

          for (const statement of statements) {
            const actions = Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action];

            // Check for Token Vault Allow (bedrock:RetrieveAgentCoreCredential)
            if (
              statement.Effect === 'Allow' &&
              actions.some((a) => a === 'bedrock:RetrieveAgentCoreCredential')
            ) {
              foundTokenVaultAllow = true;
            }

            // Check for Secrets Manager Deny
            if (
              statement.Effect === 'Deny' &&
              actions.some((a) => a.startsWith('secretsmanager:'))
            ) {
              foundSecretsManagerDeny = true;
            }

            // Check that no Allow statement grants any secretsmanager:* action
            if (statement.Effect === 'Allow') {
              for (const action of actions) {
                if (action.startsWith('secretsmanager:')) {
                  // This is the Token Vault role's policy, not the agent workload role
                  // We need to distinguish: the Token Vault role IS allowed SM access,
                  // but the agent workload role must NOT have SM Allow.
                  // Check if this is the workload role policy (has the RetrieveOwnCredentials statement)
                  const isWorkloadPolicy = statements.some(
                    (s) => s.Sid === 'RetrieveOwnCredentialsThroughTokenVault'
                  );
                  if (isWorkloadPolicy) {
                    hasSecretsManagerAllow = true;
                  }
                }
              }
            }
          }
        }

        // Property assertions:
        // 1. Token Vault retrieval path MUST be allowed
        expect(foundTokenVaultAllow).toBe(true);

        // 2. Direct Secrets Manager access MUST be denied
        expect(foundSecretsManagerDeny).toBe(true);

        // 3. No Allow statement in the workload role grants secretsmanager:* actions
        expect(hasSecretsManagerAllow).toBe(false);
      }),
      { verbose: true }
    );
  });
});
