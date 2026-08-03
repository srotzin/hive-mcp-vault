# hive-mcp-vault

[![srotzin/hive-mcp-vault MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-vault/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-vault)

MCP access to confirmed HiveVault FENR reads and an AES-256-GCM encrypted item store.

## Live contract

The server exposes four read-only MCP tools backed by the live HiveVault service:

| Tool | Live backend route |
|---|---|
| `vault.balance` | `GET /vault/balance` |
| `vault.stats` | `GET /vault/stats` |
| `vault.identity` | `GET /vault/identity` |
| `vault.quantum_pubkey` | `GET /vault/quantum/pubkey` |

`vault.balance` returns the backend response exactly as received. An unauthenticated response can be marked `obfuscated: true`; clients must not treat that value as a confirmed treasury balance.

The server also exposes an encrypted item store:

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/vault/store` | Store an AES-256-GCM encrypted item after the x402 gate |
| `GET` | `/v1/vault/store/:item_ref` | Confirm a stored item exists without returning plaintext |

Unknown paths return HTTP 404. Upstream failures return explicit MCP errors. The service does not return fabricated success payloads.

## Discovery and health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Local liveness and current upstream reachability |
| `POST` | `/mcp` | MCP JSON-RPC 2.0, protocol `2024-11-05` |
| `GET` | `/.well-known/mcp.json` | MCP discovery manifest |
| `GET` | `/.well-known/agent-card.json` | A2A agent card |
| `GET` | `/.well-known/agent.json` | Agent card |
| `GET` | `/.well-known/oac.json` | Open Agent Card JSON-LD |
| `GET` | `/llms.txt` | Plain-text integration guide |

## Persistence

Set `BOGO_DB_PATH` to a path on durable storage in production. The default path, `/tmp/bogo_vault.db`, is suitable only for local development and tests. The server refuses to start in production unless an explicit database path is configured.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No, default `3000` | HTTP port |
| `VAULT_BACKEND_URL` | No, default `https://hive-vault.onrender.com` | Live HiveVault backend |
| `INTERNAL_KEY` | Yes in production | Derives the local encryption key and is sent to the backend as `x-vault-key` |
| `BOGO_DB_PATH` | Yes in production | SQLite database path on durable storage. Local development defaults to `/tmp/bogo_vault.db` |
| `BASE_RPC_URL` | No, default `https://mainnet.base.org` | Base RPC endpoint used for x402 payment verification |

The server refuses to start with `NODE_ENV=production` if `INTERNAL_KEY` or `BOGO_DB_PATH` is missing.

## Testing

```bash
npm install
npm test
```

Tests cover health reporting, unknown-route handling, MCP tool discovery, upstream failure behavior, encrypted storage, and plaintext absence from the SQLite file.

## Brand

Hive Civilization. Brand gold `#C08D23`. Steve Rotzin.

## Directory

- Endpoint directory: https://thehiveryiq.com
- Other MCP servers: https://github.com/srotzin?tab=repositories&q=hive-mcp
