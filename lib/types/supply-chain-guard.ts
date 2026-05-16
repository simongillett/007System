/**
 * Supply Chain Guard configuration for dependency security.
 * Pins axios to a safe version and blocks known compromised versions.
 */

export interface SupplyChainGuardConfig {
  pinnedVersion: '1.13.6';
  blockedVersions: ['1.14.1', '0.30.4'];
}
