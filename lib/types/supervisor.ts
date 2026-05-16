/**
 * Supervisor Agent interfaces for multi-agent orchestration.
 * The supervisor coordinates specialized agents, routes tasks, handles timeouts and errors.
 */

export interface SupervisorAgentConfig {
  agentName: string;
  modelId: string;
  collaboratorAgents: CollaboratorAgentConfig[];
  sessionMemoryTtlHours: number;
  apiGatewayAuth: 'IAM_SIGV4';
}

export interface CollaboratorAgentConfig {
  agentId: string;
  agentAliasId: string;
  taskTypes: string[];
  description: string;
  timeoutSeconds: number;
  maxRetries: number;
}

export interface TaskDelegation {
  taskId: string;
  taskType: string;
  payload: Record<string, unknown>;
  sourceAgentId: string;
  delegatedAt: string;
}

export interface DelegationResult {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  result?: Record<string, unknown>;
  error?: {
    agentId: string;
    taskType: string;
    reason: string;
  };
}
