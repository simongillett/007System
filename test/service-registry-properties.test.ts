/**
 * Property-based tests for Service Registry.
 *
 * Feature: multi-agent-trading-system
 *
 * Tests:
 * - Property 20: Service Registry Entry Validation
 * - Property 21: Service Registry Tag-Based Query
 */

import fc from 'fast-check';
import {
  DefaultServiceRegistry,
  RegistryStore,
  RegistryClock,
  ServiceRegistryDependencies,
  ServiceRegistryValidationError,
} from '../lib/governance/service-registry';
import { ServiceRegistryEntry } from '../lib/types/service-registry';

// --- Test Helpers ---

function createMockClock(): RegistryClock {
  return {
    now: () => '2024-01-15T10:00:00.000Z',
  };
}

function createMockStore(): jest.Mocked<RegistryStore> {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    queryByTags: jest.fn().mockResolvedValue([]),
    getByEndpointUrl: jest.fn().mockResolvedValue(null),
  };
}

function createDeps(overrides?: Partial<ServiceRegistryDependencies>): ServiceRegistryDependencies {
  return {
    store: createMockStore(),
    clock: createMockClock(),
    ...overrides,
  };
}

// --- Arbitraries ---

/**
 * Generates valid non-empty endpoint URLs.
 */
const validEndpointUrl = fc
  .tuple(
    fc.constantFrom('https://api-', 'https://data-', 'https://service-', 'https://merchant-'),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 3,
      maxLength: 20,
    }),
    fc.constantFrom('.example.com/data', '.example.com/services', '.example.com/feed', '.example.com/market')
  )
  .map(([prefix, mid, suffix]) => `${prefix}${mid}${suffix}`);

/**
 * Generates invalid endpoint URLs (empty or whitespace-only).
 */
const invalidEndpointUrl = fc.constantFrom('', '   ', '\t', '\n');

/**
 * Generates valid descriptions (0 to 500 characters).
 */
const validDescription = fc.string({ minLength: 0, maxLength: 500 });

/**
 * Generates invalid descriptions (more than 500 characters).
 */
const invalidDescription = fc.string({ minLength: 501, maxLength: 700 });

/**
 * Generates valid price strings in range [0.01, 999,999.99].
 */
const validPriceUsdc = fc
  .integer({ min: 1, max: 99999999 }) // cents from 0.01 to 999,999.99
  .map((cents) => (cents / 100).toFixed(2));

/**
 * Generates invalid price strings (below 0.01 or above 999,999.99).
 */
const invalidPriceTooLow = fc
  .integer({ min: -10000, max: 0 })
  .map((cents) => (cents / 100).toFixed(2));

const invalidPriceTooHigh = fc
  .integer({ min: 100000000, max: 200000000 }) // above 999,999.99
  .map((cents) => (cents / 100).toFixed(2));

const invalidPriceNaN = fc.constantFrom('not-a-number', 'abc', 'NaN', '', 'Infinity');

/**
 * Generates valid capability tags (at least one non-empty tag).
 */
const validCapabilityTags = fc.array(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
    minLength: 1,
    maxLength: 30,
  }),
  { minLength: 1, maxLength: 10 }
);

/**
 * Generates agent IDs.
 */
const agentId = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
  { minLength: 1, maxLength: 30 }
);

/**
 * Generates a complete valid ServiceRegistryEntry.
 */
const validServiceRegistryEntry = fc
  .tuple(validEndpointUrl, agentId, validDescription, validPriceUsdc, validCapabilityTags)
  .map(([endpointUrl, agent, description, priceUsdc, capabilityTags]) => ({
    endpointUrl,
    agentId: agent,
    description,
    priceUsdc,
    capabilityTags,
    registeredAt: '2024-01-15T10:00:00.000Z',
    status: 'active' as const,
  }));

// --- Property Tests ---

describe('Property 20: Service Registry Entry Validation', () => {
  /**
   * **Validates: Requirements 10.1**
   *
   * For any service registry entry:
   * - Accepted iff: valid URL (non-empty), description ≤ 500 chars, price in [0.01, 999,999.99], at least one capability tag
   * - Rejected otherwise with ServiceRegistryValidationError
   */

  it('should accept any entry with valid URL, description ≤500 chars, price in [0.01, 999,999.99], and at least one tag', () => {
    fc.assert(
      fc.asyncProperty(
        validServiceRegistryEntry,
        async (entry) => {
          const store = createMockStore();
          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          // Should not throw — entry is valid
          await registry.register(entry);

          // Verify store.put was called (entry accepted)
          expect(store.put).toHaveBeenCalledTimes(1);
          expect(store.put).toHaveBeenCalledWith(
            expect.objectContaining({
              endpointUrl: entry.endpointUrl,
              priceUsdc: entry.priceUsdc,
              capabilityTags: entry.capabilityTags,
              status: 'active',
            })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with empty or whitespace-only endpoint URL', () => {
    fc.assert(
      fc.asyncProperty(
        invalidEndpointUrl,
        validDescription,
        validPriceUsdc,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, priceUsdc, capabilityTags, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with description exceeding 500 characters', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        invalidDescription,
        validPriceUsdc,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, priceUsdc, capabilityTags, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with price below 0.01 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        invalidPriceTooLow,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, priceUsdc, capabilityTags, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with price above 999,999.99 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        invalidPriceTooHigh,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, priceUsdc, capabilityTags, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with non-numeric price', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        invalidPriceNaN,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, priceUsdc, capabilityTags, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should reject any entry with empty capability tags array', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        validPriceUsdc,
        agentId,
        async (endpointUrl, description, priceUsdc, agent) => {
          const deps = createDeps();
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc,
            capabilityTags: [], // empty tags
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await expect(registry.register(entry)).rejects.toThrow(
            ServiceRegistryValidationError
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept boundary price of exactly 0.01 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, capabilityTags, agent) => {
          const store = createMockStore();
          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc: '0.01',
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await registry.register(entry);
          expect(store.put).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should accept boundary price of exactly 999999.99 USDC', () => {
    fc.assert(
      fc.asyncProperty(
        validEndpointUrl,
        validDescription,
        validCapabilityTags,
        agentId,
        async (endpointUrl, description, capabilityTags, agent) => {
          const store = createMockStore();
          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const entry: ServiceRegistryEntry = {
            endpointUrl,
            agentId: agent,
            description,
            priceUsdc: '999999.99',
            capabilityTags,
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active',
          };

          await registry.register(entry);
          expect(store.put).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 21: Service Registry Tag-Based Query', () => {
  /**
   * **Validates: Requirements 10.2**
   *
   * For any set of registry entries and any query with one or more capability tags:
   * - Results contain exactly those entries that have at least one matching tag
   * - Results are limited to max 100
   */

  it('should return exactly those entries with at least one matching tag', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a set of registry entries with various tags
        fc.array(validServiceRegistryEntry, { minLength: 1, maxLength: 30 }),
        // Generate query tags (at least one)
        fc.array(
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
            minLength: 1,
            maxLength: 30,
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (entries, queryTags) => {
          // Compute expected results: entries that have at least one matching tag
          const expectedEntries = entries.filter((entry) =>
            entry.capabilityTags.some((tag) => queryTags.includes(tag))
          );

          // Mock the store to simulate correct tag-based filtering
          const store = createMockStore();
          store.queryByTags.mockImplementation(async ({ tags, limit }) => {
            const matching = entries.filter((entry) =>
              entry.capabilityTags.some((tag) => tags.includes(tag))
            );
            return matching.slice(0, limit);
          });

          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const results = await registry.query({ capabilityTags: queryTags });

          // Results should contain exactly the entries with at least one matching tag (up to 100)
          const expectedLimited = expectedEntries.slice(0, 100);
          expect(results).toEqual(expectedLimited);

          // Verify the store was called with correct parameters
          expect(store.queryByTags).toHaveBeenCalledWith({
            tags: queryTags,
            limit: 100,
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should limit results to maximum 100 entries regardless of matching count', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate more than 100 entries that all share a common tag
        fc.integer({ min: 101, max: 200 }),
        validCapabilityTags,
        async (entryCount, queryTags) => {
          // Create entries that all match the query tags
          const entries: ServiceRegistryEntry[] = Array.from({ length: entryCount }, (_, i) => ({
            endpointUrl: `https://service-${i}.example.com/data`,
            agentId: `agent-${i}`,
            description: `Service ${i}`,
            priceUsdc: '1.00',
            capabilityTags: queryTags, // all entries match
            registeredAt: '2024-01-15T10:00:00.000Z',
            status: 'active' as const,
          }));

          // Mock store to return entries limited by the limit parameter
          const store = createMockStore();
          store.queryByTags.mockImplementation(async ({ tags, limit }) => {
            return entries.slice(0, limit);
          });

          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const results = await registry.query({ capabilityTags: queryTags });

          // Results must not exceed 100
          expect(results.length).toBeLessThanOrEqual(100);

          // Store should have been called with limit capped at 100
          expect(store.queryByTags).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 100 })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should cap user-provided limit to 100 even when higher value is specified', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 101, max: 10000 }), // limits above 100
        validCapabilityTags,
        async (requestedLimit, queryTags) => {
          const store = createMockStore();
          store.queryByTags.mockResolvedValue([]);
          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          await registry.query({ capabilityTags: queryTags, limit: requestedLimit });

          // The store should always be called with limit capped at 100
          expect(store.queryByTags).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 100 })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should use the provided limit when it is at most 100', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }), // limits within valid range
        validCapabilityTags,
        async (requestedLimit, queryTags) => {
          const store = createMockStore();
          store.queryByTags.mockResolvedValue([]);
          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          await registry.query({ capabilityTags: queryTags, limit: requestedLimit });

          // The store should be called with the exact limit provided
          expect(store.queryByTags).toHaveBeenCalledWith(
            expect.objectContaining({ limit: requestedLimit })
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should return empty array when no entries match the queried tags', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate entries with specific tags
        fc.array(validServiceRegistryEntry, { minLength: 1, maxLength: 20 }),
        // Generate query tags that are guaranteed not to match any entry tags
        fc.array(
          fc.constant('zzz-nonexistent-tag-xyz'),
          { minLength: 1, maxLength: 3 }
        ),
        async (entries, queryTags) => {
          // Ensure none of the entries have the query tags
          const entriesWithoutQueryTags = entries.map((entry) => ({
            ...entry,
            capabilityTags: entry.capabilityTags.filter((t) => !queryTags.includes(t)),
          })).filter((e) => e.capabilityTags.length > 0);

          const store = createMockStore();
          store.queryByTags.mockImplementation(async ({ tags, limit }) => {
            const matching = entriesWithoutQueryTags.filter((entry) =>
              entry.capabilityTags.some((tag) => tags.includes(tag))
            );
            return matching.slice(0, limit);
          });

          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const results = await registry.query({ capabilityTags: queryTags });

          expect(results).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should match entries that share at least one tag with the query (any-match semantics)', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a shared tag that will be used for matching
        fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
          minLength: 3,
          maxLength: 15,
        }),
        // Generate additional non-matching tags for entries
        fc.array(
          fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
            minLength: 3,
            maxLength: 15,
          }),
          { minLength: 1, maxLength: 5 }
        ),
        // Number of matching entries
        fc.integer({ min: 1, max: 10 }),
        // Number of non-matching entries
        fc.integer({ min: 0, max: 10 }),
        async (sharedTag, otherTags, matchCount, nonMatchCount) => {
          // Create entries that have the shared tag (should match)
          const matchingEntries: ServiceRegistryEntry[] = Array.from(
            { length: matchCount },
            (_, i) => ({
              endpointUrl: `https://match-${i}.example.com/data`,
              agentId: `agent-match-${i}`,
              description: `Matching service ${i}`,
              priceUsdc: '5.00',
              capabilityTags: [sharedTag, ...otherTags.slice(0, 2)],
              registeredAt: '2024-01-15T10:00:00.000Z',
              status: 'active' as const,
            })
          );

          // Create entries that do NOT have the shared tag (should not match)
          const nonMatchingEntries: ServiceRegistryEntry[] = Array.from(
            { length: nonMatchCount },
            (_, i) => ({
              endpointUrl: `https://nomatch-${i}.example.com/data`,
              agentId: `agent-nomatch-${i}`,
              description: `Non-matching service ${i}`,
              priceUsdc: '3.00',
              capabilityTags: [`unique-tag-${i}-xyz`],
              registeredAt: '2024-01-15T10:00:00.000Z',
              status: 'active' as const,
            })
          );

          const allEntries = [...matchingEntries, ...nonMatchingEntries];

          const store = createMockStore();
          store.queryByTags.mockImplementation(async ({ tags, limit }) => {
            const matching = allEntries.filter((entry) =>
              entry.capabilityTags.some((tag) => tags.includes(tag))
            );
            return matching.slice(0, limit);
          });

          const deps = createDeps({ store });
          const registry = new DefaultServiceRegistry(deps);

          const results = await registry.query({ capabilityTags: [sharedTag] });

          // Should return exactly the matching entries
          expect(results.length).toBe(matchingEntries.length);
          for (const result of results) {
            expect(result.capabilityTags).toContain(sharedTag);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
