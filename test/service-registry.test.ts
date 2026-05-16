/**
 * Unit tests for the Service Registry implementation.
 *
 * Tests cover:
 * - Registration with validation (URL, description, price, tags)
 * - Decommissioning endpoints
 * - Tag-based querying with max 100 results
 * - Empty result set with message
 * - Error handling with 5-second retry guidance
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import {
  DefaultServiceRegistry,
  RegistryStore,
  RegistryClock,
  ServiceRegistryDependencies,
  ServiceRegistryValidationError,
  ServiceRegistryUnavailableError,
} from '../lib/governance/service-registry';
import { ServiceRegistryEntry } from '../lib/types/service-registry';

// --- Test Helpers ---

function createMockStore(): jest.Mocked<RegistryStore> {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    queryByTags: jest.fn().mockResolvedValue([]),
    getByEndpointUrl: jest.fn().mockResolvedValue(null),
  };
}

function createMockClock(): RegistryClock {
  return {
    now: () => '2024-01-15T10:00:00.000Z',
  };
}

function createDeps(overrides?: Partial<ServiceRegistryDependencies>): ServiceRegistryDependencies {
  return {
    store: createMockStore(),
    clock: createMockClock(),
    ...overrides,
  };
}

function createValidEntry(overrides?: Partial<ServiceRegistryEntry>): ServiceRegistryEntry {
  return {
    endpointUrl: 'https://api.example.com/data/market-feed',
    agentId: 'agent-001',
    description: 'Real-time market data feed',
    priceUsdc: '1.50',
    capabilityTags: ['market-data', 'real-time'],
    registeredAt: '2024-01-15T10:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

// --- Tests ---

describe('DefaultServiceRegistry', () => {
  describe('register', () => {
    it('should register a valid entry successfully', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry();

      await registry.register(entry);

      expect(store.put).toHaveBeenCalledWith(
        expect.objectContaining({
          endpointUrl: entry.endpointUrl,
          agentId: entry.agentId,
          description: entry.description,
          priceUsdc: entry.priceUsdc,
          capabilityTags: entry.capabilityTags,
          status: 'active',
        })
      );
    });

    it('should set status to active on registration', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ status: 'decommissioned' });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' })
      );
    });

    it('should set registeredAt from clock when not provided', async () => {
      const store = createMockStore();
      const clock: RegistryClock = { now: () => '2024-06-01T12:00:00.000Z' };
      const deps = createDeps({ store, clock });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ registeredAt: '' });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalledWith(
        expect.objectContaining({ registeredAt: '2024-06-01T12:00:00.000Z' })
      );
    });

    // --- Validation: endpointUrl ---

    it('should reject registration with empty endpointUrl', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ endpointUrl: '' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
      await expect(registry.register(entry)).rejects.toThrow(/endpointUrl/);
    });

    it('should reject registration with whitespace-only endpointUrl', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ endpointUrl: '   ' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
    });

    // --- Validation: description ---

    it('should accept description at exactly 500 characters', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ description: 'a'.repeat(500) });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalled();
    });

    it('should reject description exceeding 500 characters', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ description: 'a'.repeat(501) });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
      await expect(registry.register(entry)).rejects.toThrow(/description/i);
    });

    // --- Validation: priceUsdc ---

    it('should accept minimum price of 0.01 USDC', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: '0.01' });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalled();
    });

    it('should accept maximum price of 999999.99 USDC', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: '999999.99' });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalled();
    });

    it('should reject price below 0.01 USDC', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: '0.001' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
      await expect(registry.register(entry)).rejects.toThrow(/priceUsdc/);
    });

    it('should reject price above 999999.99 USDC', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: '1000000.00' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
    });

    it('should reject non-numeric price', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: 'not-a-number' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
    });

    it('should reject price of zero', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ priceUsdc: '0' });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
    });

    // --- Validation: capabilityTags ---

    it('should reject registration with empty capabilityTags array', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ capabilityTags: [] });

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryValidationError
      );
      await expect(registry.register(entry)).rejects.toThrow(/capabilityTags/);
    });

    it('should accept registration with one capability tag', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry({ capabilityTags: ['data-feed'] });

      await registry.register(entry);

      expect(store.put).toHaveBeenCalled();
    });

    // --- Store unavailability ---

    it('should throw ServiceRegistryUnavailableError when store.put fails', async () => {
      const store = createMockStore();
      store.put.mockRejectedValue(new Error('DynamoDB connection timeout'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry();

      await expect(registry.register(entry)).rejects.toThrow(
        ServiceRegistryUnavailableError
      );
      await expect(registry.register(entry)).rejects.toThrow(
        /temporarily unavailable/
      );
    });

    it('should include retry guidance in unavailability error', async () => {
      const store = createMockStore();
      store.put.mockRejectedValue(new Error('Service unavailable'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);
      const entry = createValidEntry();

      try {
        await registry.register(entry);
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceRegistryUnavailableError);
        expect((error as ServiceRegistryUnavailableError).retryAfterSeconds).toBe(5);
        expect((error as ServiceRegistryUnavailableError).message).toContain('5 seconds');
      }
    });
  });

  describe('decommission', () => {
    it('should update status to decommissioned', async () => {
      const store = createMockStore();
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await registry.decommission('https://api.example.com/data/market-feed');

      expect(store.updateStatus).toHaveBeenCalledWith({
        endpointUrl: 'https://api.example.com/data/market-feed',
        status: 'decommissioned',
      });
    });

    it('should reject decommission with empty endpointUrl', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);

      await expect(registry.decommission('')).rejects.toThrow(
        ServiceRegistryValidationError
      );
    });

    it('should throw ServiceRegistryUnavailableError when store.updateStatus fails', async () => {
      const store = createMockStore();
      store.updateStatus.mockRejectedValue(new Error('DynamoDB timeout'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await expect(
        registry.decommission('https://api.example.com/data')
      ).rejects.toThrow(ServiceRegistryUnavailableError);
    });
  });

  describe('query', () => {
    it('should return matching entries by capability tags', async () => {
      const store = createMockStore();
      const matchingEntries: ServiceRegistryEntry[] = [
        createValidEntry({ endpointUrl: 'https://a.com', capabilityTags: ['market-data'] }),
        createValidEntry({ endpointUrl: 'https://b.com', capabilityTags: ['market-data', 'analytics'] }),
      ];
      store.queryByTags.mockResolvedValue(matchingEntries);
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      const results = await registry.query({ capabilityTags: ['market-data'] });

      expect(results).toEqual(matchingEntries);
      expect(store.queryByTags).toHaveBeenCalledWith({
        tags: ['market-data'],
        limit: 100,
      });
    });

    it('should cap results at 100 even if higher limit requested', async () => {
      const store = createMockStore();
      store.queryByTags.mockResolvedValue([]);
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await registry.query({ capabilityTags: ['data'], limit: 500 });

      expect(store.queryByTags).toHaveBeenCalledWith({
        tags: ['data'],
        limit: 100,
      });
    });

    it('should use provided limit when less than 100', async () => {
      const store = createMockStore();
      store.queryByTags.mockResolvedValue([]);
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await registry.query({ capabilityTags: ['data'], limit: 25 });

      expect(store.queryByTags).toHaveBeenCalledWith({
        tags: ['data'],
        limit: 25,
      });
    });

    it('should return empty array when no tags provided', async () => {
      const deps = createDeps();
      const registry = new DefaultServiceRegistry(deps);

      const results = await registry.query({ capabilityTags: [] });

      expect(results).toEqual([]);
    });

    it('should throw ServiceRegistryUnavailableError when store.queryByTags fails', async () => {
      const store = createMockStore();
      store.queryByTags.mockRejectedValue(new Error('Connection refused'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await expect(
        registry.query({ capabilityTags: ['market-data'] })
      ).rejects.toThrow(ServiceRegistryUnavailableError);
    });

    it('should include 5-second retry guidance in unavailability error', async () => {
      const store = createMockStore();
      store.queryByTags.mockRejectedValue(new Error('Timeout'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      try {
        await registry.query({ capabilityTags: ['data'] });
        fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceRegistryUnavailableError);
        expect((error as ServiceRegistryUnavailableError).retryAfterSeconds).toBe(5);
        expect((error as ServiceRegistryUnavailableError).message).toContain(
          'retry after at least 5 seconds'
        );
      }
    });
  });

  describe('queryWithMessage', () => {
    it('should return entries without message when results found', async () => {
      const store = createMockStore();
      const entries = [createValidEntry()];
      store.queryByTags.mockResolvedValue(entries);
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      const result = await registry.queryWithMessage({ capabilityTags: ['market-data'] });

      expect(result.entries).toEqual(entries);
      expect(result.message).toBeUndefined();
    });

    it('should return empty entries with message when no results found', async () => {
      const store = createMockStore();
      store.queryByTags.mockResolvedValue([]);
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      const result = await registry.queryWithMessage({ capabilityTags: ['nonexistent'] });

      expect(result.entries).toEqual([]);
      expect(result.message).toBe(
        'No matching services were found for the provided capability tags.'
      );
    });

    it('should propagate unavailability error from query', async () => {
      const store = createMockStore();
      store.queryByTags.mockRejectedValue(new Error('Service down'));
      const deps = createDeps({ store });
      const registry = new DefaultServiceRegistry(deps);

      await expect(
        registry.queryWithMessage({ capabilityTags: ['data'] })
      ).rejects.toThrow(ServiceRegistryUnavailableError);
    });
  });
});
