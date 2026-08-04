// Gap-filling test suite for hive-mcp-vault's tools/call upstream path.
//
// test/server.test.js already covers the unreachable-upstream case using a
// genuinely dead VAULT_BACKEND_URL, but it never exercises a live-shaped
// mocked upstream, so it cannot prove the positive path works or that a
// 2xx response with a non-JSON or empty body is rejected rather than
// fabricated into a success. This file stubs the global fetch used by
// fetchUpstream (inside the tools/call handler in server.js) so no real
// network call to hive-vault.onrender.com happens from this suite.
//
// Uses Node's built in test runner and assert module (no new dependency).
// Run with: npm test (invokes `node --test test/`)

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BOGO_DB_PATH = process.env.BOGO_DB_PATH || `/tmp/test_bogo_vault_upstream_${Date.now()}.db`;
// This value is intentionally unreachable so any accidental un-stubbed call
// fails loudly instead of silently reaching a real backend; every test in
// this file stubs fetch before making a request that would use it.
process.env.VAULT_BACKEND_URL = process.env.VAULT_BACKEND_URL || 'https://hivevault-backend-does-not-exist.invalid';

let app;
let server;
let baseUrl;
const originalFetch = globalThis.fetch;

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
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubUpstream(handler) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    return handler(String(url), opts);
  };
}

async function jrpc(method, params) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

const VAULT_TOOLS = ['vault.balance', 'vault.stats', 'vault.identity', 'vault.quantum_pubkey'];

// ─── positive path ──────────────────────────────────────────────────────────

for (const name of VAULT_TOOLS) {
  test(`${name}: a live-shaped mocked 2xx JSON upstream produces a real success result`, async () => {
    const fakePayload = { marker: 'real-upstream-payload', tool: name };
    stubUpstream(async () => new Response(JSON.stringify(fakePayload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { body } = await jrpc('tools/call', { name, arguments: {} });
    assert.ok(!body.error, `${name} unexpectedly errored on a valid mocked 2xx response: ${JSON.stringify(body.error)}`);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.upstream_ok, true);
    assert.equal(payload.marker, 'real-upstream-payload');
  });
}

// ─── DEFECT REGRESSION: non-JSON 2xx body must not be reported as upstream_ok:true ───

for (const name of VAULT_TOOLS) {
  test(`DEFECT REGRESSION: ${name} does not report upstream_ok:true for a mocked 2xx with a non-JSON body`, async () => {
    // Before the fix, fetchUpstream fell back to body = {raw: text} on a
    // JSON.parse failure and then unconditionally spread that into the
    // upstream_ok:true branch whenever resp.ok was true, so a 200 response
    // carrying an HTML error page (for example from a misconfigured proxy
    // in front of the real backend) was reported to the caller as a
    // successful vault read containing a "raw" field instead of real data.
    stubUpstream(async () => new Response('<html>upstream misconfigured</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const { body } = await jrpc('tools/call', { name, arguments: {} });
    assert.ok(body.error, `${name} must report a JSON-RPC error for a non-JSON 2xx body, got ${JSON.stringify(body)}`);
    assert.ok(/upstream/i.test(body.error.message));
    assert.equal(body.error.data?.upstream?.upstream_ok, false);
    assert.equal(body.error.data?.upstream?.error, 'non_json_body');
  });
}

// ─── DEFECT REGRESSION: empty 2xx body must not be reported as upstream_ok:true ───

for (const name of VAULT_TOOLS) {
  test(`DEFECT REGRESSION: ${name} does not report upstream_ok:true for a mocked 2xx with an empty body`, async () => {
    // Before the fix, an empty body parsed to {} via the `text ? ... : {}`
    // fallback and was then spread into the upstream_ok:true branch, so a
    // 2xx response with literally nothing in it was reported as a
    // successful (if contentless) vault read rather than an upstream error.
    stubUpstream(async () => new Response('', { status: 200 }));
    const { body } = await jrpc('tools/call', { name, arguments: {} });
    assert.ok(body.error, `${name} must report a JSON-RPC error for an empty 2xx body, got ${JSON.stringify(body)}`);
    assert.equal(body.error.data?.upstream?.upstream_ok, false);
    assert.equal(body.error.data?.upstream?.error, 'empty_body');
  });
}

// ─── non-2xx with a well-formed JSON error body must still fail closed ───

for (const name of VAULT_TOOLS) {
  test(`${name}: a mocked non-2xx JSON error body still fails closed`, async () => {
    stubUpstream(async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const { body } = await jrpc('tools/call', { name, arguments: {} });
    assert.ok(body.error);
    assert.equal(body.error.data?.upstream?.upstream_status, 429);
    assert.equal(body.error.data?.upstream?.upstream_ok, false);
  });
}
