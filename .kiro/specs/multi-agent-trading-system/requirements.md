# Requirements Document

## Introduction

This document defines the requirements for a multi-agent trading system where AI agents autonomously trade data and services with each other using x402 micropayments. The system uses Amazon Bedrock AgentCore for multi-agent orchestration (supervisor pattern with specialized agents), AgentCore Payments for managed x402 payment execution, and the Coinbase CDP SDK for wallet management and USDC transactions. Income from trades is stored in Coinbase-managed wallets. The infrastructure is deployed via AWS CDK in TypeScript.

## Glossary

- **Supervisor_Agent**: The top-level orchestrating agent in Amazon Bedrock AgentCore that coordinates specialized agents, delegates tasks, and enforces system-wide policies.
- **Specialized_Agent**: A purpose-built AI agent managed by the Supervisor_Agent that performs a specific trading function (e.g., data provision, service execution, market analysis).
- **Trading_System**: The complete multi-agent trading platform including all agents, wallets, payment infrastructure, and orchestration components.
- **Wallet_Manager**: The component responsible for provisioning, managing, and querying Coinbase wallets via the CDP SDK for each agent, with credentials secured through AgentCore Identity.
- **AgentCore_Identity**: The identity and credential management service within Amazon Bedrock AgentCore that provides per-agent Workload Identities, a Token Vault for secure credential storage (encrypted via AWS KMS), and Credential Providers for scoped access to secrets.
- **Token_Vault**: The AgentCore Identity component that securely stores and retrieves API keys and OAuth tokens, encrypted with AWS KMS, with access scoped to individual agent Workload Identities.
- **Credential_Provider**: An AgentCore Identity resource (API Key or OAuth2) that references a Secrets Manager secret ARN and governs which agents can retrieve the stored credentials.
- **Payment_Executor**: The AgentCore Payments component that handles x402 micropayment execution between agents, including payment initiation, settlement, and receipt verification.
- **Spending_Policy**: A configurable rule set that governs how much a Specialized_Agent can spend per transaction, per time period, or in aggregate.
- **Audit_Logger**: The component that records all agent transactions, payment events, and policy decisions into a unified audit trail.
- **x402_Protocol**: The HTTP-based payment protocol where a 402 status code signals that payment is required, enabling autonomous agent-to-agent commerce with USDC on-chain settlement.
- **CDP_SDK**: The Coinbase Developer Platform SDK (`@coinbase/cdp-sdk` v1.49.0) used for wallet provisioning and USDC transaction management.
- **USDC**: USD Coin, the stablecoin used for all agent-to-agent micropayments on-chain.
- **Merchant_Endpoint**: A CloudFront + Lambda@Edge service that exposes data or services behind an x402 paywall.
- **Supply_Chain_Guard**: The dependency security mechanism that prevents resolution of compromised axios versions via npm overrides.

## Requirements

### Requirement 1: Multi-Agent Orchestration

**User Story:** As a system operator, I want a supervisor agent that orchestrates specialized trading agents, so that complex trading workflows are coordinated autonomously.

#### Acceptance Criteria

1. THE Supervisor_Agent SHALL coordinate between 1 and 10 concurrent Specialized_Agents using Amazon Bedrock AgentCore managed runtime.
2. WHEN a trading task is received, THE Supervisor_Agent SHALL match the task to a Specialized_Agent whose registered task-type matches the task's declared type, and delegate the task to that agent.
3. WHEN a Specialized_Agent completes a delegated task, THE Supervisor_Agent SHALL receive the result and select the next action from: delegate to another Specialized_Agent, return the final result to the caller, or initiate an error-handling sequence.
4. IF a Specialized_Agent fails to respond within 30 seconds, THEN THE Supervisor_Agent SHALL retry the delegation to the same Specialized_Agent once and log the timeout event.
5. IF a Specialized_Agent fails to respond within 30 seconds after a retry attempt, THEN THE Supervisor_Agent SHALL mark the task as failed, log the failure event, and return an error indication to the caller specifying which agent and task timed out.
6. THE Supervisor_Agent SHALL authenticate all API requests using IAM SigV4 signatures via the AgentCore API gateway.
7. IF no registered Specialized_Agent matches the declared task type, THEN THE Supervisor_Agent SHALL reject the task and return an error indication specifying the unrecognized task type.

### Requirement 2: Agent Wallet Provisioning and Credential Management

**User Story:** As a system operator, I want each agent to have its own Coinbase-managed wallet with credentials secured via AgentCore Identity, so that agent income and spending are isolated, trackable, and cryptographically protected per-agent.

#### Acceptance Criteria

1. WHEN a new Specialized_Agent is registered, THE Wallet_Manager SHALL provision a dedicated Coinbase wallet for that agent using the CDP SDK v1.49.0 within 30 seconds of the registration event.
2. WHEN a wallet is provisioned, THE Wallet_Manager SHALL store the CDP API key and secret in AWS Secrets Manager and create an AgentCore Identity API Key Credential Provider referencing the secret ARN, encrypted at rest with AWS KMS.
3. WHEN a wallet is provisioned, THE Wallet_Manager SHALL create a Workload Identity in AgentCore Identity for the agent, scoped to access only its own Credential Provider.
4. WHEN a Specialized_Agent needs to access its CDP credentials at runtime, THE Wallet_Manager SHALL retrieve them exclusively through the AgentCore Identity Token Vault — never directly from Secrets Manager.
5. WHEN a wallet is provisioned, THE Wallet_Manager SHALL configure the wallet to hold and transact in USDC.
6. THE Wallet_Manager SHALL expose a query interface that returns the current USDC balance, to 2 decimal places, for a given agent wallet within 5 seconds of the request.
7. IF wallet provisioning fails, THEN THE Wallet_Manager SHALL return an error message indicating the failure reason and the agent identifier, within 5 seconds of detecting the failure.
8. IF a balance query is requested for a non-existent or unregistered agent identifier, THEN THE Wallet_Manager SHALL return an error message indicating that no wallet exists for the specified agent.
9. THE Wallet_Manager SHALL ensure that no CDP private key material is stored in application code, environment variables, or any location outside of the AgentCore Identity Token Vault and its backing Secrets Manager secret.

### Requirement 3: x402 Micropayment Execution

**User Story:** As a specialized agent, I want to pay for data and services from other agents using x402 micropayments, so that I can autonomously acquire resources needed for my tasks.

#### Acceptance Criteria

1. WHEN a Specialized_Agent receives an HTTP 402 response from a Merchant_Endpoint, THE Payment_Executor SHALL extract the payment requirements from the response headers.
2. IF the extracted payment requirements are missing required fields (recipient address, amount, or asset type), THEN THE Payment_Executor SHALL reject the payment request and return an error to the requesting Specialized_Agent indicating the missing fields.
3. WHEN payment requirements are extracted and valid, THE Payment_Executor SHALL verify that the requesting agent wallet holds sufficient USDC balance and that the payment amount does not exceed 10 USDC per transaction, before executing the on-chain payment to the merchant wallet address.
4. IF the requesting agent wallet has insufficient USDC balance or the payment amount exceeds 10 USDC, THEN THE Payment_Executor SHALL reject the payment and return an error to the requesting Specialized_Agent indicating the reason for rejection without submitting an on-chain transaction.
5. WHEN a payment is settled on-chain with at least 1 block confirmation, THE Payment_Executor SHALL replay the original request with the payment receipt attached.
6. IF the replayed request fails after a successful on-chain payment, THEN THE Payment_Executor SHALL return an error to the requesting Specialized_Agent that includes the payment transaction hash, the replay failure reason, and the original request details so the agent can retry or escalate.
7. THE Payment_Executor SHALL complete the full payment cycle (402 receipt, payment, replay) within 5 seconds, measured from initial 402 response receipt to final replay response receipt.
8. IF a payment transaction fails on-chain, THEN THE Payment_Executor SHALL return an error to the requesting Specialized_Agent with the failure reason and transaction hash.

### Requirement 4: Income Storage and Collection

**User Story:** As a system operator, I want agent income from trades to be stored in Coinbase wallets, so that earnings are securely held and auditable.

#### Acceptance Criteria

1. WHEN a Specialized_Agent acting as a merchant receives an x402 payment that passes protocol-level validation, THE Wallet_Manager SHALL credit the incoming USDC amount (to 6 decimal places) to that agent's dedicated wallet within 30 seconds of payment receipt.
2. THE Wallet_Manager SHALL reconcile on-chain transaction confirmations with expected incoming payments within 60 seconds of settlement.
3. WHEN income is received, THE Audit_Logger SHALL record the source agent identifier, destination agent identifier, amount in USDC (to 6 decimal places), on-chain transaction hash, and timestamp in UTC with second-level precision.
4. IF an incoming payment cannot be reconciled with a known transaction within the 60-second reconciliation window, THEN THE Audit_Logger SHALL flag the transaction for manual review by persisting a review entry that includes the unreconciled payment details and a status of "pending_review" retrievable by system operators.
5. IF the Wallet_Manager fails to credit an agent's wallet due to service unavailability, THEN THE Wallet_Manager SHALL retry the credit operation up to 3 times with exponential backoff, and IF all retries fail, THEN THE Audit_Logger SHALL record the failure and flag the transaction for manual review.
6. IF a duplicate payment is detected for the same on-chain transaction hash, THEN THE Wallet_Manager SHALL reject the duplicate credit and THE Audit_Logger SHALL record the duplicate attempt.

### Requirement 5: Policy-Based Spending Controls

**User Story:** As a system operator, I want to set spending policies per agent, so that no single agent can overspend or drain funds without authorization.

#### Acceptance Criteria

1. THE Spending_Policy SHALL define a maximum per-transaction limit in USDC for each Specialized_Agent, with a configurable value from 0.01 USDC to 999,999,999.99 USDC.
2. THE Spending_Policy SHALL define a maximum cumulative spending limit per 24-hour rolling window for each Specialized_Agent, where the rolling window includes all successfully executed payments within the preceding 24 hours from the current payment request time.
3. WHEN a Specialized_Agent initiates a payment, THE Payment_Executor SHALL compare the payment amount against the per-transaction limit and verify that the sum of the payment amount plus all successfully executed payments by that agent within the preceding 24-hour rolling window does not exceed the cumulative limit, before execution.
4. IF a payment request exceeds the per-transaction limit (amount strictly greater than the limit), THEN THE Payment_Executor SHALL reject the payment and return a policy violation error indicating the per-transaction limit was exceeded to the Specialized_Agent.
5. IF a payment request would cause the agent's cumulative spending within the 24-hour rolling window to strictly exceed the cumulative limit, THEN THE Payment_Executor SHALL reject the payment and return a cumulative limit exceeded error to the Specialized_Agent.
6. WHEN a Spending_Policy is updated, THE Payment_Executor SHALL apply the new policy to all subsequent payment requests for the affected agent within 10 seconds.
7. IF a Specialized_Agent initiates a payment and no Spending_Policy is defined for that agent, THEN THE Payment_Executor SHALL reject the payment and return an error indicating no spending policy is configured.

### Requirement 6: Transaction Audit Trail

**User Story:** As a system operator, I want a complete audit trail of all agent transactions, so that I can review, debug, and comply with reporting requirements.

#### Acceptance Criteria

1. THE Audit_Logger SHALL record every payment initiation, settlement, and failure event with a unique correlation identifier.
2. WHEN a transaction event is recorded, THE Audit_Logger SHALL capture: source agent identifier, destination agent identifier, amount in USDC, transaction hash, timestamp in ISO 8601 UTC format, payment status, and policy evaluation result.
3. THE Audit_Logger SHALL retain all transaction records for a minimum of 90 days.
4. WHEN queried with a time range and optional agent filter, THE Audit_Logger SHALL return up to 10,000 matching transaction records ordered by timestamp in descending order within 5 seconds.
5. IF the Audit_Logger fails to persist a transaction record, THEN THE Audit_Logger SHALL retry persistence three times with exponential backoff starting at 1 second and doubling each interval.
6. IF all three persistence retries are exhausted, THEN THE Audit_Logger SHALL emit a critical alert indicating the failed correlation identifier and preserve the unpersisted record in memory until the next retry cycle.

### Requirement 7: Merchant Endpoint Exposure

**User Story:** As a specialized agent, I want to expose my data or services behind an x402 paywall, so that other agents pay me for access.

#### Acceptance Criteria

1. THE Trading_System SHALL deploy x402-enabled Merchant_Endpoints using CloudFront and Lambda@Edge.
2. WHEN an unauthenticated or unpaid request arrives at a Merchant_Endpoint, THE Merchant_Endpoint SHALL return an HTTP 402 response within 2 seconds, including payment requirements in the response headers that specify the price in USDC, the accepted network, and the recipient payment address.
3. WHEN a request includes a valid x402 payment receipt, THE Merchant_Endpoint SHALL verify the receipt on-chain within 30 seconds and, upon successful verification, serve the requested data or service. A receipt is valid when it confirms the correct amount, correct recipient address, has not expired, and has not been previously redeemed.
4. IF a payment receipt is invalid or expired, THEN THE Merchant_Endpoint SHALL return an HTTP 402 response indicating the specific validation failure reason.
5. IF a payment receipt has already been redeemed for a prior request, THEN THE Merchant_Endpoint SHALL reject the request with an HTTP 402 response indicating the receipt has already been used.
6. IF on-chain verification is unavailable or does not complete within 30 seconds, THEN THE Merchant_Endpoint SHALL return an HTTP 503 response indicating a temporary verification failure, without consuming the payment receipt.
7. THE Merchant_Endpoint SHALL support configurable pricing per endpoint path, specified in USDC with a minimum price of 0.01 USDC and a maximum price of 10,000 USDC, configurable at deploy time.

### Requirement 8: Dependency Security

**User Story:** As a system operator, I want to prevent compromised axios versions from being installed, so that the system is protected from the March 2026 supply chain attack.

#### Acceptance Criteria

1. THE Supply_Chain_Guard SHALL configure npm overrides to pin axios to version 1.13.6 across all transitive dependencies.
2. THE Supply_Chain_Guard SHALL prevent resolution of axios versions 1.14.1 and 0.30.4 in the dependency tree.
3. WHEN a dependency installation is performed, THE Supply_Chain_Guard SHALL verify that no compromised axios version is present in the resolved dependency tree.
4. IF a compromised axios version is detected during installation, THEN THE Supply_Chain_Guard SHALL fail the installation and emit a security alert identifying the compromised version and the dependency path that introduced it.

### Requirement 9: Infrastructure Deployment

**User Story:** As a system operator, I want the entire trading system deployed via AWS CDK in TypeScript, so that infrastructure is reproducible, version-controlled, and follows infrastructure-as-code best practices.

#### Acceptance Criteria

1. THE Trading_System SHALL define all AWS infrastructure as CDK constructs in TypeScript.
2. THE Trading_System SHALL deploy AgentCore resources, CloudFront distributions, Lambda@Edge functions, Secrets Manager secrets, and IAM roles via a single CDK application.
3. WHEN the CDK application is synthesized, THE Trading_System SHALL produce a valid CloudFormation template with no synthesis errors.
4. THE Trading_System SHALL use IAM least-privilege policies for all deployed roles and functions, where no IAM policy statement uses wildcard ("*") actions and resource ARNs are scoped to the specific resources required by each function.
5. WHEN the CDK application is deployed, THE Trading_System SHALL configure AgentCore session memory so that agent state is retained for at least 24 hours and is retrievable in subsequent agent invocations using the same session identifier.
6. IF the CDK deployment fails due to a resource provisioning error, THEN THE Trading_System SHALL roll back all resources created during the failed deployment and produce a deployment error output indicating the failed resource and reason for failure.

### Requirement 10: Agent-to-Agent Service Discovery

**User Story:** As a specialized agent, I want to discover available services and their pricing from other agents, so that I can make informed purchasing decisions.

#### Acceptance Criteria

1. THE Trading_System SHALL maintain a service registry listing all registered and reachable Merchant_Endpoints with their endpoint URLs, descriptions (maximum 500 characters), USDC pricing (ranging from 0.01 to 999,999.99), and at least one capability tag identifying the service function.
2. WHEN a Specialized_Agent queries the service registry with one or more capability tags, THE Trading_System SHALL return all matching services whose capability tags contain at least one of the queried tags, limited to a maximum of 100 results, within 5 seconds.
3. WHEN a new Merchant_Endpoint is deployed, THE Trading_System SHALL register the endpoint in the service registry within 30 seconds.
4. WHEN a Merchant_Endpoint is decommissioned, THE Trading_System SHALL remove the endpoint from the service registry within 30 seconds.
5. IF a Specialized_Agent queries the service registry and no services match the provided capability tags, THEN THE Trading_System SHALL return an empty result set with a message indicating no matching services were found.
6. IF the service registry is unavailable when a Specialized_Agent submits a query, THEN THE Trading_System SHALL return an error indication stating the registry is temporarily unavailable and the agent should retry after at least 5 seconds.
