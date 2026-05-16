/**
 * Test setup for fast-check property-based testing.
 * Configures default parameters for all property tests.
 */

import fc from 'fast-check';

// Configure fast-check defaults for the trading system
// Minimum 100 iterations per property test as specified in the design
fc.configureGlobal({
  numRuns: 100,
  verbose: false,
});
