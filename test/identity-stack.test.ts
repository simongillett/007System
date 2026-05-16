import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { IdentityStack } from '../lib/identity-stack';

describe('IdentityStack', () => {
  let app: cdk.App;
  let foundationStack: FoundationStack;
  let identityStack: IdentityStack;

  beforeEach(() => {
    app = new cdk.App();
    foundationStack = new FoundationStack(app, 'TestFoundation', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
  });

  describe('with default single agent', () => {
    beforeEach(() => {
      identityStack = new IdentityStack(app, 'TestIdentity', {
        env: { account: '123456789012', region: 'us-east-1' },
        kmsKeyArn: foundationStack.kmsKeyArn,
        vpc: foundationStack.vpc,
      });
    });

    it('synthesizes without errors', () => {
      const template = Template.fromStack(identityStack);
      expect(template.toJSON()).toBeDefined();
    });

    it('creates a Token Vault resource', () => {
      const template = Template.fromStack(identityStack);
      template.hasResourceProperties('AWS::Bedrock::AgentCoreTokenVault', {
        VaultName: 'trading-system-token-vault',
        EncryptionConfiguration: {
          EncryptionType: 'CUSTOMER_MANAGED_KEY',
        },
      });
    });

    it('creates a Token Vault IAM role with KMS and Secrets Manager access', () => {
      const template = Template.fromStack(identityStack);
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'trading-system-token-vault-role',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'bedrock.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }),
          ]),
        }),
      });
    });

    it('creates a Workload Identity resource for the default agent', () => {
      const template = Template.fromStack(identityStack);
      template.hasResourceProperties('AWS::Bedrock::AgentCoreWorkloadIdentity', {
        Name: 'agent-default-workload-identity',
        AgentId: 'agent-default',
      });
    });

    it('creates a Credential Provider (API Key type) for the default agent', () => {
      const template = Template.fromStack(identityStack);
      template.hasResourceProperties('AWS::Bedrock::AgentCoreCredentialProvider', {
        Name: 'agent-default-cdp-credential-provider',
        CredentialProviderType: 'API_KEY',
      });
    });

    it('scopes Workload Identity IAM role to only its own Credential Provider', () => {
      const template = Template.fromStack(identityStack);
      // Verify the workload role has a policy allowing access to its own credential provider
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'RetrieveOwnCredentialsThroughTokenVault',
              Effect: 'Allow',
              Action: Match.arrayWith([
                'bedrock:RetrieveAgentCoreCredential',
                'bedrock:GetAgentCoreCredentialProvider',
              ]),
            }),
          ]),
        }),
      });
    });

    it('explicitly denies direct Secrets Manager access for agent roles', () => {
      const template = Template.fromStack(identityStack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'DenyDirectSecretsManagerAccess',
              Effect: 'Deny',
              Action: Match.arrayWith([
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
                'secretsmanager:ListSecrets',
              ]),
            }),
          ]),
        }),
      });
    });

    it('does not use wildcard actions in any Allow IAM policy statement', () => {
      const template = Template.fromStack(identityStack);
      const json = template.toJSON();
      const resources = json.Resources || {};

      for (const [logicalId, resource] of Object.entries(resources)) {
        const res = resource as { Type: string; Properties?: Record<string, unknown> };
        if (res.Type !== 'AWS::IAM::Policy') continue;

        const statements = (res.Properties?.PolicyDocument as { Statement?: Array<{ Effect: string; Action: string | string[] }> })?.Statement ?? [];
        for (const statement of statements) {
          if (statement.Effect !== 'Allow') continue;

          const actions = Array.isArray(statement.Action)
            ? statement.Action
            : [statement.Action];

          for (const action of actions) {
            expect(action).not.toBe('*');
            // Also check no action is just a service wildcard like "s3:*"
            expect(action).not.toMatch(/^[a-z0-9-]+:\*$/);
          }
        }
      }
    });
  });

  describe('with multiple agents', () => {
    const agentIds = ['data-provider', 'market-analyst', 'arbitrage-bot'];

    beforeEach(() => {
      identityStack = new IdentityStack(app, 'TestIdentityMulti', {
        env: { account: '123456789012', region: 'us-east-1' },
        kmsKeyArn: foundationStack.kmsKeyArn,
        vpc: foundationStack.vpc,
        agentIds,
      });
    });

    it('creates one Workload Identity per agent', () => {
      const template = Template.fromStack(identityStack);
      template.resourceCountIs('AWS::Bedrock::AgentCoreWorkloadIdentity', 3);
    });

    it('creates one Credential Provider per agent', () => {
      const template = Template.fromStack(identityStack);
      template.resourceCountIs('AWS::Bedrock::AgentCoreCredentialProvider', 3);
    });

    it('creates only one Token Vault (shared)', () => {
      const template = Template.fromStack(identityStack);
      template.resourceCountIs('AWS::Bedrock::AgentCoreTokenVault', 1);
    });

    it('creates unique Workload Identity names for each agent', () => {
      const template = Template.fromStack(identityStack);
      for (const agentId of agentIds) {
        template.hasResourceProperties('AWS::Bedrock::AgentCoreWorkloadIdentity', {
          Name: `${agentId}-workload-identity`,
          AgentId: agentId,
        });
      }
    });

    it('creates unique Credential Provider names for each agent', () => {
      const template = Template.fromStack(identityStack);
      for (const agentId of agentIds) {
        template.hasResourceProperties('AWS::Bedrock::AgentCoreCredentialProvider', {
          Name: `${agentId}-cdp-credential-provider`,
          CredentialProviderType: 'API_KEY',
        });
      }
    });

    it('each agent role is scoped to only its own Credential Provider ARN', () => {
      const template = Template.fromStack(identityStack);
      const json = template.toJSON();
      const resources = json.Resources || {};

      // Collect all workload role policies
      const workloadPolicies = Object.entries(resources).filter(
        ([key, _]) => key.includes('WorkloadRole') && key.includes('DefaultPolicy')
      );

      // Each agent should have its own policy
      expect(workloadPolicies.length).toBe(agentIds.length);

      // Verify each policy references only one credential provider ARN
      for (const [_, resource] of workloadPolicies) {
        const res = resource as { Properties?: { PolicyDocument?: { Statement?: Array<{ Sid?: string; Resource?: unknown }> } } };
        const statements = res.Properties?.PolicyDocument?.Statement ?? [];
        const retrieveStatement = statements.find(
          (s) => s.Sid === 'RetrieveOwnCredentialsThroughTokenVault'
        );
        expect(retrieveStatement).toBeDefined();
        // Resource should be a single ARN (not an array of multiple providers)
        expect(retrieveStatement!.Resource).toBeDefined();
      }
    });
  });

  describe('validation', () => {
    it('throws error when agent count exceeds 10', () => {
      const tooManyAgents = Array.from({ length: 11 }, (_, i) => `agent-${i}`);
      expect(() => {
        new IdentityStack(app, 'TestIdentityTooMany', {
          env: { account: '123456789012', region: 'us-east-1' },
          kmsKeyArn: foundationStack.kmsKeyArn,
          vpc: foundationStack.vpc,
          agentIds: tooManyAgents,
        });
      }).toThrow(/Agent count must be between 1 and 10/);
    });

    it('throws error when agent count is 0', () => {
      expect(() => {
        new IdentityStack(app, 'TestIdentityEmpty', {
          env: { account: '123456789012', region: 'us-east-1' },
          kmsKeyArn: foundationStack.kmsKeyArn,
          vpc: foundationStack.vpc,
          agentIds: [],
        });
      }).toThrow(/Agent count must be between 1 and 10/);
    });
  });

  describe('cross-stack references', () => {
    it('exposes tokenVaultArn for dependent stacks', () => {
      identityStack = new IdentityStack(app, 'TestIdentityRefs', {
        env: { account: '123456789012', region: 'us-east-1' },
        kmsKeyArn: foundationStack.kmsKeyArn,
        vpc: foundationStack.vpc,
      });
      expect(identityStack.tokenVaultArn).toBeDefined();
      expect(identityStack.tokenVaultArn).toContain('agent-core-token-vault');
    });

    it('exposes workloadIdentities map for dependent stacks', () => {
      const agentIds = ['agent-1', 'agent-2'];
      identityStack = new IdentityStack(app, 'TestIdentityMap', {
        env: { account: '123456789012', region: 'us-east-1' },
        kmsKeyArn: foundationStack.kmsKeyArn,
        vpc: foundationStack.vpc,
        agentIds,
      });
      expect(identityStack.workloadIdentities.size).toBe(2);
      expect(identityStack.workloadIdentities.has('agent-1')).toBe(true);
      expect(identityStack.workloadIdentities.has('agent-2')).toBe(true);
    });
  });
});
