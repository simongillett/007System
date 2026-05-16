import fc from 'fast-check';
import { TaskRouter, AgentInvoker } from '../lib/agents/task-router';
import {
  CollaboratorAgentConfig,
  TaskDelegation,
  DelegationResult,
} from '../lib/types/supervisor';

/**
 * Property-Based Test: Task Routing Correctness
 * Feature: multi-agent-trading-system, Property 1: Task Routing Correctness
 *
 * For any set of registered specialized agents with declared task-types and
 * for any incoming task with a declared type, the supervisor SHALL route the
 * task to the agent whose task-type matches the declared type if one exists,
 * OR reject the task with an error specifying the unrecognized type if no match exists.
 *
 * **Validates: Requirements 1.2, 1.7**
 */

// --- Generators ---

/**
 * Generate a valid agent ID (non-empty alphanumeric with dashes).
 */
const agentIdArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/**
 * Generate a valid task type string (non-empty, alphanumeric with dashes).
 */
const taskTypeArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}$/);

/**
 * Generate a set of unique task types (1-5 per agent).
 */
const taskTypesArb = fc
  .uniqueArray(taskTypeArb, { minLength: 1, maxLength: 5 })
  .filter((arr) => arr.length >= 1);

/**
 * Generate a CollaboratorAgentConfig with arbitrary task-types.
 */
const agentConfigArb = fc
  .tuple(agentIdArb, fc.string({ minLength: 1, maxLength: 10 }), taskTypesArb)
  .map(
    ([agentId, aliasId, taskTypes]): CollaboratorAgentConfig => ({
      agentId,
      agentAliasId: `${aliasId}-alias`,
      taskTypes,
      description: `Agent ${agentId}`,
      timeoutSeconds: 30,
      maxRetries: 1,
    })
  );

/**
 * Generate a set of 1-10 agents with unique agent IDs.
 * Ensures no two agents share the same task type (routing is deterministic).
 */
const agentSetArb = fc
  .uniqueArray(agentConfigArb, {
    minLength: 1,
    maxLength: 10,
    selector: (a) => a.agentId,
  })
  .map((agents) => {
    // Ensure no two agents share the same task type for deterministic routing
    const usedTypes = new Set<string>();
    return agents.map((agent) => {
      const uniqueTypes = agent.taskTypes.filter((t) => !usedTypes.has(t));
      if (uniqueTypes.length === 0) {
        // Generate a unique type for this agent
        const uniqueType = `${agent.agentId}-task`;
        usedTypes.add(uniqueType);
        return { ...agent, taskTypes: [uniqueType] };
      }
      uniqueTypes.forEach((t) => usedTypes.add(t));
      return { ...agent, taskTypes: uniqueTypes };
    });
  });

/**
 * Generate a TaskDelegation with a given task type.
 */
function taskDelegationArb(taskType: string): fc.Arbitrary<TaskDelegation> {
  return fc.record({
    taskId: fc.uuid(),
    taskType: fc.constant(taskType),
    payload: fc.constant({ data: 'test' }),
    sourceAgentId: fc.constant('supervisor'),
    delegatedAt: fc.constant(new Date().toISOString()),
  });
}

/**
 * Create a mock invoker that immediately resolves with a completed result.
 */
function createImmediateInvoker(): AgentInvoker {
  return {
    invoke: jest
      .fn()
      .mockImplementation(
        (
          _agent: CollaboratorAgentConfig,
          task: TaskDelegation
        ): Promise<DelegationResult> => {
          return Promise.resolve({
            taskId: task.taskId,
            status: 'completed',
            result: { routed: true },
          });
        }
      ),
  };
}

// --- Property Tests ---

describe('Feature: multi-agent-trading-system, Property 1: Task Routing Correctness', () => {
  describe('Property 1a: Matching task types route to the correct agent', () => {
    /**
     * **Validates: Requirements 1.2**
     *
     * For any set of agents (1-10) with arbitrary task-types, and any incoming
     * task whose type matches one of the registered types, the router SHALL
     * route to the correct agent (the one whose taskTypes array contains the task type).
     */
    it('should route any matching task type to the correct agent', async () => {
      await fc.assert(
        fc.asyncProperty(
          agentSetArb.filter((agents) => {
            // Ensure at least one agent has at least one task type
            return agents.some((a) => a.taskTypes.length > 0);
          }),
          fc.context(),
          async (agents, ctx) => {
            // Collect all registered task types with their owning agent
            const typeToAgent = new Map<string, string>();
            for (const agent of agents) {
              for (const taskType of agent.taskTypes) {
                typeToAgent.set(taskType, agent.agentId);
              }
            }

            // Pick a random registered task type
            const allTypes = Array.from(typeToAgent.keys());
            if (allTypes.length === 0) return; // skip if no types

            // Test with each registered type
            const typeIndex = Math.floor(Math.random() * allTypes.length);
            const selectedType = allTypes[typeIndex];
            const expectedAgentId = typeToAgent.get(selectedType)!;

            ctx.log(
              `Testing type '${selectedType}' → expected agent '${expectedAgentId}'`
            );

            const invoker = createImmediateInvoker();
            const router = new TaskRouter(agents, invoker);

            const task: TaskDelegation = {
              taskId: `task-${Date.now()}`,
              taskType: selectedType,
              payload: { test: true },
              sourceAgentId: 'supervisor',
              delegatedAt: new Date().toISOString(),
            };

            const result = await router.routeTask(task);

            // The task should be routed successfully
            expect(result.status).toBe('completed');
            expect(result.taskId).toBe(task.taskId);

            // Verify the invoker was called with the correct agent
            expect(invoker.invoke).toHaveBeenCalledTimes(1);
            const calledAgent = (invoker.invoke as jest.Mock).mock
              .calls[0][0] as CollaboratorAgentConfig;
            expect(calledAgent.agentId).toBe(expectedAgentId);
            expect(calledAgent.taskTypes).toContain(selectedType);
          }
        ),
        { verbose: true }
      );
    });

    it('should find the correct matching agent for any registered task type', () => {
      fc.assert(
        fc.property(agentSetArb, (agents) => {
          const invoker = createImmediateInvoker();
          const router = new TaskRouter(agents, invoker);

          // For every agent and every task type it registers, findMatchingAgent should return that agent
          for (const agent of agents) {
            for (const taskType of agent.taskTypes) {
              const matched = router.findMatchingAgent(taskType);
              expect(matched).not.toBeNull();
              expect(matched!.agentId).toBe(agent.agentId);
              expect(matched!.taskTypes).toContain(taskType);
            }
          }
        }),
        { verbose: true }
      );
    });
  });

  describe('Property 1b: Non-matching task types are rejected with error', () => {
    /**
     * **Validates: Requirements 1.7**
     *
     * For any set of agents with arbitrary task-types, and any incoming task
     * whose type does NOT match any registered type, the router SHALL reject
     * with a failed status and an error specifying the unrecognized type.
     */
    it('should reject any non-matching task type with failed status and error', async () => {
      await fc.assert(
        fc.asyncProperty(
          agentSetArb,
          taskTypeArb,
          fc.context(),
          async (agents, candidateType, ctx) => {
            // Collect all registered task types
            const allRegisteredTypes = new Set<string>();
            for (const agent of agents) {
              for (const taskType of agent.taskTypes) {
                allRegisteredTypes.add(taskType);
              }
            }

            // Only test if the candidate type is NOT registered
            fc.pre(!allRegisteredTypes.has(candidateType));

            ctx.log(
              `Testing unrecognized type '${candidateType}' against ${agents.length} agents`
            );

            const invoker = createImmediateInvoker();
            const router = new TaskRouter(agents, invoker);

            const task: TaskDelegation = {
              taskId: `task-${Date.now()}`,
              taskType: candidateType,
              payload: { test: true },
              sourceAgentId: 'supervisor',
              delegatedAt: new Date().toISOString(),
            };

            const result = await router.routeTask(task);

            // The task should be rejected
            expect(result.status).toBe('failed');
            expect(result.taskId).toBe(task.taskId);

            // Error should specify the unrecognized type
            expect(result.error).toBeDefined();
            expect(result.error!.taskType).toBe(candidateType);
            expect(result.error!.reason).toContain(candidateType);
            expect(result.error!.reason.toLowerCase()).toContain(
              'unrecognized'
            );

            // The invoker should NOT have been called
            expect(invoker.invoke).not.toHaveBeenCalled();
          }
        ),
        { verbose: true }
      );
    });

    it('should return null from findMatchingAgent for any unregistered type', () => {
      fc.assert(
        fc.property(agentSetArb, taskTypeArb, (agents, candidateType) => {
          // Collect all registered task types
          const allRegisteredTypes = new Set<string>();
          for (const agent of agents) {
            for (const taskType of agent.taskTypes) {
              allRegisteredTypes.add(taskType);
            }
          }

          // Only test if the candidate type is NOT registered
          fc.pre(!allRegisteredTypes.has(candidateType));

          const invoker = createImmediateInvoker();
          const router = new TaskRouter(agents, invoker);

          const matched = router.findMatchingAgent(candidateType);
          expect(matched).toBeNull();
        }),
        { verbose: true }
      );
    });
  });
});
