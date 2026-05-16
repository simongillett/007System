/**
 * Service Registry implementation for agent-to-agent service discovery.
 *
 * Responsibilities:
 * - Register merchant endpoints with validation (URL, description, price, tags)
 * - Decommission endpoints (mark as decommissioned) within 30 seconds
 * - Query by capability tags (any tag matches), max 100 results, within 5 seconds
 * - Return empty result set with message when no services match
 * - Return error with 5-second retry guidance when registry unavailable
 *
 * Uses dependency injection for:
 * - RegistryStore: DynamoDB operations (put, update, scan/query)
 * - Clock: testable timestamps
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import {
  ServiceRegistry,
  ServiceRegistryEntry,
  ServiceRegistryQuery,
} from '../types/service-registry';

// --- Dependency Interfaces ---

/**
 * Interface for DynamoDB operations on the Service Registry table.
 */
export interface RegistryStore {
  /**
   * Put a service registry entry into the table.
   * Throws on DynamoDB errors.
   */
  put(entry: ServiceRegistryEntry): Promise<void>;

  /**
   * Update the status of an entry by endpointUrl.
   * Throws on DynamoDB errors.
   */
  updateStatus(params: {
    endpointUrl: string;
    status: string;
  }): Promise<void>;

  /**
   * Scan for active entries whose capabilityTags contain at least one of the queried tags.
   * Returns up to `limit` results.
   * Throws on DynamoDB errors.
   */
  queryByTags(params: {
    tags: string[];
    limit: number;
  }): Promise<ServiceRegistryEntry[]>;

  /**
   * Get an entry by endpointUrl.
   * Returns null if not found.
   */
  getByEndpointUrl(endpointUrl: string): Promise<ServiceRegistryEntry | null>;
}

/**
 * Interface for testable time generation.
 */
export interface RegistryClock {
  /**
   * Get the current time as ISO 8601 UTC string.
   */
  now(): string;
}

// --- Constants ---

/** Maximum number of results for a query (Requirement 10.2) */
const MAX_QUERY_RESULTS = 100;

/** Maximum description length (Requirement 10.1) */
const MAX_DESCRIPTION_LENGTH = 500;

/** Minimum price in USDC (Requirement 10.1) */
const MIN_PRICE_USDC = 0.01;

/** Maximum price in USDC (Requirement 10.1) */
const MAX_PRICE_USDC = 999_999.99;

// --- Dependencies Container ---

export interface ServiceRegistryDependencies {
  store: RegistryStore;
  clock: RegistryClock;
}

// --- Error Types ---

export class ServiceRegistryValidationError extends Error {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(`Validation failed for '${field}': ${reason}`);
    this.name = 'ServiceRegistryValidationError';
    this.field = field;
    this.reason = reason;
  }
}

export class ServiceRegistryUnavailableError extends Error {
  public readonly retryAfterSeconds: number;

  constructor(cause?: string) {
    super(
      `Service registry is temporarily unavailable. Please retry after at least 5 seconds.${cause ? ` Cause: ${cause}` : ''}`
    );
    this.name = 'ServiceRegistryUnavailableError';
    this.retryAfterSeconds = 5;
  }
}

// --- Result Types ---

export interface ServiceRegistryQueryResult {
  entries: ServiceRegistryEntry[];
  message?: string;
}

// --- Implementation ---

/**
 * Default Service Registry implementation.
 *
 * Implements the ServiceRegistry interface with:
 * - Input validation for all registration fields
 * - Tag-based querying with any-match semantics
 * - Decommissioning (status update)
 * - Empty result messaging
 * - Unavailability error with retry guidance
 */
export class DefaultServiceRegistry implements ServiceRegistry {
  private readonly deps: ServiceRegistryDependencies;

  constructor(deps: ServiceRegistryDependencies) {
    this.deps = deps;
  }

  /**
   * Register a new merchant endpoint in the service registry.
   *
   * Validates:
   * - endpointUrl: non-empty string
   * - description: max 500 characters
   * - priceUsdc: in range [0.01, 999,999.99]
   * - capabilityTags: at least one tag
   *
   * Sets registeredAt timestamp and status to 'active'.
   * Must complete within 30 seconds (Requirement 10.3).
   *
   * Requirements: 10.1, 10.3
   */
  async register(entry: ServiceRegistryEntry): Promise<void> {
    // Validate endpointUrl
    if (!entry.endpointUrl || entry.endpointUrl.trim().length === 0) {
      throw new ServiceRegistryValidationError(
        'endpointUrl',
        'Endpoint URL must be a non-empty string'
      );
    }

    // Validate description length
    if (entry.description && entry.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ServiceRegistryValidationError(
        'description',
        `Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters (got ${entry.description.length})`
      );
    }

    // Validate priceUsdc
    const price = parseFloat(entry.priceUsdc);
    if (isNaN(price) || price < MIN_PRICE_USDC || price > MAX_PRICE_USDC) {
      throw new ServiceRegistryValidationError(
        'priceUsdc',
        `Price must be between ${MIN_PRICE_USDC} and ${MAX_PRICE_USDC} USDC (got ${entry.priceUsdc})`
      );
    }

    // Validate capabilityTags
    if (!entry.capabilityTags || entry.capabilityTags.length === 0) {
      throw new ServiceRegistryValidationError(
        'capabilityTags',
        'At least one capability tag is required'
      );
    }

    // Build the entry with defaults
    const registryEntry: ServiceRegistryEntry = {
      ...entry,
      registeredAt: entry.registeredAt || this.deps.clock.now(),
      status: 'active',
    };

    try {
      await this.deps.store.put(registryEntry);
    } catch (error) {
      throw new ServiceRegistryUnavailableError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Decommission a merchant endpoint by marking its status as 'decommissioned'.
   *
   * Must complete within 30 seconds (Requirement 10.4).
   *
   * Requirements: 10.4
   */
  async decommission(endpointUrl: string): Promise<void> {
    if (!endpointUrl || endpointUrl.trim().length === 0) {
      throw new ServiceRegistryValidationError(
        'endpointUrl',
        'Endpoint URL must be a non-empty string'
      );
    }

    try {
      await this.deps.store.updateStatus({
        endpointUrl,
        status: 'decommissioned',
      });
    } catch (error) {
      throw new ServiceRegistryUnavailableError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Query the service registry by capability tags.
   *
   * - Returns entries where capabilityTags contain at least one of the queried tags
   * - Maximum 100 results (Requirement 10.2)
   * - Must complete within 5 seconds (Requirement 10.2)
   * - Returns empty array with message when no services match (Requirement 10.5)
   * - Throws ServiceRegistryUnavailableError with 5-second retry guidance on failure (Requirement 10.6)
   *
   * Requirements: 10.2, 10.5, 10.6
   */
  async query(params: ServiceRegistryQuery): Promise<ServiceRegistryEntry[]> {
    if (!params.capabilityTags || params.capabilityTags.length === 0) {
      return [];
    }

    const limit = Math.min(params.limit || MAX_QUERY_RESULTS, MAX_QUERY_RESULTS);

    try {
      const results = await this.deps.store.queryByTags({
        tags: params.capabilityTags,
        limit,
      });

      return results;
    } catch (error) {
      throw new ServiceRegistryUnavailableError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Query with extended result that includes a message for empty results.
   *
   * This is a convenience method that wraps `query` and adds messaging
   * for the empty result case (Requirement 10.5).
   *
   * Requirements: 10.5
   */
  async queryWithMessage(params: ServiceRegistryQuery): Promise<ServiceRegistryQueryResult> {
    const entries = await this.query(params);

    if (entries.length === 0) {
      return {
        entries: [],
        message: 'No matching services were found for the provided capability tags.',
      };
    }

    return { entries };
  }
}
