import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { IdentityStack } from '../lib/identity-stack';
import { AgentStack } from '../lib/agent-stack';
import { PaymentStack } from '../lib/payment-stack';
import { MerchantStack } from '../lib/merchant-stack';
import { GovernanceStack } from '../lib/governance-stack';

describe('CDK Application Structure', () => {
  test('all stacks can be instantiated', () => {
    const app = new cdk.App();

    const foundationStack = new FoundationStack(app, 'TestFoundation');
    const identityStack = new IdentityStack(app, 'TestIdentity', {
      kmsKeyArn: foundationStack.kmsKeyArn,
      vpc: foundationStack.vpc,
    });
    const agentStack = new AgentStack(app, 'TestAgent');
    const paymentStack = new PaymentStack(app, 'TestPayment', {
      kmsKeyArn: foundationStack.kmsKeyArn,
      vpc: foundationStack.vpc,
    });
    const merchantStack = new MerchantStack(app, 'TestMerchant');
    const governanceStack = new GovernanceStack(app, 'TestGovernance');

    expect(foundationStack).toBeDefined();
    expect(identityStack).toBeDefined();
    expect(agentStack).toBeDefined();
    expect(paymentStack).toBeDefined();
    expect(merchantStack).toBeDefined();
    expect(governanceStack).toBeDefined();
  });

  test('stacks synthesize without errors', () => {
    const app = new cdk.App();

    new FoundationStack(app, 'TestFoundation');
    new AgentStack(app, 'TestAgent');
    new MerchantStack(app, 'TestMerchant');
    new GovernanceStack(app, 'TestGovernance');

    expect(() => app.synth()).not.toThrow();
  });
});
