import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { CollaboratorAgentConfig } from '../types/supervisor';

/**
 * Properties for the SpecializedAgent construct.
 */
export interface SpecializedAgentProps {
  /** Configuration for this collaborator agent */
  config: CollaboratorAgentConfig;

  /** The foundation model ID for this agent's reasoning */
  modelId: string;

  /** ARN of the Supervisor Agent this agent is associated with */
  supervisorAgentArn: string;
}

/**
 * SpecializedAgent construct models a purpose-built collaborator agent in AgentCore.
 *
 * Each Specialized Agent:
 * - Has registered task-types for routing from the Supervisor
 * - Operates in AgentCore managed runtime
 * - Is associated with the Supervisor Agent for delegation
 * - Has a 30-second timeout and 1 retry for delegations (configured on Supervisor side)
 * - Gets its own IAM role scoped to its specific capabilities
 *
 * Security (Requirement 9.4 — IAM least-privilege):
 * - No wildcard actions in any policy statement
 * - Resource ARNs scoped to specific resources
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5
 */
export class SpecializedAgent extends Construct {
  /** The IAM role for this Specialized Agent */
  public readonly agentRole: iam.IRole;

  /** ARN of the Specialized Agent resource */
  public readonly agentArn: string;

  /** The agent ID */
  public readonly agentId: string;

  /** The registered task-types for routing */
  public readonly taskTypes: string[];

  /** The CfnResource representing the Specialized Agent */
  public readonly agentResource: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: SpecializedAgentProps) {
    super(scope, id);

    const { config, modelId, supervisorAgentArn } = props;
    this.agentId = config.agentId;
    this.taskTypes = config.taskTypes;

    // --- Specialized Agent IAM Role ---
    // Scoped to this agent's specific capabilities (no wildcards).
    const agentRole = new iam.Role(this, 'AgentRole', {
      roleName: `trading-system-agent-${config.agentId}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Specialized Agent role for ${config.agentId} — task types: ${config.taskTypes.join(', ')}`,
    });

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
              resourceName: modelId,
            },
            cdk.Stack.of(this)
          ),
        ],
      })
    );

    // Permission: Allow the Supervisor to invoke this agent
    // The trust relationship allows the Supervisor's role to call this agent
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowSupervisorInvocation',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:GetAgent'],
        resources: [supervisorAgentArn],
      })
    );

    this.agentRole = agentRole;

    // --- Specialized Agent Resource ---
    // Models the AgentCore Specialized Agent in managed runtime.
    this.agentResource = new cdk.CfnResource(this, 'SpecializedAgentResource', {
      type: 'AWS::Bedrock::AgentCoreAgent',
      properties: {
        AgentName: config.agentId,
        AgentMode: 'COLLABORATOR',
        RuntimeMode: 'MANAGED',
        FoundationModel: modelId,
        AgentRoleArn: agentRole.roleArn,
        // Register task-types for routing from the Supervisor
        TaskTypeConfiguration: {
          TaskTypes: config.taskTypes,
        },
        // Associate with the Supervisor Agent
        SupervisorAssociation: {
          SupervisorAgentArn: supervisorAgentArn,
        },
        Description: config.description,
      },
    });

    this.agentArn = cdk.Arn.format(
      {
        service: 'bedrock',
        resource: 'agent-core-agent',
        resourceName: config.agentId,
      },
      cdk.Stack.of(this)
    );
  }
}
