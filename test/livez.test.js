// Liveness tests.
//
// The platform liveness probe must be able to ask "is this process alive"
// without that answer depending on the upstream vault backend. A probe pointed
// at /health kills this process whenever the upstream is slow, and restarting
// this process cannot repair an upstream.
//
// These tests pin both halves of the split: /livez is process only and never
// reports upstream state, and /health still returns 503 and "degraded" when the
// upstream is unreachable so no caller is told ok while tool calls would fail.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.BOGO_DB_PATH = process.env.BOGO_DB_PATH || `/tmp/test_bogo_livez_${Date.now()}.db`;
process.env.VAULT_BACKEND_URL = 'https://hivevault-backend-does-not-exist.invalid';

let server;
let baseUrl;

before(async () => {
  const mod = await import('../server.js');
  const app = mod.default;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('/livez returns 200 even though the upstream is unreachable', async () => {
  const r = await fetch(`${baseUrl}/livez`);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.status, 'alive');
  assert.equal(b.scope, 'process_only');
  assert.equal(b.upstream_checked, false);
  assert.equal(typeof b.uptime_seconds, 'number');
});

test('/livez makes no claim about the upstream', async () => {
  const b = await (await fetch(`${baseUrl}/livez`)).json();
  assert.ok(!('upstream' in b), '/livez must not report upstream state');
  assert.ok(!('reachable' in b), '/livez must not claim reachability');
  assert.notEqual(b.status, 'ok', '/livez must not say ok, which readers read as end to end');
});

test('/health still fails closed on an unreachable upstream', async () => {
  const r = await fetch(`${baseUrl}/health`);
  assert.equal(r.status, 503);
  const b = await r.json();
  assert.equal(b.status, 'degraded');
  assert.equal(b.upstream.reachable, false);
});
