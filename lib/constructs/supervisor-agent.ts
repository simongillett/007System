import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { SupervisorAgentConfig } from '../types/supervisor';

/**
 * Properties for the SupervisorAgent construct.
 */
export interface SupervisorAgentProps {
  /** Configuration for the Supervisor Agent */
  config: SupervisorAgentConfig;
}

/**
 * SupervisorAgent construct models the top-level orchestrating agent in AgentCore.
 *
 * The Supervisor Agent:
 * - Operates in "Supervisor" mode (synthesizes responses from collaborators)
 * - Receives trading tasks via the AgentCore API Gateway (IAM SigV4 authenticated)
 * - Matches tasks to specialized agents by declared task-type
 * - Delegates with a 30-second timeout, retries once on timeout
 * - Maintains session memory with configurable TTL (minimum 24 hours)
 *
 * Security (Requirement 9.4 — IAM least-privilege):
 * - No wildcard actions in any policy statement
 * - Resource ARNs scoped to specific resources
 * - IAM SigV4 authentication on API gateway (Requirement 1.6)
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.5
 */
export class SupervisorAgent extends Construct {
  /** The IAM role for the Supervisor Agent */
  public readonly agentRole: iam.IRole;

  /** ARN of the Supervisor Agent resource */
  public readonly agentArn: string;

  /** The agent name */
  public readonly agentName: string;

  /** The CfnResource representing the Supervisor Agent */
  public readonly agentResource: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: SupervisorAgentProps) {
    super(scope, id);

    const { config } = props;
    this.agentName = config.agentName;

    // --- Supervisor Agent IAM Role ---
    // This role is assumed by the AgentCore service to execute the Supervisor Agent.
    // Scoped to invoke only its registered collaborator agents (no wildcards).
    const agentRole = new iam.Role(this, 'SupervisorRole', {
      roleName: `trading-system-supervisor-${config.agentName}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Supervisor Agent role for ${config.agentName} — orchestrates specialized agents`,
    });

    // Permission: Invoke collaborator agents via AgentCore
    // Scoped to specific agent ARNs (no wildcard resources)
    if (config.collaboratorAgents.length > 0) {
      const collaboratorArns = config.collaboratorAgents.map((collab) =>
        cdk.Arn.format(
          {
            service: 'bedrock',
            resource: 'agent',
            resourceName: collab.agentId,
          },
          cdk.Stack.of(this)
        )
      );

      const collaboratorAliasArns = config.collaboratorAgents.map((collab) =>
        cdk.Arn.format(
          {
            service: 'bedrock',
            resource: 'agent-alias',
            resourceName: `${collab.agentId}/${collab.agentAliasId}`,
          },
          cdk.Stack.of(this)
        )
      );

      agentRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'InvokeCollaboratorAgents',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeAgent',
            'bedrock:GetAgent',
          ],
          resources: [...collaboratorArns, ...collaboratorAliasArns],
        })
      );
    }

    // Permission: Use the foundation model for reasoning
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeFoundationModel',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [
          cdk.Arn.format(
            {
              service: 'bedrock',
              resource: 'foundation-model',
              resourceName: config.modelId,
            },
            cdk.Stack.of(this)
          ),
        ],
      })
    );

    this.agentRole = agentRole;

    // --- Supervisor Agent Resource ---
    // Models the AgentCore Supervisor Agent in managed runtime with supervisor mode.
    // Collaborator associations are configured inline with task-type routing.
    this.agentResource = new cdk.CfnResource(this, 'SupervisorAgentResource', {
      type: 'AWS::Bedrock::AgentCoreAgent',
      properties: {
        AgentName: config.agentName,
        AgentMode: 'SUPERVISOR',
        RuntimeMode: 'MANAGED',
        FoundationModel: config.modelId,
        AgentRoleArn: agentRole.roleArn,
        // IAM SigV4 authentication on the API gateway (Requirement 1.6)
        ApiGatewayConfiguration: {
          AuthenticationType: config.apiGatewayAuth,
        },
        // Session memory with configurable TTL (Requirement 9.5)
        SessionMemoryConfiguration: {
          SessionTtlSeconds: config.sessionMemoryTtlHours * 3600,
        },
        // Collaborator agent associations with task-type routing
        CollaboratorConfiguration: {
          Collaborators: config.collaboratorAgents.map((collab) => ({
            AgentId: collab.agentId,
            AgentAliasId: collab.agentAliasId,
            CollaboratorName: collab.agentId,
            Description: collab.description,
            TaskTypes: collab.taskTypes,
            DelegationConfiguration: {
              TimeoutSeconds: collab.timeoutSeconds,
              MaxRetries: collab.maxRetries,
            },
          })),
        },
        Description: `Supervisor Agent for the multi-agent trading system. Orchestrates ${config.collaboratorAgents.length} specialized agents.`,
      },
    });

    this.agentArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-agent',
        resourceName: config.agentName,
      },
      cdk.Stack.of(this)
    );

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'SupervisorAgentArn', {
      value: this.agentArn,
      description: `Supervisor Agent ARN for ${config.agentName}`,
    });
  }
}
