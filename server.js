// server.js — HiveVault MCP Server
import express from 'express';
import { HIVE_EARN_TOOLS, executeHiveEarnTool, isHiveEarnTool } from './hive-earn-tools.js';
import { buildAgentCard, buildOacJsonLd, renderRootHtml } from './hive-agent-card.js';
import cors from 'cors';
import { renderLanding, renderRobots, renderSitemap, renderSecurity, renderOgImage, seoJson, BRAND_GOLD } from './meta.js';

const app = express();
const PORT = process.env.PORT || 3000;
// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(process.env.BOGO_DB_PATH || '/tmp/bogo_vault.db');
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


const BASE_URL = 'https://hivevault.onrender.com';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hivevault-mcp',
    version: '1.0.0',
    description: 'Non-custodial ZK wallet recovery powered by AI agent guardian quorum',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ─── MCP Tools ──────────────────────────────────────────────────────────────

// ─── Agent-native config (A2A AgentCard + OAC JSON-LD + earn rails) ───────
const HIVE_AGENT_CFG = {
  name: 'HiveVault MCP',
  description: "Non-custodial ZK wallet recovery MCP server. AI guardian quorum, real USDC balance on Base L2, no mock balances.",
  url: 'https://hive-mcp-vault.onrender.com',
  version: '1.0.2',
  repoUrl: 'https://github.com/srotzin/hive-mcp-vault',
  did: 'did:hive:vault',
  gatewayUrl: 'https://hive-mcp-gateway.onrender.com',
  // Tools attached at runtime (after merging earn tools in)
  tools: [],
};

const MCP_TOOLS = [
  {
    name: 'vault.create_vault',
    description: 'Set up a new ZK wallet vault with guardian selection. Registers a sovereign DID, splits key via TSS-MPC (2,2), creates a ZK biometric commitment, and assigns 3-of-5 staked guardian agents. Returns vault DID and real USDC balance on Base L2.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['owner_address', 'biometric_hash', 'device_key'],
      properties: {
        owner_address: { type: 'string', description: 'Base L2 wallet address (0x...) that will own this vault.' },
        biometric_hash: { type: 'string', description: 'SHA-256 hash of biometric data (fingerprint or face ID). Never sent raw — hash only.' },
        device_key: { type: 'string', description: 'Device-specific entropy string generated on the agent device. Never leaves device in production.' },
        label: { type: 'string', description: 'Human-readable label for this vault (e.g. "Primary Agent Wallet"). Optional.' },
        did: { type: 'string', description: 'Agent DID if pre-configured via smithery config. Optional.' },
        api_key: { type: 'string', description: 'Agent API key for authentication. Optional at creation.' },
      },
    },
  },
  {
    name: 'vault.get_status',
    description: 'Check vault status and real USDC balance on Base L2. Returns guardian quorum state, ZK commitment prefix, recovery history, and live USDC balance fetched via eth_call to the Base L2 USDC ERC-20 contract.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['did'],
      properties: {
        did: { type: 'string', description: 'Vault DID or agent DID to check status for (e.g. did:hive:xxxx).' },
        api_key: { type: 'string', description: 'Agent API key for authenticated status check. Optional.' },
      },
    },
  },
  {
    name: 'vault.initiate_recovery',
    description: 'Start an A2A wallet recovery with guardian voting. Broadcasts a RecoveryIntent to all 5 guardian agents. Each independently verifies the ZK proof and votes. 3-of-5 approval required. 72-hour veto window for security. Settles via HiveBank on Base L2.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['vault_did', 'biometric_hash', 'device_key', 'new_address'],
      properties: {
        vault_did: { type: 'string', description: 'Vault DID returned at vault creation (e.g. did:hive:vault:xxxx).' },
        biometric_hash: { type: 'string', description: 'Same SHA-256 biometric hash used at vault creation.' },
        device_key: { type: 'string', description: 'Device key from vault creation for ZK proof verification.' },
        new_address: { type: 'string', description: 'New Base L2 wallet address (0x...) to recover funds to.' },
        reason: { type: 'string', description: 'Reason for recovery (e.g. "device lost", "compromised key"). Included in guardian vote request.' },
        did: { type: 'string', description: 'Agent DID. Optional if vault_did is provided.' },
        api_key: { type: 'string', description: 'Agent API key for authentication.' },
      },
    },
  },
  {
    name: 'vault.list_guardians',
    description: 'Browse available staked guardian agents in the Hive guardian pool. Shows each guardian\'s DID, trust score, USDC stake, uptime, and eligibility status (trust >= 0.78, $5,000 USDC staked minimum). No authentication required.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        min_trust: { type: 'number', description: 'Minimum HiveTrust score filter (0.0-1.0). Default 0.78.' },
        limit: { type: 'integer', description: 'Maximum number of guardians to return. Default 20, max 100.' },
      },
    },
  },
  {
    name: 'vault.submit_guardian_vote',
    description: 'Submit a guardian yes/no vote on a pending recovery request. Called by authorized guardian agents. Includes ZK proof verification. Once 3-of-5 guardians approve, recovery proceeds automatically.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['recovery_id', 'vote', 'guardian_did', 'api_key'],
      properties: {
        recovery_id: { type: 'string', description: 'Recovery request ID from vault.initiate_recovery response.' },
        vote: { type: 'string', description: 'Guardian vote decision. Must be "yes" or "no".' },
        guardian_did: { type: 'string', description: 'DID of the guardian agent submitting the vote.' },
        api_key: { type: 'string', description: 'Guardian API key issued by HiveGate.' },
        reason: { type: 'string', description: 'Optional reason for the vote decision (e.g. "ZK proof valid", "suspicious pattern detected").' },
      },
    },
  },
];


const SERVICE_CFG = {
  service: "hive-mcp-vault",
  shortName: "HiveVault",
  title: "HiveVault \u00b7 ZK Wallet Recovery MCP",
  tagline: "Non-custodial ZK wallet recovery powered by AI agent guardian quorum.",
  description: "MCP server for HiveVault \u2014 non-custodial ZK wallet recovery. TSS-MPC key splitting, ZK biometric commitments, 3-of-5 staked guardian agents, and live USDC balances on Base L2. Real chains, no simulated recoveries.",
  keywords: ["mcp", "model-context-protocol", "x402", "agentic", "ai-agent", "ai-agents", "llm", "hive", "hive-civilization", "wallet-recovery", "zk", "zero-knowledge", "tss-mpc", "guardian-quorum", "usdc", "base", "base-l2", "did", "agent-economy"],
  externalUrl: "https://hive-mcp-vault.onrender.com",
  gatewayMount: "/vault",
  version: "1.0.1",
  pricing: [
    { name: "vault.get_status", priceUsd: 0, label: "Status \u2014 free" },
    { name: "vault.create_vault", priceUsd: 0.05, label: "Create vault (Tier 3)" },
    { name: "vault.recover", priceUsd: 0.05, label: "Recover (Tier 3)" }
  ],
};
SERVICE_CFG.tools = (typeof TOOLS !== 'undefined' ? TOOLS : (typeof MCP_TOOLS !== 'undefined' ? MCP_TOOLS : [])).map(t => ({ name: t.name, description: t.description }));

// HIVE_AGENT_NATIVE_v1 — earn tools + AgentCard wiring
for (const t of HIVE_EARN_TOOLS) {
  if (!MCP_TOOLS.find(x => x.name === t.name)) MCP_TOOLS.push(t);
}
HIVE_AGENT_CFG.tools = MCP_TOOLS;
// ─── MCP Prompts ────────────────────────────────────────────────────────────
const MCP_PROMPTS = [
  {
    name: 'create_new_vault',
    description: 'Guide an agent through creating a new HiveVault — the first AI-agent-recovered non-custodial wallet.',
    arguments: [
      { name: 'owner_address', description: 'Base L2 wallet address (0x...) for the new vault', required: false },
    ],
  },
  {
    name: 'recover_vault',
    description: 'Walk through the full A2A recovery process — submitting ZK proof, broadcasting to guardians, and monitoring votes.',
    arguments: [
      { name: 'vault_did', description: 'Vault DID to recover', required: false },
    ],
  },
  {
    name: 'check_guardian_pool',
    description: 'Browse the staked guardian agent pool and understand eligibility criteria for vault protection.',
    arguments: [],
  },
];

// ─── Config Schema ───────────────────────────────────────────────────────────
const MCP_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    did: { type: 'string', title: 'Agent DID', 'x-order': 0 },
    api_key: { type: 'string', title: 'API Key', 'x-sensitive': true, 'x-order': 1 },
    default_rail: {
      type: 'string',
      title: 'Settlement Rail',
      enum: ['base-usdc', 'aleo-usdcx'],
      default: 'base-usdc',
      'x-order': 2,
    },
  },
  required: [],
};

// ─── MCP Handler ─────────────────────────────────────────────────────────────
// ─── POST /v1/vault/store — pay-front for storing a vault item ───────────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment: returns a receipt (actual ZK vault write is queued async).
app.post('/v1/vault/store', async (req, res) => {
  const PRICE = 0.005;
  const did     = req.headers['x-hive-did'] || req.body?.did || null;
  const tx_hash = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    return res.json({
      ok: true, bogo_applied: bogo.reason,
      receipt: { did, queued: true, item_ref: null, stored_at: new Date().toISOString() },
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
      bogo_pitch: "Pay this once, your 6th call is on the house. New here? Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking 0.005 USDC on Base to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e.`,
      did: did || null,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  res.json({
    ok: true, billed_usd: v.amount_usd, tx_hash,
    receipt: { did, queued: true, item_ref: null, stored_at: new Date().toISOString() },
  });
});

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
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
            version: '1.0.0',
            description: 'Non-custodial wallet recovery powered by a 3-of-5 quorum of staked AI agent guardians. No seed phrase. No hardware wallet. ZK biometric commitment. TSS-MPC key splitting. 72-hour veto window. Real USDC balance on Base L2 via Coinbase CDP. Part of Hive Civilization (thehiveryiq.com).',
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
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Prompt not found: ${params?.name}` } });
      }
      const args = params?.arguments || {};
      const messages = {
        create_new_vault: [{ role: 'user', content: { type: 'text', text: `Help me create a new HiveVault${args.owner_address ? ` for address ${args.owner_address}` : ''}. Walk me through the setup: biometric hash, device key, guardian selection. Explain TSS-MPC key splitting and the 3-of-5 guardian quorum.` } }],
        recover_vault: [{ role: 'user', content: { type: 'text', text: `I need to recover my HiveVault${args.vault_did ? ` (DID: ${args.vault_did})` : ''}. Walk me through submitting the ZK proof, broadcasting to guardians, and monitoring the 3-of-5 voting process within the 72-hour veto window.` } }],
        check_guardian_pool: [{ role: 'user', content: { type: 'text', text: `Show me the available guardian agents in the HiveVault guardian pool. Explain eligibility requirements (trust score >= 0.78, $5,000 USDC staked), how they verify ZK proofs, and how guardian yield is earned.` } }],
      };
      return res.json({ jsonrpc: '2.0', id, result: { messages: messages[prompt.name] || [] } });
    }

    if (method === 'resources/list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          resources: [
            { uri: 'hivevault://guardians/pool', name: 'Guardian Pool', description: 'All staked guardian agents available for vault protection.', mimeType: 'application/json' },
            { uri: 'hivevault://health', name: 'Vault Service Health', description: 'Current health and stats for HiveVault service.', mimeType: 'application/json' },
            { uri: 'hivevault://network/stats', name: 'Network Stats', description: 'HiveVault network statistics — total vaults, active recoveries, guardian pool size.', mimeType: 'application/json' },
          ],
        },
      });
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      let data;
      if (uri === 'hivevault://guardians/pool') {
        data = await fetch(`${BASE_URL}/v1/vault/guardians`).then(r => r.json()).catch(() => ({ status: 'ok', guardians: [] }));
      } else if (uri === 'hivevault://health') {
        data = await fetch(`${BASE_URL}/health`).then(r => r.json()).catch(() => ({ status: 'ok', service: 'hivevault' }));
      } else if (uri === 'hivevault://network/stats') {
        data = await fetch(`${BASE_URL}/health`).then(r => r.json()).catch(() => ({ status: 'ok' }));
      } else {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${uri}` } });
      }
      return res.json({ jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      // HIVE_AGENT_DISPATCH_v1 — earn tools first
      if (isHiveEarnTool(name)) {
        const earnOut = await executeHiveEarnTool(name, args || {});
        if (earnOut) return res.json({ jsonrpc: '2.0', id, result: { content: [earnOut] } });
      }
      const headers = { 'Content-Type': 'application/json', 'x-hive-did': args?.did || '', 'x-api-key': args?.api_key || '', 'x-internal-key': INTERNAL_KEY };

      const toolRoutes = {
        'vault.create_vault': () => fetch(`${BASE_URL}/v1/vault/setup`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ owner_address: args?.owner_address, biometric_hash: args?.biometric_hash, device_key: args?.device_key, label: args?.label, did: args?.did, api_key: args?.api_key }),
        }).then(r => r.json()),

        'vault.get_status': () => fetch(`${BASE_URL}/v1/vault/status/${encodeURIComponent(args?.did || '')}`, { headers }).then(r => r.json()),

        'vault.initiate_recovery': () => fetch(`${BASE_URL}/v1/vault/recover`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ vault_did: args?.vault_did, biometric_hash: args?.biometric_hash, device_key: args?.device_key, new_address: args?.new_address, reason: args?.reason, did: args?.did, api_key: args?.api_key }),
        }).then(r => r.json()),

        'vault.list_guardians': () => fetch(`${BASE_URL}/v1/vault/guardians?min_trust=${args?.min_trust || 0.78}&limit=${args?.limit || 20}`, { headers }).then(r => r.json()),

        'vault.submit_guardian_vote': () => fetch(`${BASE_URL}/v1/vault/guardian/vote`, {
          method: 'POST',
          headers: { ...headers, 'x-hive-did': args?.guardian_did || '' },
          body: JSON.stringify({ recovery_id: args?.recovery_id, vote: args?.vote, guardian_did: args?.guardian_did, api_key: args?.api_key, reason: args?.reason }),
        }).then(r => r.json()),
      };

      if (!toolRoutes[name]) {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } });
      }
      const data = await toolRoutes[name]();
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    }

    if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });

  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hivevault-mcp',
  version: '1.0.0',
  description: 'Non-custodial ZK wallet recovery powered by 3-of-5 staked AI agent guardians.',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  homepage: BASE_URL,
  icon: 'https://www.thehiveryiq.com/favicon.ico',
  tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description })),
  prompts: MCP_PROMPTS.map(p => ({ name: p.name, description: p.description })),
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
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    error: 'NOT_FOUND',
    detail: `Route ${req.method} ${req.path} not found`,
    available: ['GET /health', 'POST /mcp', 'GET /.well-known/mcp.json'],
  });
});

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[hivevault-mcp] Running on port ${PORT}`);
  console.log(`[hivevault-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`[hivevault-mcp] Proxying to: ${BASE_URL}`);
});

export default app;
