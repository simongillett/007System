import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AgentIdentity } from './constructs/agent-identity';

export interface IdentityStackProps extends cdk.StackProps {
  /** List of agent IDs to create identities for */
  agentIds?: string[];
  /** CDP API key value to register in each agent's credential provider */
  cdpApiKey?: cdk.SecretValue;
}

/**
 * IdentityStack provisions AgentCore Identity resources:
 * - One WorkloadIdentity per agent
 * - One ApiKeyCredentialProvider per agent (stores CDP key in Token Vault)
 */
export class IdentityStack extends cdk.Stack {
  public readonly agentIdentities: Map<string, AgentIdentity>;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const agentIds = props?.agentIds ?? ['agent-default'];
    this.agentIdentities = new Map();

    for (const agentId of agentIds) {
      const identity = new AgentIdentity(this, `Agent-${agentId}`, {
        agentId,
        apiKey: props?.cdpApiKey,
      });
      this.agentIdentities.set(agentId, identity);
    }

    new cdk.CfnOutput(this, 'AgentCount', {
      value: agentIds.length.toString(),
      description: 'Number of agent identities provisioned',
    });
  }
}
