// Verifies the server refuses to start in production without INTERNAL_KEY
// set, instead of silently falling back to a placeholder secret. This test
// spawns a real child process because the check calls process.exit(1),
// which cannot be safely tested in-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.js');

function runServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exited: false, code: null, stderr });
    }, 2000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, stderr });
    });
  });
}

test('refuses to start in production without INTERNAL_KEY set', async () => {
  const result = await runServer({
    NODE_ENV: 'production',
    INTERNAL_KEY: '',
    PORT: '0',
    BOGO_DB_PATH: `/tmp/test_bogo_env_${Date.now()}.db`,
  });
  assert.equal(result.exited, true, 'process should exit rather than hang or start listening');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /INTERNAL_KEY/);
});

test('refuses to start in production without BOGO_DB_PATH set', async () => {
  const result = await runServer({
    NODE_ENV: 'production',
    INTERNAL_KEY: 'a-real-secret-for-this-test-only',
    BOGO_DB_PATH: '',
    PORT: '0',
  });
  assert.equal(result.exited, true, 'process should exit rather than use ephemeral storage');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /BOGO_DB_PATH/);
});

test('starts normally in production when encryption and durable storage are configured', async () => {
  const result = await runServer({
    NODE_ENV: 'production',
    INTERNAL_KEY: 'a-real-secret-for-this-test-only',
    PORT: '0',
    BOGO_DB_PATH: `/tmp/test_bogo_env_ok_${Date.now()}.db`,
  });
  // Server should keep running (does not exit within the timeout window).
  assert.equal(result.exited, false, 'server should stay running when required production settings are present');
});
