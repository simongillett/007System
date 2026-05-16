/**
 * Service Registry interfaces for agent-to-agent service discovery.
 * Maintains a discoverable catalog of merchant endpoints with capability-based querying.
 */

export type ServiceStatus = 'active' | 'decommissioned';

export interface ServiceRegistryEntry {
  endpointUrl: string;
  agentId: string;
  description: string;
  priceUsdc: string;
  capabilityTags: string[];
  registeredAt: string;
  status: ServiceStatus;
}

export interface ServiceRegistryQuery {
  capabilityTags: string[];
  limit?: number;
}

export interface ServiceRegistry {
  register(entry: ServiceRegistryEntry): Promise<void>;
  decommission(endpointUrl: string): Promise<void>;
  query(params: ServiceRegistryQuery): Promise<ServiceRegistryEntry[]>;
}
