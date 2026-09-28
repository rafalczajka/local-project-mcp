import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

function runServer(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('../src/server.ts', import.meta.url)),
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PROJECT_ROOT: '',
        HOST: '127.0.0.1',
        PORT: '3000',
        MCP_BEARER_TOKEN: '',
      },
    },
  );
}

test('startup errors exit with a sanitized message on stderr', () => {
  const result = runServer([]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Startup failed. Check --root / PROJECT_ROOT, --config, HOST, PORT and MCP_BEARER_TOKEN.',
  );
});

test('an occupied port reports a sanitized listener error and exits', async (t) => {
  const { root } = await fixture(t);
  const listener = createServer();
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const result = runServer(['--root', root, '--port', String(address.port)]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr.trim(),
    'Unable to start listener. Check HOST, PORT and permissions.',
  );
});
