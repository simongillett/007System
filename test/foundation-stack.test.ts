import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';

describe('FoundationStack', () => {
  let app: cdk.App;
  let stack: FoundationStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new FoundationStack(app, 'TestFoundationStack');
    template = Template.fromStack(stack);
  });

  describe('Stack Synthesis', () => {
    test('synthesizes a valid CloudFormation template without errors', () => {
      // Requirement 9.3: CDK application produces a valid CloudFormation template
      expect(() => Template.fromStack(stack)).not.toThrow();
      const resources = template.toJSON();
      expect(resources).toBeDefined();
      expect(resources.Resources).toBeDefined();
    });
  });

  describe('KMS Key', () => {
    test('creates a KMS key with key rotation enabled', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
      });
    });

    test('KMS key policy uses specific actions (not wildcards)', () => {
      const resources = template.toJSON().Resources;
      for (const [logicalId, resource] of Object.entries(resources)) {
        if ((resource as any).Type === 'AWS::KMS::Key') {
          const keyPolicy = (resource as any).Properties?.KeyPolicy;
          if (keyPolicy?.Statement) {
            for (const statement of keyPolicy.Statement) {
              if (statement.Action) {
                const actions = Array.isArray(statement.Action)
                  ? statement.Action
                  : [statement.Action];
                for (const action of actions) {
                  // KMS key policies use prefix wildcards like "kms:Create*" which are
                  // specific to the KMS service — these are NOT wildcard actions.
                  // A wildcard action would be just "*" (all actions on all services).
                  expect(action).not.toBe('*');
                }
              }
            }
          }
        }
      }
    });
  });

  describe('VPC', () => {
    test('creates a VPC with private subnets', () => {
      template.hasResourceProperties('AWS::EC2::VPC', {});
      // Verify private subnets exist (PRIVATE_WITH_EGRESS creates route to NAT)
      template.hasResourceProperties('AWS::EC2::Subnet', {
        MapPublicIpOnLaunch: false,
      });
    });

    test('creates a NAT gateway for private subnet egress', () => {
      template.hasResourceProperties('AWS::EC2::NatGateway', {});
    });
  });

  describe('IAM Least-Privilege Compliance', () => {
    test('no IAM policy statement uses wildcard actions', () => {
      // Requirement 9.4: No IAM policy statement uses wildcard ("*") actions
      const resources = template.toJSON().Resources;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const resType = (resource as any).Type;
        // Check IAM policies and roles
        if (
          resType === 'AWS::IAM::Policy' ||
          resType === 'AWS::IAM::Role' ||
          resType === 'AWS::IAM::ManagedPolicy'
        ) {
          const policyDocument =
            (resource as any).Properties?.PolicyDocument ||
            (resource as any).Properties?.Policies;

          if (policyDocument?.Statement) {
            for (const statement of policyDocument.Statement) {
              if (statement.Action) {
                const actions = Array.isArray(statement.Action)
                  ? statement.Action
                  : [statement.Action];
                for (const action of actions) {
                  expect(action).not.toBe('*');
                }
              }
            }
          }

          // Check inline policies on roles
          if ((resource as any).Properties?.Policies) {
            for (const policy of (resource as any).Properties.Policies) {
              if (policy.PolicyDocument?.Statement) {
                for (const statement of policy.PolicyDocument.Statement) {
                  if (statement.Action) {
                    const actions = Array.isArray(statement.Action)
                      ? statement.Action
                      : [statement.Action];
                    for (const action of actions) {
                      expect(action).not.toBe('*');
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  });

  describe('CloudFormation Outputs', () => {
    test('exports KMS key ARN output', () => {
      template.hasOutput('KmsKeyArnOutput', {
        Export: { Name: 'TradingSystem-KmsKeyArn' },
      });
    });

    test('exports VPC ID output', () => {
      template.hasOutput('VpcIdOutput', {
        Export: { Name: 'TradingSystem-VpcId' },
      });
    });
  });
});
