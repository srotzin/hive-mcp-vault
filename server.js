// server.js — HiveVault MCP Server
import express from 'express';
import { smashProvMiddleware, getPubkeyInfo as getProvPubkeyInfo, verifyProvSig } from './lib/prov.js';
import { mcpErrorWithEnvelope, recruitmentEnvelope, assertEnvelopeIntegrity } from './recruitment.js';
assertEnvelopeIntegrity();
import { buildAgentCard, buildOacJsonLd, renderRootHtml } from './hive-agent-card.js';
import cors from 'cors';
import { renderLanding, renderRobots, renderSitemap, renderSecurity, renderOgImage, seoJson, BRAND_GOLD } from './meta.js';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;
// Single source of truth for the version string. Every manifest, health
// check, and descriptor in this file reads from here so version claims
// cannot drift apart across surfaces.
const SERVICE_VERSION = '1.1.0';

// Production storage and encryption settings are validated before SQLite is
// opened. This prevents a production process from silently creating an
// ephemeral database before discovering that durable storage was omitted.
const IS_PROD = process.env.NODE_ENV === 'production';
const INTERNAL_KEY = process.env.INTERNAL_KEY || '';
const BOGO_DB_PATH = process.env.BOGO_DB_PATH || '/tmp/bogo_vault.db';
if (!INTERNAL_KEY && IS_PROD) {
  console.error('[hivevault-mcp] FATAL: INTERNAL_KEY is not set. Refusing to start in production without it.');
  process.exit(1);
}
if (!process.env.BOGO_DB_PATH && IS_PROD) {
  console.error('[hivevault-mcp] FATAL: BOGO_DB_PATH is not set. Refusing to start in production without an explicit durable database path.');
  process.exit(1);
}
const _EFFECTIVE_INTERNAL_KEY = INTERNAL_KEY || 'dev-placeholder-internal-key-not-for-production';

// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(BOGO_DB_PATH);
_bogoDB.pragma('journal_mode = WAL');
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS did_call_count ' +
  '(did TEXT PRIMARY KEY, paid_calls INTEGER NOT NULL DEFAULT 0)'
);

const _bogoGetStmt = _bogoDB.prepare(
  'SELECT paid_calls FROM did_call_count WHERE did = ?'
);
const _bogoUpsertStmt = _bogoDB.prepare(
  'INSERT INTO did_call_count (did, paid_calls) VALUES (?, 1) ' +
  'ON CONFLICT(did) DO UPDATE SET paid_calls = paid_calls + 1'
);

// vault_items backs POST /v1/vault/store with a real encrypted write. Earlier behavior
// claimed `ok: true, receipt: { queued: true, item_ref: null }` without ever
// writing anything anywhere, which is a fabricated success response. Every
// stored item now gets an actual row and a real item_ref returned to the
// caller, so a stored item can actually be looked up later.
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS vault_items ' +
  '(item_ref TEXT PRIMARY KEY, did TEXT, payload TEXT, created_at TEXT NOT NULL)'
);
const _vaultInsertStmt = _bogoDB.prepare(
  'INSERT INTO vault_items (item_ref, did, payload, created_at) VALUES (?, ?, ?, ?)'
);
const _vaultGetStmt = _bogoDB.prepare(
  'SELECT item_ref, did, created_at FROM vault_items WHERE item_ref = ?'
);

function _vaultStore(did, payload) {
  const item_ref = `vi_${randomBytesHex(16)}`;
  const created_at = new Date().toISOString();
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const key = crypto.createHash('sha256').update(_EFFECTIVE_INTERNAL_KEY, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const sealed = JSON.stringify({
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: authTag.toString('base64url'),
  });
  _vaultInsertStmt.run(item_ref, did, sealed, created_at);
  return { item_ref, created_at };
}

function randomBytesHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function _bogoCheck(did) {
  if (!did) return { free: false };
  const row = _bogoGetStmt.get(did);
  const n   = row ? row.paid_calls : 0;
  if (n === 0)        return { free: true, reason: 'first_call_free' };
  if (n % 6 === 0)    return { free: true, reason: 'loyalty_freebie' };
  return { free: false };
}

function _bogoIncrement(did) {
  if (did) _bogoUpsertStmt.run(did);
}

const BOGO_BLOCK = {
  first_call_free: true,
  loyalty_threshold: 6,
  loyalty_message:
    "Every 6th paid call is free. Present your DID via 'x-hive-did' header to track progress.",
};
// ─────────────────────────────────────────────────────────────────────────

async function _verifyUsdcPayment(tx_hash, min_usd) {
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return { ok: false, reason: 'invalid_tx_hash' };
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  let receipt;
  try   { receipt = await provider.getTransactionReceipt(tx_hash); }
  catch (err) { return { ok: false, reason: `rpc_error: ${err.message}` }; }
  if (!receipt)            return { ok: false, reason: 'tx_not_found_or_pending' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };
  const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_ADDR  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const XFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (log.topics?.[0] !== XFER_TOPIC) continue;
    if (('0x' + log.topics[2].slice(26).toLowerCase()) !== WALLET_ADDR.toLowerCase()) continue;
    total += BigInt(log.data);
  }
  if (total === 0n)  return { ok: false, reason: 'no_transfer_to_wallet' };
  const amount_usd = Number(total) / 1e6;
  if (amount_usd + 1e-9 < min_usd) return { ok: false, reason: 'underpaid', amount_usd };
  return { ok: true, amount_usd };
}


// ─── Environment validation ─────────────────────────────────────────────────
// BASE_URL points at the live HiveVault FENR backend. This service exposes
// only routes confirmed in that backend's OpenAPI document.
const BASE_URL = process.env.VAULT_BACKEND_URL || 'https://hive-vault.onrender.com';

// Upstream health is probed lazily and cached briefly so /health reflects
// reality instead of always claiming "ok".
let _upstreamHealth = { checked_at: 0, reachable: null, detail: null };
const UPSTREAM_HEALTH_TTL_MS = 15_000;

async function checkUpstreamHealth() {
  const now = Date.now();
  if (now - _upstreamHealth.checked_at < UPSTREAM_HEALTH_TTL_MS && _upstreamHealth.reachable !== null) {
    return _upstreamHealth;
  }
  try {
    const resp = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(4000) });
    const reachable = resp.ok;
    _upstreamHealth = { checked_at: now, reachable, detail: `upstream responded ${resp.status}` };
  } catch (err) {
    _upstreamHealth = { checked_at: now, reachable: false, detail: `upstream unreachable: ${err?.message || err}` };
  }
  return _upstreamHealth;
}

async function fetchResource(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Upstream resource unavailable: ${error?.message || error}`);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Upstream resource returned non-JSON content with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`Upstream resource returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── smash.prov middleware (BEFORE paywall) ─────────────────────────────────
app.use(smashProvMiddleware);

// ── /v1/prov routes (free, never paywalled) ─────────────────────────────────
app.get('/v1/prov/pubkey', async (_req, res) => {
  try { res.json(await getProvPubkeyInfo()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/prov/verify', async (req, res) => {
  try {
    const { method, path: p, body_b64u = '', ts, sig_b64u } = req.body || {};
    if (!method || !p || ts == null || !sig_b64u) return res.status(400).json({ error: 'missing fields' });
    res.json(await verifyProvSig({ method, path: p, body_b64u, ts, sig_b64u }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ─── Liveness ───────────────────────────────────────────────
// Liveness only. Answers one question: is this process alive and able to serve
// a request. It deliberately says nothing about the upstream backend, and it
// makes no claim that tool calls will succeed. Use /health for that.
//
// This exists because a platform liveness probe pointed at /health will kill
// this process whenever the upstream is slow, and restarting this process
// cannot repair an upstream. The platform health check path is set to /livez.
// /health keeps returning 503 when the upstream is unreachable, so no caller
// is ever told ok while the tools would fail.
app.get('/livez', (req, res) => {
  res.status(200).json({
    status: 'alive',
    scope: 'process_only',
    service: 'hivevault-mcp',
    version: SERVICE_VERSION,
    note: 'Process liveness only. This says nothing about upstream reachability. Call /health for upstream status.',
    upstream_checked: false,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ─── Health ─────────────────────────────────────────────────────────────────
// Reports this process's own liveness plus the real, just-checked reachability
// of the upstream vault backend. Tool calls proxy to that backend, so a
// service that only reports its own liveness while tools silently fail
// upstream is a fabricated-success bug. status is "ok" only when both this
// process and the upstream backend are healthy; otherwise "degraded".
app.get('/health', async (req, res) => {
  const upstream = await checkUpstreamHealth();
  const status = upstream.reachable ? 'ok' : 'degraded';
  res.status(upstream.reachable ? 200 : 503).json({
    status,
    service: 'hivevault-mcp',
    version: SERVICE_VERSION,
    description: 'MCP access to the live HiveVault FENR display balance, statistics, identity, quantum key, and encrypted item store.',
    upstream: {
      url: BASE_URL,
      reachable: upstream.reachable,
      detail: upstream.detail,
      checked_at: new Date(upstream.checked_at).toISOString(),
    },
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ─── MCP Tools ──────────────────────────────────────────────────────────────

// ─── Agent-native config (A2A AgentCard + OAC JSON-LD) ───────────────────
const HIVE_AGENT_CFG = {
  name: 'HiveVault MCP',
  description: "MCP access to HiveVault FENR. Exposes the backend display balance, statistics, identity, and quantum public key, plus a real encrypted item store with x402 settlement.",
  url: 'https://mcp-vault.thehiveryiq.com',
  version: SERVICE_VERSION,
  repoUrl: 'https://github.com/srotzin/hive-mcp-vault',
  did: 'did:hive:vault',
  gatewayUrl: 'https://mcp-vault.thehiveryiq.com',
  tools: [],
};

const MCP_TOOLS = [
  {
    name: 'vault.balance',
    description: 'Read the HiveVault Base USDC display balance view. The unauthenticated backend marks this value as obfuscated.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault.stats',
    description: 'Read live HiveVault service statistics.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault.identity',
    description: 'Read the live HiveVault service identity document.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault.quantum_pubkey',
    description: 'Read the quantum-signature public key and algorithm metadata published by HiveVault.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
];


const SERVICE_CFG = {
  service: "hive-mcp-vault",
  shortName: "HiveVault",
  title: "HiveVault FENR MCP",
  tagline: "Live HiveVault reads plus a real encrypted item store.",
  description: "MCP access to the live HiveVault FENR backend and a local AES-256-GCM encrypted item store with x402 USDC settlement.",
  keywords: ["mcp", "model-context-protocol", "x402", "agentic", "ai-agent", "hive", "hive-civilization", "vault", "encrypted-store", "usdc", "base"],
  externalUrl: "https://mcp-vault.thehiveryiq.com",
  gatewayMount: "/vault",
  version: SERVICE_VERSION,
  pricing: [
    { name: "vault.balance", priceUsd: 0, label: "Balance view, free" },
    { name: "vault.stats", priceUsd: 0, label: "Statistics, free" },
    { name: "vault.identity", priceUsd: 0, label: "Identity, free" }
  ],
};
SERVICE_CFG.tools = (typeof TOOLS !== 'undefined' ? TOOLS : (typeof MCP_TOOLS !== 'undefined' ? MCP_TOOLS : [])).map(t => ({ name: t.name, description: t.description }));

HIVE_AGENT_CFG.tools = MCP_TOOLS;
// ─── MCP Prompts ────────────────────────────────────────────────────────────
const MCP_PROMPTS = [];

// ─── Config Schema ───────────────────────────────────────────────────────────
const MCP_CONFIG_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
};

// ─── MCP Handler ─────────────────────────────────────────────────────────────
// ─── POST /v1/vault/store — pay-front for storing a vault item ───────────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment or BOGO: item is written synchronously to the vault_items table
// and a real item_ref is returned. Earlier behavior returned
// `ok: true, receipt: { queued: true, item_ref: null }` even though no write
// ever happened anywhere, downstream or otherwise. That was a fabricated
// success response and has been removed.
app.post('/v1/vault/store', async (req, res) => {
  const PRICE = 0.005;
  const did     = req.headers['x-hive-did'] || req.body?.did || null;
  const tx_hash = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;
  const item    = req.body?.item ?? null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    const stored = _vaultStore(did, item);
    return res.json({
      ok: true, bogo_applied: bogo.reason,
      receipt: { did, queued: false, item_ref: stored.item_ref, stored_at: stored.created_at },
    });
  }

  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'vault_store',
        asking_usd: 0.005, accept_min_usd: 0.005,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
      },
      bogo: BOGO_BLOCK,
      bogo_first_call_free: true,
      bogo_loyalty_threshold: 6,
      bogo_pitch: "Pay this once, your 6th call is on the house. New here. Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking 0.005 USDC on Base to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e.`,
      did: did || null,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  const stored = _vaultStore(did, item);
  res.json({
    ok: true, billed_usd: v.amount_usd, tx_hash,
    receipt: { did, queued: false, item_ref: stored.item_ref, stored_at: stored.created_at },
  });
});

// ─── GET /v1/vault/store/:item_ref — verify a stored item is real ─────────
// Lets any caller confirm that an item_ref returned above corresponds to an
// actual row, so the store receipt above is checkable rather than a bare
// claim.
app.get('/v1/vault/store/:item_ref', (req, res) => {
  const row = _vaultGetStmt.get(req.params.item_ref);
  if (!row) return res.status(404).json({ ok: false, error: 'item_ref_not_found', item_ref: req.params.item_ref });
  res.json({ ok: true, item: row });
});

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json(mcpErrorWithEnvelope(id, -32600, 'Invalid JSON-RPC'));
  }
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: 'hivevault-mcp',
            version: SERVICE_VERSION,
            description: 'MCP access to live HiveVault FENR reads and an AES-256-GCM encrypted item store. Part of Hive Civilization.',
            homepage: BASE_URL,
            icon: 'https://www.thehiveryiq.com/favicon.ico',
          },
          configSchema: MCP_CONFIG_SCHEMA,
        },
      });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    }

    if (method === 'prompts/list') {
      return res.json({ jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } });
    }

    if (method === 'prompts/get') {
      const prompt = MCP_PROMPTS.find(p => p.name === params?.name);
      if (!prompt) {
        return res.json(mcpErrorWithEnvelope(id, -32602, `Prompt not found: ${params?.name}`));
      }
      return res.json({ jsonrpc: '2.0', id, result: { messages: [] } });
    }

    if (method === 'resources/list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          resources: [
            { uri: 'hivevault://health', name: 'Vault Service Health', description: 'Current health for HiveVault.', mimeType: 'application/json' },
            { uri: 'hivevault://network/stats', name: 'Vault Statistics', description: 'Current HiveVault statistics.', mimeType: 'application/json' },
          ],
        },
      });
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      let data;
      if (uri === 'hivevault://health') {
        data = await fetchResource(`${BASE_URL}/health`);
      } else if (uri === 'hivevault://network/stats') {
        data = await fetchResource(`${BASE_URL}/vault/stats`);
      } else {
        return res.json(mcpErrorWithEnvelope(id, -32602, `Unknown resource: ${uri}`));
      }
      return res.json({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const headers = { 'Content-Type': 'application/json', 'x-hive-key': args?.api_key || '', 'x-vault-key': _EFFECTIVE_INTERNAL_KEY };

      // fetchUpstream never fabricates success. It surfaces the real upstream
      // HTTP status and body, and turns network failures, non-2xx status,
      // non-JSON bodies (e.g. a 404 HTML page from a dead backend), and
      // empty bodies into an explicit upstream_error result instead of
      // silently returning them as if they were a valid tool response.
      async function fetchUpstream(url, init) {
        let resp;
        try {
          resp = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
        } catch (err) {
          return { upstream_ok: false, upstream_status: 0, error: 'upstream_unreachable', detail: err?.message || String(err), url };
        }
        const text = await resp.text();
        if (!resp.ok) {
          let errorBody;
          try { errorBody = text ? JSON.parse(text) : {}; } catch { errorBody = { raw: text.slice(0, 500) }; }
          return { upstream_ok: false, upstream_status: resp.status, error: 'upstream_error', detail: errorBody, url };
        }
        if (!text) {
          return { upstream_ok: false, upstream_status: resp.status, error: 'empty_body', detail: 'upstream returned a 2xx with an empty body', url };
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return { upstream_ok: false, upstream_status: resp.status, error: 'non_json_body', detail: text.slice(0, 500), url };
        }
        return { upstream_ok: true, upstream_status: resp.status, ...body };
      }

      const toolRoutes = {
        'vault.balance': () => fetchUpstream(`${BASE_URL}/vault/balance`, { method: 'GET', headers }),
        'vault.stats': () => fetchUpstream(`${BASE_URL}/vault/stats`, { method: 'GET', headers }),
        'vault.identity': () => fetchUpstream(`${BASE_URL}/vault/identity`, { method: 'GET', headers }),
        'vault.quantum_pubkey': () => fetchUpstream(`${BASE_URL}/vault/quantum/pubkey`, { method: 'GET', headers }),
      };

      if (!toolRoutes[name]) {
        return res.json(mcpErrorWithEnvelope(id, -32601, `Tool not found: ${name}`));
      }
      const data = await toolRoutes[name]();
      if (data.upstream_ok === false) {
        return res.json(mcpErrorWithEnvelope(id, -32000, `Upstream call failed for ${name}: ${data.error}`, { upstream: data }));
      }
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    }

    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    return res.json(mcpErrorWithEnvelope(id, -32601, `Method not found: ${method}`));

  } catch (err) {
    return res.json(mcpErrorWithEnvelope(id, -32000, err.message));
  }
});

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hivevault-mcp',
  version: SERVICE_VERSION,
  description: 'MCP access to confirmed HiveVault FENR reads and an AES-256-GCM encrypted item store.',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  homepage: BASE_URL,
  icon: 'https://www.thehiveryiq.com/favicon.ico',
  tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description })),
  prompts: MCP_PROMPTS.map(p => ({ name: p.name, description: p.description })),
  payment: {
    scheme: 'x402', protocol: 'x402', network: 'base',
    currency: 'USDC', asset: 'USDC',
    address:   '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    treasury:  'Monroe (W1)',
    rails: [
      {chain:'base',     asset:'USDC', address:'0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'},
      {chain:'base',     asset:'USDT', address:'0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'},
      {chain:'ethereum', asset:'USDT', address:'0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'},
      {chain:'solana',   asset:'USDC', address:'B1N61cuL35fhskWz5dw8XqDyP6LWi3ZWmq8CNA9L3FVn'},
      {chain:'solana',   asset:'USDT', address:'B1N61cuL35fhskWz5dw8XqDyP6LWi3ZWmq8CNA9L3FVn'},
    ],
  },
  extensions: {
    hive_pricing: {
      currency:'USDC', network:'base', model:'per_call',
      first_call_free:true, loyalty_threshold:6,
      loyalty_message:'Every 6th paid call is free',
      treasury:'0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      treasury_codename:'Monroe (W1)',
    },
  },
  bogo: {
    first_call_free:true, loyalty_threshold:6,
    pitch:"Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
    claim_with:'x-hive-did header',
  },
}));


// HIVE_META_BLOCK_v1 — comprehensive meta tags + JSON-LD + crawler discovery
app.get('/', (req, res) => {
  // HIVE_AGENT_INJECT_LD_v1 — inject OAC JSON-LD into the meta-tags landing
  const __landing = renderLanding(SERVICE_CFG);
  const __oacLd = JSON.stringify(buildOacJsonLd(HIVE_AGENT_CFG)).replace(/</g, '\\u003c');
  const __ldTag = '\n<script type="application/ld+json">' + __oacLd + '</script>\n';
  const __out = __landing.replace('</head>', __ldTag + '</head>');
  res.type('text/html; charset=utf-8').send(__out);
});
app.get('/og.svg', (req, res) => {
  res.type('image/svg+xml').send(renderOgImage(SERVICE_CFG));
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(renderRobots(SERVICE_CFG));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(renderSitemap(SERVICE_CFG));
});
app.get('/.well-known/security.txt', (req, res) => {
  res.type('text/plain').send(renderSecurity());
});
app.get('/seo.json', (req, res) => res.json(seoJson(SERVICE_CFG)));
// ─── Schema discoverability (auto-injected) ──────────────────────────────
app.get('/.well-known/agent-card.json', (req, res) => res.json({
  name: 'hive-mcp-vault',
  description: "Hive Civilization vault MCP. Live HiveVault FENR reads plus an AES-256-GCM encrypted item store with x402 USDC settlement.",
  url: 'https://mcp-vault.thehiveryiq.com',
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  version: SERVICE_VERSION,
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  authentication: {
    schemes: ['x402'],
    credentials: { type:'x402', asset:'USDC', network:'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  extensions: {
    hive_pricing: {
      currency: 'USDC', network: 'base', model: 'per_call',
      first_call_free: true, loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
    claim_with: 'x-hive-did header'
  }
}));
app.get('/.well-known/ap2.json', (req, res) => res.json({
  ap2_version: '1',
  agent: {
    name: 'hive-mcp-vault',
    did: 'did:web:mcp-vault.thehiveryiq.com',
    description: "Hive Civilization vault MCP: live HiveVault FENR reads plus an AES-256-GCM encrypted item store with x402 USDC settlement."
  },
  endpoints: {
    mcp: 'https://mcp-vault.thehiveryiq.com/mcp',
    agent_card: 'https://mcp-vault.thehiveryiq.com/.well-known/agent-card.json'
  },
  payments: {
    schemes: ['x402'],
    primary: { scheme:'x402', network:'base', asset:'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house.",
    claim_with: 'x-hive-did header'
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' }
}));


// Unknown-route handling lives at the bottom of this file (honest 404).

// HIVE_AGENT_ROUTES_v1 — A2A AgentCard + OAC JSON-LD
app.get('/.well-known/agent.json', (req, res) => {
  res.json(buildAgentCard(HIVE_AGENT_CFG));
});
app.get('/agent.json', (req, res) => {
  res.json(buildAgentCard(HIVE_AGENT_CFG));
});
app.get('/.well-known/oac.json', (req, res) => {
  res.json(buildOacJsonLd(HIVE_AGENT_CFG));
});
app.get('/agent.html', (req, res) => {
  res.type('text/html; charset=utf-8').send(renderRootHtml(HIVE_AGENT_CFG));
});


// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY SURFACE — /llms.txt, /favicon.ico, and the honest 404 catch-all.
// Unknown paths return a real 404, not a 200. See the catch-all below.
// ═══════════════════════════════════════════════════════════════════════════════

const _DOORS_HOST = process.env.RENDER_EXTERNAL_URL || 'https://mcp-vault.thehiveryiq.com';
const _DOORS_ONBOARD = 'https://thehiveryiq.com/onboard.html';

// ── /llms.txt ─────────────────────────────────────────────────────────────────
// Tool names and endpoints below must match MCP_TOOLS and the routes actually
// registered in this file. An earlier version of this document described
// vault_deposit, vault_withdraw, vault_balance, vault_rebalance, and
// cashback_claim, none of which exist as tools or routes anywhere in this
// service. That mismatch has been corrected below.
app.get('/llms.txt', (req, res) => {
  const toolLines = MCP_TOOLS.map(t => `  ${t.name}`).join('\n');
  res.type('text/plain; charset=utf-8').send(`# Hive MCP Vault
> MCP access to live HiveVault FENR reads plus an AES-256-GCM encrypted item store.

## What this is
Hive MCP Vault is part of the Hive Civilization federation. It exposes confirmed
read routes from the live HiveVault FENR backend and a local encrypted item store.
If the backend is unreachable, tool calls return an explicit upstream error.

## Auth model
- Free: GET /health, /llms.txt, /robots.txt, /sitemap.xml, /.well-known/*, and all listed MCP read tools
- Paid (x402 USDC on Base): POST /v1/vault/store
- BOGO: first call free (X-Hive-DID header), 6th paid call on the house
- Settlement: USDC on Base to treasury address
- Hive does NOT custody funds

## Key endpoints
- GET  /health                          liveness check plus real upstream reachability (free)
- POST /mcp                             MCP JSON-RPC (vault tools)
- GET  /.well-known/mcp.json            MCP discovery manifest (free)
- GET  /.well-known/agent-card.json     A2A agent card (free)
- POST /v1/vault/store                  pay-per-store encrypted key/value vault (x402)
MCP tools (see /mcp tools/list for full schemas):
${toolLines}

## Hive Civilization context
Treasury: 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E (Base USDC/USDT)
x402 floor: 402 envelope returns asking_usd and accept_min_usd. Submit at least that value.
BOGO: first DID free, 6th paid call on the house (x-hive-did header to claim)
Contact / onboard: https://thehiveryiq.com/onboard.html

## License + brand
License: MIT
Brand color: gold #C08D23
`);
});

// ── /favicon.ico — 1x1 Hive gold pixel ───────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  res.status(200).set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).end(png);
});

// ── Catch-all — unknown routes fail honestly with a real 404 ────────────────
// This previously returned HTTP 200 for every unknown path under a
// "slippery-sticky doors" doctrine ("unknown path, but we kept the door
// open"). Returning 200 for a path that does not exist is dishonest: it
// tells callers, monitoring, and other agents that the request succeeded
// when it did not. Unknown routes now return 404 with links to the real,
// documented surface.
app.use((req, res, _next) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  res.status(404).json({
    ok: false,
    error: 'not_found',
    message: `No route for ${req.method} ${req.path}.`,
    try: ['/llms.txt', '/.well-known/mcp.json', '/health', '/', '/.well-known/agent.json'],
    onboard: _DOORS_ONBOARD,
    service: 'Hive MCP Vault',
    docs: `${host}/llms.txt`,
  });
});

// Only bind a port when this file is run directly (node server.js), not when
// it is imported as a module (for example by the test suite).
const _isMain = process.argv[1] && (process.argv[1].endsWith('server.js'));
if (_isMain) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[hivevault-mcp] Running on port ${PORT}`);
    console.log(`[hivevault-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`[hivevault-mcp] Proxying to: ${BASE_URL}`);
  });
}

export default app;
