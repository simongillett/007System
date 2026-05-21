# Chainlink for Agents API Reference

**Base URL:** use the Chainlink for Agents URL supplied for your environment.  
**OpenAPI:** `GET {BASE_URL}/v1/openapi.yaml`  
**Agent card:** `GET {BASE_URL}/.well-known/agent.json`  
**Catalog:** `GET {BASE_URL}/v1/catalog` and `GET {BASE_URL}/v1/catalog/{name}`  
**Skill guide:** `GET {BASE_URL}/v1/skills`  
**Skill bundle:** `GET {BASE_URL}/v1/skills/bundle`

## EIP-191 Authentication

Protected routes require three headers:

| Header | Description |
|--------|-------------|
| `X-Agent-Address` | EVM address of the signer. |
| `X-Agent-Signature` | EIP-191 `personal_sign` signature over the canonical message. |
| `X-Agent-Timestamp` | Unix time in seconds; must be close to server time. |

Canonical message:

```text
<METHOD> <path[?raw_query]>
<unix_timestamp>
```

If the HTTP request has a body, append a third line:

```text
0x<lowercase_hex_sha256_of_raw_body_bytes>
```

`METHOD` is uppercase. The path includes the raw query string when present. The body hash must cover the exact bytes sent. `scripts/sign_request.py` prints the headers and canonical string.

## Public Discovery

### `GET /.well-known/agent.json`

Returns the agent card with capability and discovery metadata.

### `GET /v1/openapi.yaml`

Returns the OpenAPI specification.

### `GET /v1/skills`, `GET /v1/skills/bundle`, `GET /v1/skills/file/...`

`GET /v1/skills` returns the root Chainlink for Agents `SKILL.md` markdown. `GET /v1/skills/bundle` returns the full skill tree as a zip, including references and helper scripts. `GET /v1/skills/file/...` returns an individual bundled file by relative path.

### `GET /v1/catalog`

Returns catalog item names and descriptions. No authentication is required.

### `GET /v1/catalog/{name}`

Returns metadata for one workflow or endpoint-backed skill, including pricing metadata, `input_schema`, and `execute_endpoint`. Workflows use `POST /v1/operations/{workflowName}`. Endpoint-backed skills include the full path to call in `execute_endpoint`.

### `GET /v1/terms-of-service`

Returns the active Terms of Service metadata and ready-to-sign EIP-712 `typed_data`. Sign `typed_data` locally to produce `tos_signature` for `POST /v1/register` or `PATCH /v1/register`.

## Registration

### `POST /v1/register`

Creates an agent profile for the EIP-191 signer. Requires EIP-191 headers, Terms of Service signature, and x402 payment when priced.

```json
{
  "tos_signature": "0x...",
  "execution_mode": "guardrailed"
}
```

`execution_mode` is optional on first registration. The default is `guardrailed`; `unrestricted` enables presigned direct operations.

Response `201`:

```json
{
  "agent_id": "<uuid>",
  "agent_address": "0x<signer>",
  "execution_mode": "guardrailed"
}
```

### `PATCH /v1/register`

Updates the registered agent's ToS signature and/or execution mode. Omit fields you are not changing. At least one effective update is required.

## Wallets and Networks

### `GET /v1/networks`

Lists supported chains, including `chain_id`, `chain_selector`, `chain_family`, and display metadata.

### `GET /v1/wallets`

Lists wallets for the authenticated agent.

### `POST /v1/wallets`

Creates a wallet for a supported chain selector.

```json
{
  "chain_selector": "16015286601757825753"
}
```

Response `201`:

```json
{
  "agent_address": "0x...",
  "wallet_address": "0x...",
  "chain_selector": "16015286601757825753"
}
```

## Operations

### `GET /v1/operations`

Lists operations for the authenticated agent.

### `GET /v1/operations/{id}`

Returns operation status. For workflow operations that need a signature, the response includes `eip712`, `transactions`, `deadline`, and `wallet_operation_id` when signing data is ready. Poll at most once every 5 seconds per operation.

### `POST /v1/operations/{workflowName}`

Runs a catalog workflow. `workflowName` is a catalog slug, not an operation id.

```json
{
  "params": { "...": "workflow-specific" }
}
```

For chain-specific workflows, include `chain_selector` inside `params` using a value from `GET /v1/networks`.

Response `202` includes `operation_id` for polling. Chain-write workflows may also return `eip712` immediately.

### `POST /v1/operations/{id}/submit`

Submits a local EIP-712 signature for a workflow operation.

```json
{
  "signature": "0x..."
}
```

Only the same agent that created the operation may submit it.

### `POST /v1/operations/direct`

Submits a presigned transaction batch. Requires `execution_mode=unrestricted`.

```json
{
  "chain_selector": "16015286601757825753",
  "nonce": "170141183460469231731687303715884105727",
  "deadline": 0,
  "transactions": [
    { "to": "0x...", "value": "0", "data": "0x..." }
  ],
  "signature": "0x..."
}
```

Use workflow submit instead for workflow operations that return `eip712`.

## Data Streams

### `GET /v1/streams/...`

When available, Data Streams endpoint-backed skills are listed in the catalog with their exact `execute_endpoint` path and query requirements.

## Typical Status Codes

| Code | Meaning |
|------|---------|
| 401 | EIP-191 missing or invalid, clock skew, or unknown signer. |
| 402 | x402 payment required or payment authorization invalid. |
| 403 | Terms of Service or execution mode requirement not satisfied. |
| 404 | Unknown operation or resource. |
| 409 | Conflict, such as already registered. |
| 502 | Upstream dependency error. |
