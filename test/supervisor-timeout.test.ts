import {
  TaskRouter,
  AgentInvoker,
  TimeoutError,
} from '../lib/agents/task-router';
import {
  CollaboratorAgentConfig,
  TaskDelegation,
  DelegationResult,
} from '../lib/types/supervisor';

/**
 * Unit tests for Supervisor Agent timeout and retry behavior.
 * Validates: Requirements 1.4, 1.5
 *
 * Req 1.4: IF a Specialized_Agent fails to respond within 30 seconds,
 *          THEN THE Supervisor_Agent SHALL retry the delegation to the same
 *          Specialized_Agent once and log the timeout event.
 *
 * Req 1.5: IF a Specialized_Agent fails to respond within 30 seconds after
 *          a retry attempt, THEN THE Supervisor_Agent SHALL mark the task as
 *          failed, log the failure event, and return an error indication to
 *          the caller specifying which agent and task timed out.
 */

const AGENT_WITH_30S_TIMEOUT: CollaboratorAgentConfig = {
  agentId: 'analytics-agent',
  agentAliasId: 'analytics-alias',
  taskTypes: ['analytics', 'reporting'],
  description: 'Analytics agent',
  timeoutSeconds: 30,
  maxRetries: 1,
};

function makeTask(overrides: Partial<TaskDelegation> = {}): TaskDelegation {
  return {
    taskId: 'task-timeout-001',
    taskType: 'analytics',
    payload: { report: 'daily-summary' },
    sourceAgentId: 'supervisor',
    delegatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Supervisor Agent timeout and retry behavior', () => {
  describe('30-second timeout triggers retry (Req 1.4)', () => {
    it('should retry exactly once when the first invocation times out', async () => {
      const task = makeTask();
      const successResult: DelegationResult = {
        taskId: task.taskId,
        status: 'completed',
        result: { data: 'analytics-result' },
      };

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValueOnce(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          )
          .mockResolvedValueOnce(successResult),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('completed');
      expect(invoker.invoke).toHaveBeenCalledTimes(2);
    });

    it('should retry with the same agent on timeout', async () => {
      const task = makeTask();
      const successResult: DelegationResult = {
        taskId: task.taskId,
        status: 'completed',
        result: { data: 'retry-success' },
      };

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValueOnce(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          )
          .mockResolvedValueOnce(successResult),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      await router.delegateToAgent(agent, task);

      // Both calls should use the same agent
      const firstCallAgent = (invoker.invoke as jest.Mock).mock.calls[0][0];
      const secondCallAgent = (invoker.invoke as jest.Mock).mock.calls[1][0];
      expect(firstCallAgent.agentId).toBe('analytics-agent');
      expect(secondCallAgent.agentId).toBe('analytics-agent');
    });

    it('should retry with the same task on timeout', async () => {
      const task = makeTask({ taskId: 'unique-task-42', taskType: 'analytics' });
      const successResult: DelegationResult = {
        taskId: task.taskId,
        status: 'completed',
        result: { data: 'retry-success' },
      };

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValueOnce(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          )
          .mockResolvedValueOnce(successResult),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      await router.delegateToAgent(agent, task);

      // Both calls should use the same task
      const firstCallTask = (invoker.invoke as jest.Mock).mock.calls[0][1];
      const secondCallTask = (invoker.invoke as jest.Mock).mock.calls[1][1];
      expect(firstCallTask.taskId).toBe('unique-task-42');
      expect(secondCallTask.taskId).toBe('unique-task-42');
      expect(firstCallTask).toEqual(secondCallTask);
    });

    it('should return the successful result from the retry attempt', async () => {
      const task = makeTask();
      const retryResult: DelegationResult = {
        taskId: task.taskId,
        status: 'completed',
        result: { data: 'from-retry-attempt' },
      };

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValueOnce(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          )
          .mockResolvedValueOnce(retryResult),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('completed');
      expect(result.result).toEqual({ data: 'from-retry-attempt' });
    });

    it('should trigger timeout based on configured timeoutSeconds using real timer', async () => {
      const task = makeTask();

      // Agent that never responds
      const invoker: AgentInvoker = {
        invoke: jest.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        ),
      };

      // Use very short timeout for test speed (50ms simulates the 30s behavior)
      const fastAgent: CollaboratorAgentConfig = {
        ...AGENT_WITH_30S_TIMEOUT,
        timeoutSeconds: 0.05,
        maxRetries: 0, // No retries - just test the timeout fires
      };

      const router = new TaskRouter([fastAgent], invoker);
      const result = await router.routeTask(task);

      expect(result.status).toBe('timeout');
    }, 10000);
  });

  describe('failure after retry returns error with agent/task info (Req 1.5)', () => {
    it('should return status "timeout" when both attempts time out', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('timeout');
    });

    it('should include the agent ID that timed out in the error', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.error).toBeDefined();
      expect(result.error!.agentId).toBe('analytics-agent');
    });

    it('should include the task type that was being processed in the error', async () => {
      const task = makeTask({ taskType: 'reporting' });

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.error).toBeDefined();
      expect(result.error!.taskType).toBe('reporting');
    });

    it('should mention the timeout duration in the error reason', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.error!.reason).toContain('30');
    });

    it('should mention the number of attempts in the error reason', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.error!.reason).toContain('2 attempts exhausted');
    });

    it('should mention the agent ID in the error reason message', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.error!.reason).toContain('analytics-agent');
    });

    it('should invoke exactly 2 times (1 initial + 1 retry) before failing', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      await router.delegateToAgent(agent, task);

      expect(invoker.invoke).toHaveBeenCalledTimes(2);
    });

    it('should work correctly with different agent configurations', async () => {
      const customAgent: CollaboratorAgentConfig = {
        agentId: 'slow-processor',
        agentAliasId: 'slow-alias',
        taskTypes: ['heavy-compute'],
        description: 'Slow processing agent',
        timeoutSeconds: 30,
        maxRetries: 1,
      };

      const task = makeTask({ taskType: 'heavy-compute' });

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('slow-processor', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([customAgent], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('timeout');
      expect(result.error!.agentId).toBe('slow-processor');
      expect(result.error!.taskType).toBe('heavy-compute');
      expect(result.error!.reason).toContain('slow-processor');
      expect(result.error!.reason).toContain('2 attempts exhausted');
    });

    it('should preserve the task ID in the result on timeout failure', async () => {
      const task = makeTask({ taskId: 'important-task-99' });

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('analytics-agent', task.taskId, 30000)
          ),
      };

      const router = new TaskRouter([AGENT_WITH_30S_TIMEOUT], invoker);
      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.taskId).toBe('important-task-99');
    });
  });
});
