import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SupervisorAgent } from './constructs/supervisor-agent';
import { SpecializedAgent } from './constructs/specialized-agent';
import { SupervisorAgentConfig, CollaboratorAgentConfig } from './types/supervisor';

/**
 * Default collaborator agents for the trading system.
 * Each agent has registered task-types for routing, a 30-second timeout, and 1 retry.
 */
const DEFAULT_COLLABORATOR_AGENTS: CollaboratorAgentConfig[] = [
  {
    agentId: 'data-provider',
    agentAliasId: 'data-provider-alias',
    taskTypes: ['data-provision', 'market-data'],
    description: 'Provides market data and data feeds to other agents',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
  {
    agentId: 'market-analyst',
    agentAliasId: 'market-analyst-alias',
    taskTypes: ['market-analysis', 'price-evaluation'],
    description: 'Analyzes market conditions and evaluates pricing opportunities',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
  {
    agentId: 'service-executor',
    agentAliasId: 'service-executor-alias',
    taskTypes: ['service-execution', 'task-fulfillment'],
    description: 'Executes service requests and fulfills trading tasks',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
  {
    agentId: 'arbitrage-agent',
    agentAliasId: 'arbitrage-agent-alias',
    taskTypes: ['arbitrage', 'price-comparison'],
    description: 'Identifies and executes arbitrage opportunities across services',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
];

export interface AgentStackProps extends cdk.StackProps {
  /**
   * Collaborator agent configurations.
   * Each agent has registered task-types for routing from the Supervisor.
   * Supports 1-10 agents (Requirement 1.1).
   * Defaults to 4 standard trading agents if not specified.
   */
  collaboratorAgents?: CollaboratorAgentConfig[];

  /**
   * The foundation model ID for all agents.
   * Defaults to anthropic.claude-sonnet-4-20250514.
   */
  modelId?: string;

  /**
   * Session memory TTL in hours.
   * Minimum 24 hours (Requirement 9.5).
   * Defaults to 24.
   */
  sessionMemoryTtlHours?: number;

  /**
   * Token Vault ARN from IdentityStack for credential retrieval.
   * Used by agents to access their CDP credentials at runtime.
   */
  tokenVaultArn?: string;
}

/**
 * AgentStack provisions the multi-agent orchestration layer.
 *
 * Architecture:
 * - One Supervisor Agent (orchestrates all collaborators, supervisor mode)
 * - N Specialized Agents (1-10, each with registered task-types)
 * - IAM SigV4 authentication on the AgentCore API gateway
 * - Session memory with 24-hour TTL for state retention
 * - 30-second timeout and 1 retry for all delegations
 *
 * The Supervisor Agent:
 * - Receives trading tasks via the AgentCore API Gateway (IAM SigV4 authenticated)
 * - Matches tasks to specialized agents by declared task-type
 * - Delegates with a 30-second timeout, retries once on timeout
 * - Selects next action: delegate further, return result, or initiate error handling
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.5
 */
export class AgentStack extends cdk.Stack {
  /** The Supervisor Agent construct */
  public readonly supervisorAgent: SupervisorAgent;

  /** Map of agent ID to their SpecializedAgent construct */
  public readonly specializedAgents: Map<string, SpecializedAgent>;

  /** The Supervisor Agent ARN for cross-stack references */
  public readonly supervisorAgentArn: string;

  constructor(scope: Construct, id: string, props?: AgentStackProps) {
    super(scope, id, props);

    const modelId = props?.modelId ?? 'anthropic.claude-sonnet-4-20250514';
    const sessionMemoryTtlHours = props?.sessionMemoryTtlHours ?? 24;
    const collaboratorAgents = props?.collaboratorAgents ?? DEFAULT_COLLABORATOR_AGENTS;
    const tokenVaultArn = props?.tokenVaultArn;

    // Validate agent count (1-10 per Requirement 1.1)
    if (collaboratorAgents.length < 1 || collaboratorAgents.length > 10) {
      throw new Error(
        `Collaborator agent count must be between 1 and 10, got ${collaboratorAgents.length}`
      );
    }

    // Validate session memory TTL (minimum 24 hours per Requirement 9.5)
    if (sessionMemoryTtlHours < 24) {
      throw new Error(
        `Session memory TTL must be at least 24 hours, got ${sessionMemoryTtlHours}`
      );
    }

    // Validate delegation configuration (Requirement 1.4, 1.5)
    for (const collab of collaboratorAgents) {
      if (collab.timeoutSeconds !== 30) {
        throw new Error(
          `Collaborator ${collab.agentId} timeout must be 30 seconds, got ${collab.timeoutSeconds}`
        );
      }
      if (collab.maxRetries !== 1) {
        throw new Error(
          `Collaborator ${collab.agentId} maxRetries must be 1, got ${collab.maxRetries}`
        );
      }
    }

    // --- Supervisor Agent Configuration ---
    const supervisorConfig: SupervisorAgentConfig = {
      agentName: 'trading-system-supervisor',
      modelId,
      collaboratorAgents,
      sessionMemoryTtlHours,
      apiGatewayAuth: 'IAM_SIGV4',
    };

    // --- Supervisor Agent ---
    this.supervisorAgent = new SupervisorAgent(this, 'SupervisorAgent', {
      config: supervisorConfig,
    });

    this.supervisorAgentArn = this.supervisorAgent.agentArn;

    // --- Specialized Agents ---
    this.specializedAgents = new Map<string, SpecializedAgent>();

    for (const collabConfig of collaboratorAgents) {
      const specializedAgent = new SpecializedAgent(
        this,
        `SpecializedAgent-${collabConfig.agentId}`,
        {
          config: collabConfig,
          modelId,
          supervisorAgentArn: this.supervisorAgent.agentArn,
        }
      );

      this.specializedAgents.set(collabConfig.agentId, specializedAgent);
    }

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'SupervisorAgentArn', {
      value: this.supervisorAgent.agentArn,
      description: 'Supervisor Agent ARN',
      exportName: 'TradingSystem-SupervisorAgentArn',
    });

    new cdk.CfnOutput(this, 'CollaboratorCount', {
      value: collaboratorAgents.length.toString(),
      description: 'Number of specialized collaborator agents',
    });

    new cdk.CfnOutput(this, 'SessionMemoryTtlHours', {
      value: sessionMemoryTtlHours.toString(),
      description: 'Session memory TTL in hours',
    });

    if (tokenVaultArn) {
      new cdk.CfnOutput(this, 'TokenVaultArnRef', {
        value: tokenVaultArn,
        description: 'Token Vault ARN reference from IdentityStack',
      });
    }
  }
}
