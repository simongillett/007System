---
inclusion: manual
---

# Chainlink for Agents

## Start here

1. **Agent card**: `GET https://agents.chain.link/.well-known/agent.json` for capabilities, pricing, and available workflows.
2. **OpenAPI spec**: `GET https://agents.chain.link/v1/openapi.yaml` for the complete API contract.
3. **Catalog**: `GET https://agents.chain.link/v1/catalog` for names and descriptions; `GET https://agents.chain.link/v1/catalog/{name}` for `input_schema`, pricing, and the execute endpoint.
4. **Skill guide**: `GET https://agents.chain.link/v1/skills` for this root markdown guide.
5. **Skill bundle**: `GET https://agents.chain.link/v1/skills/bundle` to download this guide, references, and helper scripts.

## Quick setup

```bash
export CHAINLINK_AGENTS_URL="https://agents.chain.link"
pip install eth-account eth-abi requests
python chainlink-for-agents/scripts/generate_signer_key.py
export AGENT_PRIVATE_KEY="0x..."
```

Fund the signer address or payment wallet with USDC on Base before calling paid routes. x402 payments are settled from that key or wallet, so paid calls will fail if it does not have enough Base USDC.

Chainlink for Agents lets an agent register, create chain wallets, run catalog workflows, sign any required EIP-712 operation data locally, and submit signed operations. Your private key stays local.

## One key, three uses

One EVM private key typically covers:

- **EIP-191 request signing**: authenticate protected API calls with `X-Agent-*` headers.
- **x402 payment authorization**: sign EIP-3009 USDC payment challenges when a paid route returns HTTP 402.
- **EIP-712 operation signing**: sign operation data returned by Chainlink for Agents before submit.

Never send the private key to Chainlink for Agents or any third-party service.

## EIP-191 request signing

Most protected routes require this canonical message, signed with EIP-191 `personal_sign`:

```text
POST /v1/register
1713700000
0x<sha256_hex_of_exact_request_body_bytes>
```

- First line: uppercase method, space, escaped path plus raw query string when present.
- Second line: Unix timestamp in seconds.
- Third line: only when the request has a body: `0x` plus lowercase SHA-256 of the exact bytes sent.

Send these headers with the request:

| Header | Value |
|--------|-------|
| `X-Agent-Address` | Signer address |
| `X-Agent-Signature` | EIP-191 signature |
| `X-Agent-Timestamp` | Same Unix timestamp used in the signed message |

```bash
python chainlink-for-agents/scripts/sign_request.py \
  --method GET \
  --path /v1/wallets
```

For registration, `scripts/sign_registration.py` builds the body and signs `POST /v1/register`:

```bash
python chainlink-for-agents/scripts/sign_registration.py \
  --tos-signature "$TOS_SIG"
```

## 1. Accept Terms and Register

Fetch the current Terms of Service typed data:

```bash
curl -sS "$CHAINLINK_AGENTS_URL/v1/terms-of-service"
```

Sign the returned `typed_data` locally to produce `tos_signature`, then call `POST /v1/register` with EIP-191 headers and x402 payment when required:

```json
{
  "tos_signature": "<EIP-712 signature over current ToS typed data>",
  "execution_mode": "guardrailed"
}
```

`execution_mode` is optional on first registration. `guardrailed` is the restricted mode: it limits the agent to catalog workflows and workflow submit routes. `unrestricted` also enables presigned direct transaction batches through `POST /v1/operations/direct`.

Always ask the user for explicit permission before changing an agent from restricted or `guardrailed` mode to `unrestricted`. Change mode later with `PATCH /v1/register` only after the user approves the escalation.

If a protected route returns `403` with `TOS_SIGNATURE_REQUIRED`, fetch the latest ToS typed data, sign it, and call `PATCH /v1/register` with the fresh `tos_signature`.

A successful registration returns `agent_id`, `agent_address`, and `execution_mode`. A `409` means the signer is already registered; use `PATCH /v1/register` for updates.

## 2. Create and List Chain Wallets

An SVA (Signature Verifying Account) is a smart contract wallet that executes transactions only when they are authorized by a valid cryptographic signature.

List wallets:

```http
GET /v1/wallets
```

Create a wallet for a supported chain selector:

```http
POST /v1/wallets
```

```json
{
  "chain_selector": "16015286601757825753"
}
```

Use `GET /v1/networks` to discover supported chains. Wallet routes require EIP-191 signing, current ToS acceptance, and x402 payment when the route is priced.

## 3. Discover Workflows and Endpoint Skills

`GET /v1/catalog` returns catalog item names and descriptions. Use `GET /v1/catalog/{name}` for pricing metadata, `input_schema`, and the endpoint to call.

Endpoint-backed Data Streams skills may include entries such as `streams-latest-report`, `streams-report-at-timestamp`, and `streams-bulk-reports`; call the `execute_endpoint` path shown in the catalog detail response.

## 4. Run a Workflow

Workflow execution uses the workflow name from the catalog:

```http
POST /v1/operations/{workflowName}
```

```json
{
  "params": { "...": "workflow-specific" }
}
```

For chain-specific workflows, include `chain_selector` inside `params` using a value from `GET /v1/networks`.

For token workflows:

- `token-info` needs `chain_selector` and `token_address`; use it to read token metadata before amount-based actions.
- `token-balance` needs `chain_selector` and `token_address`.
- `token-transfer` needs `chain_selector`, `token_address`, and `to_address`.

A `202` response includes `operation_id`. For workflows that need an on-chain submit step, the response or a later poll may include `eip712`, `transactions`, `deadline`, and `wallet_operation_id`.

## 5. Poll Operation Status

```http
GET /v1/operations/{id}
```

For workflow execution before an on-chain submit, poll at most once every 5 seconds per operation. When the operation is ready for a local signature, the response includes the `eip712` object to sign.

## 6. Sign EIP-712 Locally

Use the `eip712` object returned by workflow execution or polling:

```bash
SIG=$(
  python chainlink-for-agents/scripts/eip712_sign.py --typed-data "$EIP712_JSON" \
    | jq -r .signature
)
```

See `#[[file:chainlink-for-agents/references/eip712-signing.md]]` for full usage and submit examples.

## 7. Submit a Signed Workflow Operation

For workflow operations that return EIP-712 data, submit only the signature:

```http
POST /v1/operations/{id}/submit
```

```json
{
  "signature": "<EIP-712 signature>"
}
```

After submit returns `202`, the gateway waits for chain finality before confirming the write status. On Ethereum, Base, and Arbitrum this can take time, often around 15 minutes on average. Poll `GET /v1/operations/{id}` about once per minute while waiting for the chain write to finalize.

## 8. Submit Direct Operations

`POST /v1/operations/direct` is only for agents with `execution_mode=unrestricted`. Ask the user for explicit permission before enabling unrestricted mode or using this route. Submit a presigned transaction batch with `chain_selector`, `nonce`, `deadline`, `transactions`, and `signature`. Use workflow submit (`POST /v1/operations/{id}/submit`) for workflow operations that return `eip712`.

Direct operations are chain writes, so the gateway waits for chain finality before confirming the write status. On Ethereum, Base, and Arbitrum this can take time, often around 15 minutes on average. Poll the returned operation status about once per minute while waiting for finality.

## x402 Payments

Paid routes may return HTTP 402. The signer key or payment wallet used for x402 must hold enough USDC on Base before retrying the paid request. Use `chainlink-for-agents/scripts/x402_payment.py` to parse the x402 challenge, sign the EIP-3009 `TransferWithAuthorization` USDC authorization locally, and retry with the canonical payment header. Set `--max-amount-usdc` as a safety cap.

See `#[[file:chainlink-for-agents/references/x402-payments.md]]` for details.

## Other Useful Routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/networks` | Supported chains |
| GET | `/v1/catalog` | Catalog item names and descriptions |
| GET | `/v1/catalog/{name}` | Catalog item metadata |
| GET | `/v1/operations` | Operations for the authenticated agent |
| GET | `/v1/streams/...` | Data Streams endpoints, when available |

## Typical Errors

| HTTP | Meaning |
|------|---------|
| 401 | Missing or invalid EIP-191 headers, timestamp skew, or unknown signer |
| 402 | x402 payment required or payment authorization invalid |
| 403 | Terms of Service or execution mode requirement not satisfied |
| 409 | Agent or wallet already exists |

## References

- `#[[file:chainlink-for-agents/references/api-reference.md]]`: concise endpoint reference
- `#[[file:chainlink-for-agents/references/eip712-signing.md]]`: EIP-712 signing and submit examples
- `#[[file:chainlink-for-agents/references/x402-payments.md]]`: x402 payment flow and helper script usage
