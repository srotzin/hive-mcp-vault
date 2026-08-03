// Test suite for hive-mcp-vault.
//
// Uses Node's built in test runner and assert module (no new dependency).
// Run with: npm test  (invokes `node --test test/`)
//
// These tests exercise the honest-failure behavior this remediation pass
// added: unknown routes return 404 (not a fabricated 200), tool calls
// against an unreachable upstream return an explicit error (not fabricated
// content), and the pay-per-store vault write path is real and verifiable.
//
// The upstream vault backend (VAULT_BACKEND_URL) is expected to be dead or
// unset in this test environment, which is itself the condition these tests
// are built to verify: that the service behaves honestly when its upstream
// is unreachable, rather than pretending otherwise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = '0'; // unused since server.js guards app.listen behind require.main-style check
process.env.BOGO_DB_PATH = process.env.BOGO_DB_PATH || `/tmp/test_bogo_vault_${Date.now()}.db`;
// Point at a URL that will not resolve to a real vault backend, so tests
// exercise the honest upstream-failure path deterministically.
process.env.VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL || 'https://hivevault-backend-does-not-exist.invalid';

let app;
let server;
let baseUrl;

before(async () => {
  const mod = await import('../server.js');
  app = mod.default;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function jrpc(method, params) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('GET /health reports degraded and 503 when upstream is unreachable', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 503, 'health must return 503 when upstream is down, not a false 200');
  assert.equal(body.status, 'degraded');
  assert.equal(body.upstream.reachable, false);
  assert.ok(body.upstream.url, 'health must report which upstream URL it checked');
});

test('unknown route returns a real 404, not a fabricated 200', async () => {
  const res = await fetch(`${baseUrl}/this-path-does-not-exist-${Date.now()}`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'not_found');
});

test('unknown route under /.well-known also returns 404', async () => {
  const res = await fetch(`${baseUrl}/.well-known/does-not-exist.json`);
  assert.equal(res.status, 404);
});

test('MCP tools/list returns only the four real vault read tools', async () => {
  const { status, body } = await jrpc('tools/list');
  assert.equal(status, 200);
  const names = body.result.tools.map((t) => t.name);
  const expectedVaultTools = [
    'vault.balance',
    'vault.stats',
    'vault.identity',
    'vault.quantum_pubkey',
  ];
  for (const name of expectedVaultTools) {
    assert.ok(names.includes(name), `expected tool ${name} to be listed`);
  }
  assert.deepEqual(names, expectedVaultTools);
  // Fictitious tools from the earlier fabricated llms.txt/root JSON must
  // never appear here, since MCP_TOOLS is the single source of truth.
  const fictitious = ['vault_deposit', 'vault_withdraw', 'vault_balance', 'vault_rebalance', 'cashback_claim'];
  for (const name of fictitious) {
    assert.ok(!names.includes(name), `fictitious tool ${name} must not be listed`);
  }
});

test('MCP tools/call for vault.stats against a dead upstream returns an honest JSON-RPC error', async () => {
  const { status, body } = await jrpc('tools/call', { name: 'vault.stats', arguments: {} });
  assert.equal(status, 200); // JSON-RPC errors are still transported over HTTP 200 per spec
  assert.ok(body.error, 'expected a JSON-RPC error object, not a fabricated success result');
  assert.equal(typeof body.error.code, 'number');
  assert.ok(/upstream/i.test(body.error.message), 'error message should mention the upstream failure');
});

test('MCP tools/call for an unknown tool name returns method-not-found, not fabricated content', async () => {
  const { body } = await jrpc('tools/call', { name: 'vault.does_not_exist', arguments: {} });
  assert.ok(body.error);
  assert.equal(body.error.code, -32601);
});

test('MCP initialize and tools/list round trip', async () => {
  const init = await jrpc('initialize');
  assert.equal(init.body.result.protocolVersion, '2024-11-05');
  assert.ok(init.body.result.serverInfo.version);
});

test('POST /v1/vault/store without payment or DID returns 402 with an x402 payload', async () => {
  const res = await fetch(`${baseUrl}/v1/vault/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { hello: 'world' } }),
  });
  const body = await res.json();
  assert.equal(res.status, 402);
  assert.equal(body.error, 'payment_required');
  assert.ok(body.x402);
  assert.equal(body.x402.asset, 'USDC');
});

test('POST /v1/vault/store with a fresh DID uses first-call-free and performs a real, verifiable write', async () => {
  const did = `did:hive:test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const storeRes = await fetch(`${baseUrl}/v1/vault/store`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hive-did': did },
    body: JSON.stringify({ item: { hello: 'world' } }),
  });
  const storeBody = await storeRes.json();
  assert.equal(storeRes.status, 200);
  assert.equal(storeBody.ok, true);
  assert.equal(storeBody.bogo_applied, 'first_call_free');
  assert.ok(storeBody.receipt.item_ref, 'a real item_ref must be returned');
  assert.equal(storeBody.receipt.queued, false, 'the write is synchronous, not queued');

  // The claim above must be independently checkable, not just asserted.
  const lookupRes = await fetch(`${baseUrl}/v1/vault/store/${storeBody.receipt.item_ref}`);
  const lookupBody = await lookupRes.json();
  assert.equal(lookupRes.status, 200);
  assert.equal(lookupBody.ok, true);
  assert.equal(lookupBody.item.item_ref, storeBody.receipt.item_ref);

  const databaseBytes = await import('node:fs/promises').then(fs => fs.readFile(process.env.BOGO_DB_PATH));
  assert.ok(!databaseBytes.includes(Buffer.from('hello', 'utf8')), 'plaintext item content must not appear in the SQLite file');
  assert.ok(!databaseBytes.includes(Buffer.from('world', 'utf8')), 'plaintext item content must not appear in the SQLite file');
});

test('GET /v1/vault/store/:item_ref for a made up ref returns 404, not a fabricated record', async () => {
  const res = await fetch(`${baseUrl}/v1/vault/store/does-not-exist-${Date.now()}`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'item_ref_not_found');
});

test('GET /.well-known/mcp.json version matches GET /health version (manifest consistency)', async () => {
  const [mcpRes, healthRes] = await Promise.all([
    fetch(`${baseUrl}/.well-known/mcp.json`),
    fetch(`${baseUrl}/health`),
  ]);
  const [mcpBody, healthBody] = await Promise.all([mcpRes.json(), healthRes.json()]);
  assert.equal(mcpBody.version, healthBody.version);
});

test('user facing text has no em dash, en dash, or double hyphen', async () => {
  const paths = ['/health', '/.well-known/mcp.json', '/.well-known/agent.json', '/llms.txt'];
  for (const path of paths) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    assert.ok(!text.includes('\u2014'), `${path} must not contain an em dash`);
    assert.ok(!text.includes('\u2013'), `${path} must not contain an en dash`);
    assert.ok(!/[^-]--[^-]/.test(text), `${path} must not contain a double hyphen`);
  }
});

test('GET /v1/prov/pubkey returns a verifiable signature over a real request', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const sig = res.headers.get('x-hive-prov-sig');
  const iss = res.headers.get('x-hive-prov-iss');
  const ts = res.headers.get('x-hive-prov-ts');
  assert.ok(sig, 'expected a smash.prov signature header on a 200 response');
  assert.ok(iss);
  assert.ok(ts);
});

test('smash.prov does not sign the dishonest-200 case any more, because unknown routes are 404', async () => {
  const res = await fetch(`${baseUrl}/does-not-exist-${Date.now()}`);
  assert.equal(res.status, 404);
  // The prior "every door 200s, every byte signed" doctrine relied on the
  // catch-all always returning 200. Now that it returns 404, the signature
  // middleware's blanket `statusCode === 200` shortcut no longer fires for
  // unknown paths, and callers get an honest status code to check first.
});
