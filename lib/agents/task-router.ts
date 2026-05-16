/**
 * Task Router for the Supervisor Agent.
 *
 * Implements the runtime routing logic that:
 * - Matches incoming task types to registered agent task-types (Req 1.2)
 * - Delegates tasks with a 30-second timeout (Req 1.4)
 * - Retries once on timeout (Req 1.4)
 * - Returns error after retry exhaustion with agent/task info (Req 1.5)
 * - Selects next action: delegate further, return result, or error handling (Req 1.3)
 * - Rejects unrecognized task types (Req 1.7)
 */

import {
  CollaboratorAgentConfig,
  TaskDelegation,
  DelegationResult,
} from '../types/supervisor';

/**
 * Interface for the agent invocation adapter.
 * This abstracts the actual AgentCore invocation so the router logic
 * is testable without real infrastructure.
 */
export interface AgentInvoker {
  /**
   * Invoke a collaborator agent with the given task.
   * Should reject with a TimeoutError if the agent does not respond in time.
   */
  invoke(
    agent: CollaboratorAgentConfig,
    task: TaskDelegation
  ): Promise<DelegationResult>;
}

/**
 * Error thrown when an agent invocation times out.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly taskId: string,
    public readonly timeoutMs: number
  ) {
    super(
      `Agent '${agentId}' timed out after ${timeoutMs}ms for task '${taskId}'`
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Next action the supervisor should take after receiving a delegation result.
 */
export type NextAction = 'delegate' | 'return' | 'error';

/**
 * TaskRouter implements the Supervisor Agent's task routing logic.
 *
 * It matches incoming tasks to registered agents by task-type,
 * delegates with timeout and retry, and determines the next action.
 */
export class TaskRouter {
  private readonly agents: CollaboratorAgentConfig[];
  private readonly invoker: AgentInvoker;

  constructor(agents: CollaboratorAgentConfig[], invoker: AgentInvoker) {
    this.agents = agents;
    this.invoker = invoker;
  }

  /**
   * Route a task to the appropriate agent based on task type.
   *
   * - Finds the matching agent by task-type (Req 1.2)
   * - Rejects with error if no agent matches (Req 1.7)
   * - Delegates with timeout and single retry (Req 1.4, 1.5)
   */
  async routeTask(task: TaskDelegation): Promise<DelegationResult> {
    const agent = this.findMatchingAgent(task.taskType);

    if (!agent) {
      return {
        taskId: task.taskId,
        status: 'failed',
        error: {
          agentId: '',
          taskType: task.taskType,
          reason: `Unrecognized task type: '${task.taskType}'. No registered agent handles this type.`,
        },
      };
    }

    return this.delegateToAgent(agent, task);
  }

  /**
   * Find the agent whose registered task-types include the given taskType.
   * Returns null if no agent matches.
   */
  findMatchingAgent(taskType: string): CollaboratorAgentConfig | null {
    return (
      this.agents.find((agent) => agent.taskTypes.includes(taskType)) ?? null
    );
  }

  /**
   * Delegate a task to a specific agent with timeout and single retry.
   *
   * - First attempt: invoke with configured timeout (Req 1.4)
   * - On timeout: retry once (Req 1.4)
   * - On second timeout: return failed result with agent/task info (Req 1.5)
   */
  async delegateToAgent(
    agent: CollaboratorAgentConfig,
    task: TaskDelegation
  ): Promise<DelegationResult> {
    const maxAttempts = agent.maxRetries + 1; // 1 initial + 1 retry = 2 attempts

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.invokeWithTimeout(agent, task);
        return result;
      } catch (error) {
        if (error instanceof TimeoutError) {
          // If we have retries left, continue to next attempt
          if (attempt < maxAttempts) {
            continue;
          }
          // All retries exhausted — return failure (Req 1.5)
          return {
            taskId: task.taskId,
            status: 'timeout',
            error: {
              agentId: agent.agentId,
              taskType: task.taskType,
              reason: `Agent '${agent.agentId}' timed out after ${agent.timeoutSeconds}s (${maxAttempts} attempts exhausted) for task type '${task.taskType}'.`,
            },
          };
        }
        // Non-timeout errors are returned immediately as failures
        return {
          taskId: task.taskId,
          status: 'failed',
          error: {
            agentId: agent.agentId,
            taskType: task.taskType,
            reason:
              error instanceof Error
                ? error.message
                : 'Unknown delegation error',
          },
        };
      }
    }

    // Should not reach here, but TypeScript needs a return
    return {
      taskId: task.taskId,
      status: 'failed',
      error: {
        agentId: agent.agentId,
        taskType: task.taskType,
        reason: 'Unexpected routing error',
      },
    };
  }

  /**
   * Determine the next action based on a delegation result.
   *
   * - 'return': result is complete, return to caller (Req 1.3)
   * - 'delegate': result indicates further delegation is needed (Req 1.3)
   * - 'error': result indicates a failure requiring error handling (Req 1.3)
   */
  selectNextAction(result: DelegationResult): NextAction {
    if (result.status === 'failed' || result.status === 'timeout') {
      return 'error';
    }

    // If the completed result contains a 'nextTaskType' in its payload,
    // it signals that further delegation is needed.
    if (
      result.status === 'completed' &&
      result.result &&
      typeof result.result['nextTaskType'] === 'string'
    ) {
      return 'delegate';
    }

    // Successful completion with no further delegation needed
    return 'return';
  }

  /**
   * Invoke an agent with a timeout wrapper.
   * Rejects with TimeoutError if the agent doesn't respond within the configured timeout.
   */
  private async invokeWithTimeout(
    agent: CollaboratorAgentConfig,
    task: TaskDelegation
  ): Promise<DelegationResult> {
    const timeoutMs = agent.timeoutSeconds * 1000;

    return new Promise<DelegationResult>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new TimeoutError(agent.agentId, task.taskId, timeoutMs));
        }
      }, timeoutMs);

      this.invoker
        .invoke(agent, task)
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        });
    });
  }
}
