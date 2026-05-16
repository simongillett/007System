import {
  TaskRouter,
  AgentInvoker,
  TimeoutError,
  NextAction,
} from '../lib/agents/task-router';
import {
  CollaboratorAgentConfig,
  TaskDelegation,
  DelegationResult,
} from '../lib/types/supervisor';

/**
 * Test suite for TaskRouter — Supervisor Agent task routing logic.
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7
 */

const TEST_AGENTS: CollaboratorAgentConfig[] = [
  {
    agentId: 'data-provider',
    agentAliasId: 'data-provider-alias',
    taskTypes: ['data-provision', 'market-data'],
    description: 'Provides market data',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
  {
    agentId: 'market-analyst',
    agentAliasId: 'market-analyst-alias',
    taskTypes: ['market-analysis', 'price-evaluation'],
    description: 'Analyzes market conditions',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
  {
    agentId: 'service-executor',
    agentAliasId: 'service-executor-alias',
    taskTypes: ['service-execution', 'task-fulfillment'],
    description: 'Executes service requests',
    timeoutSeconds: 30,
    maxRetries: 1,
  },
];

function makeTask(overrides: Partial<TaskDelegation> = {}): TaskDelegation {
  return {
    taskId: 'task-001',
    taskType: 'data-provision',
    payload: { query: 'market-feed' },
    sourceAgentId: 'supervisor',
    delegatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSuccessResult(taskId: string): DelegationResult {
  return {
    taskId,
    status: 'completed',
    result: { data: 'market-feed-response' },
  };
}

describe('TaskRouter', () => {
  describe('findMatchingAgent', () => {
    it('should find agent by exact task-type match (Req 1.2)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const agent = router.findMatchingAgent('data-provision');
      expect(agent).not.toBeNull();
      expect(agent!.agentId).toBe('data-provider');
    });

    it('should find agent when task-type matches second registered type', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const agent = router.findMatchingAgent('market-data');
      expect(agent).not.toBeNull();
      expect(agent!.agentId).toBe('data-provider');
    });

    it('should return null for unrecognized task type (Req 1.7)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const agent = router.findMatchingAgent('unknown-type');
      expect(agent).toBeNull();
    });

    it('should return null when no agents are registered', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter([], invoker);

      const agent = router.findMatchingAgent('data-provision');
      expect(agent).toBeNull();
    });
  });

  describe('routeTask', () => {
    it('should route task to matching agent and return result (Req 1.2)', async () => {
      const task = makeTask({ taskType: 'market-analysis' });
      const expectedResult = makeSuccessResult(task.taskId);

      const invoker: AgentInvoker = {
        invoke: jest.fn().mockResolvedValue(expectedResult),
      };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result = await router.routeTask(task);

      expect(result.status).toBe('completed');
      expect(result.taskId).toBe(task.taskId);
      expect(result.result).toEqual({ data: 'market-feed-response' });
      expect(invoker.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'market-analyst' }),
        task
      );
    });

    it('should reject unrecognized task type with error (Req 1.7)', async () => {
      const task = makeTask({ taskType: 'unknown-task-type' });
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result = await router.routeTask(task);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.error!.taskType).toBe('unknown-task-type');
      expect(result.error!.reason).toContain('Unrecognized task type');
      expect(result.error!.reason).toContain('unknown-task-type');
      expect(invoker.invoke).not.toHaveBeenCalled();
    });

    it('should retry once on timeout then succeed (Req 1.4)', async () => {
      const task = makeTask();
      const expectedResult = makeSuccessResult(task.taskId);

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValueOnce(
            new TimeoutError('data-provider', task.taskId, 30000)
          )
          .mockResolvedValueOnce(expectedResult),
      };

      // Use a short timeout for testing
      const agents = TEST_AGENTS.map((a) => ({ ...a, timeoutSeconds: 0.01 }));
      const router = new TaskRouter(agents, invoker);

      // Override invokeWithTimeout to use the mock directly
      // We test the retry logic by mocking the invoker
      const routerWithShortTimeout = new TaskRouter(TEST_AGENTS, invoker);
      // Directly test delegateToAgent which handles retry
      const agent = routerWithShortTimeout.findMatchingAgent(task.taskType)!;
      const result = await routerWithShortTimeout.delegateToAgent(agent, task);

      expect(result.status).toBe('completed');
      expect(invoker.invoke).toHaveBeenCalledTimes(2);
    });

    it('should fail after retry exhaustion with agent/task info (Req 1.5)', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest
          .fn()
          .mockRejectedValue(
            new TimeoutError('data-provider', task.taskId, 30000)
          ),
      };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('timeout');
      expect(result.error).toBeDefined();
      expect(result.error!.agentId).toBe('data-provider');
      expect(result.error!.taskType).toBe('data-provision');
      expect(result.error!.reason).toContain('timed out');
      expect(result.error!.reason).toContain('data-provider');
      expect(result.error!.reason).toContain('2 attempts exhausted');
      expect(invoker.invoke).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    });

    it('should return immediately on non-timeout errors', async () => {
      const task = makeTask();

      const invoker: AgentInvoker = {
        invoke: jest.fn().mockRejectedValue(new Error('Agent crashed')),
      };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const agent = router.findMatchingAgent(task.taskType)!;
      const result = await router.delegateToAgent(agent, task);

      expect(result.status).toBe('failed');
      expect(result.error!.reason).toBe('Agent crashed');
      expect(invoker.invoke).toHaveBeenCalledTimes(1); // No retry for non-timeout
    });
  });

  describe('selectNextAction', () => {
    it('should return "return" for completed results (Req 1.3)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result: DelegationResult = {
        taskId: 'task-001',
        status: 'completed',
        result: { data: 'some-data' },
      };

      expect(router.selectNextAction(result)).toBe('return');
    });

    it('should return "delegate" when result signals further delegation (Req 1.3)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result: DelegationResult = {
        taskId: 'task-001',
        status: 'completed',
        result: {
          data: 'intermediate-result',
          nextTaskType: 'market-analysis',
        },
      };

      expect(router.selectNextAction(result)).toBe('delegate');
    });

    it('should return "error" for failed results (Req 1.3)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result: DelegationResult = {
        taskId: 'task-001',
        status: 'failed',
        error: {
          agentId: 'data-provider',
          taskType: 'data-provision',
          reason: 'Agent error',
        },
      };

      expect(router.selectNextAction(result)).toBe('error');
    });

    it('should return "error" for timeout results (Req 1.3)', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result: DelegationResult = {
        taskId: 'task-001',
        status: 'timeout',
        error: {
          agentId: 'data-provider',
          taskType: 'data-provision',
          reason: 'Timed out',
        },
      };

      expect(router.selectNextAction(result)).toBe('error');
    });

    it('should return "return" for completed result with no payload', () => {
      const invoker: AgentInvoker = { invoke: jest.fn() };
      const router = new TaskRouter(TEST_AGENTS, invoker);

      const result: DelegationResult = {
        taskId: 'task-001',
        status: 'completed',
      };

      expect(router.selectNextAction(result)).toBe('return');
    });
  });

  describe('timeout behavior (integration)', () => {
    it('should timeout after configured seconds (Req 1.4)', async () => {
      const task = makeTask();

      // Invoker that never resolves (simulates a hung agent)
      const invoker: AgentInvoker = {
        invoke: jest.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        ),
      };

      // Use very short timeout for test speed
      const agents: CollaboratorAgentConfig[] = [
        {
          ...TEST_AGENTS[0],
          timeoutSeconds: 0.05, // 50ms for testing
          maxRetries: 0, // No retries for this test
        },
      ];
      const router = new TaskRouter(agents, invoker);

      const result = await router.routeTask(task);

      expect(result.status).toBe('timeout');
      expect(result.error!.agentId).toBe('data-provider');
    }, 10000);

    it('should retry once on timeout then fail (Req 1.4, 1.5)', async () => {
      const task = makeTask();

      // Invoker that never resolves
      const invoker: AgentInvoker = {
        invoke: jest.fn().mockImplementation(
          () => new Promise(() => {}) // Never resolves
        ),
      };

      // Use very short timeout for test speed
      const agents: CollaboratorAgentConfig[] = [
        {
          ...TEST_AGENTS[0],
          timeoutSeconds: 0.05, // 50ms for testing
          maxRetries: 1,
        },
      ];
      const router = new TaskRouter(agents, invoker);

      const result = await router.routeTask(task);

      expect(result.status).toBe('timeout');
      expect(invoker.invoke).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    }, 10000);
  });
});
