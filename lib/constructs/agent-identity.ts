import { Construct } from 'constructs';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';

/**
 * Props for a per-agent WorkloadIdentity + ApiKeyCredentialProvider pair.
 */
export interface AgentIdentityProps {
  /** Unique agent identifier */
  agentId: string;
  /** The CDP API key value to register in Token Vault (SecretValue) */
  apiKey?: import('aws-cdk-lib').SecretValue;
}

/**
 * Creates a WorkloadIdentity and ApiKeyCredentialProvider for a single agent
 * using the CDK 2.257+ L2 constructs.
 */
export class AgentIdentity extends Construct {
  public readonly workloadIdentity: bedrockagentcore.IWorkloadIdentity;
  public readonly credentialProvider: bedrockagentcore.IApiKeyCredentialProvider;

  constructor(scope: Construct, id: string, props: AgentIdentityProps) {
    super(scope, id);

    this.workloadIdentity = new bedrockagentcore.WorkloadIdentity(this, 'Identity', {
      workloadIdentityName: `${props.agentId}-identity`,
      tags: { agentId: props.agentId },
    });

    this.credentialProvider = new bedrockagentcore.ApiKeyCredentialProvider(this, 'CdpKey', {
      apiKeyCredentialProviderName: `${props.agentId}-cdp-key`,
      apiKey: props.apiKey,
      tags: { agentId: props.agentId },
    });
  }
}
