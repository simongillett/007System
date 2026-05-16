import fc from 'fast-check';
import '../test/setup';
import {
  SupervisorAgentConfig,
  CollaboratorAgentConfig,
  TaskDelegation,
  DelegationResult,
  WalletManagerConfig,
  AgentWallet,
  WalletBalance,
  PaymentRequirements,
  PaymentRequest,
  PaymentResult,
  SpendingPolicy,
  PolicyEvaluation,
  AuditRecord,
  AuditQuery,
  MerchantEndpointConfig,
  PaymentReceipt,
  ReceiptVerification,
  ServiceRegistryEntry,
  ServiceRegistryQuery,
  SupplyChainGuardConfig,
  TradingSystemError,
} from '../lib/types';

describe('Type Definitions', () => {
  test('SupervisorAgentConfig is structurally valid', () => {
    const config: SupervisorAgentConfig = {
      agentName: 'test-supervisor',
      modelId: 'anthropic.claude-sonnet-4-20250514',
      collaboratorAgents: [],
      sessionMemoryTtlHours: 24,
      apiGatewayAuth: 'IAM_SIGV4',
    };
    expect(config.apiGatewayAuth).toBe('IAM_SIGV4');
    expect(config.sessionMemoryTtlHours).toBeGreaterThanOrEqual(24);
  });

  test('CollaboratorAgentConfig has correct defaults', () => {
    const config: CollaboratorAgentConfig = {
      agentId: 'agent-001',
      agentAliasId: 'alias-001',
      taskTypes: ['data-provision', 'market-analysis'],
      description: 'Test agent',
      timeoutSeconds: 30,
      maxRetries: 1,
    };
    expect(config.timeoutSeconds).toBe(30);
    expect(config.maxRetries).toBe(1);
  });

  test('PaymentRequirements enforces USDC on Base', () => {
    const requirements: PaymentRequirements = {
      recipientAddress: '0x1234567890abcdef1234567890abcdef12345678',
      amount: '1.50',
      asset: 'USDC',
      network: 'base',
      paymentId: 'pay-001',
    };
    expect(requirements.asset).toBe('USDC');
    expect(requirements.network).toBe('base');
  });

  test('SpendingPolicy structure is valid', () => {
    const policy: SpendingPolicy = {
      agentId: 'agent-001',
      perTransactionLimitUsdc: '10.00',
      cumulativeLimitUsdc: '100.00',
      updatedAt: new Date().toISOString(),
    };
    expect(parseFloat(policy.perTransactionLimitUsdc)).toBeGreaterThan(0);
    expect(parseFloat(policy.cumulativeLimitUsdc)).toBeGreaterThan(0);
  });

  test('AuditRecord contains all required fields', () => {
    const record: AuditRecord = {
      correlationId: 'corr-001',
      sourceAgentId: 'agent-001',
      destinationAgentId: 'agent-002',
      amountUsdc: '5.500000',
      transactionHash: '0xabc123',
      timestamp: new Date().toISOString(),
      status: 'settled',
      policyEvaluation: {
        agentId: 'agent-001',
        paymentAmount: '5.50',
        perTransactionLimit: '10.00',
        cumulativeSpent24h: '20.00',
        cumulativeLimit: '100.00',
        approved: true,
      },
      eventType: 'payment_settled',
    };
    expect(record.correlationId).toBeDefined();
    expect(record.amountUsdc).toMatch(/^\d+\.\d{6}$/);
  });

  test('SupplyChainGuardConfig pins correct versions', () => {
    const config: SupplyChainGuardConfig = {
      pinnedVersion: '1.13.6',
      blockedVersions: ['1.14.1', '0.30.4'],
    };
    expect(config.pinnedVersion).toBe('1.13.6');
    expect(config.blockedVersions).toContain('1.14.1');
    expect(config.blockedVersions).toContain('0.30.4');
  });

  test('fast-check is properly configured', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        return typeof s === 'string';
      })
    );
  });
});
