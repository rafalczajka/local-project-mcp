import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';
import { fixture } from './helpers.js';

async function listen(t: TestContext, config: Config) {
  const server = createHttpServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

test('MCP HTTP initialization, nine read-only tools, schemas and representative calls', async (t) => {
  const { config, put, initGit, git } = await fixture(t);
  await put('src/auth.ts', 'export const UserSession = true;\n');
  initGit();
  git('add', '.');
  git('commit', '-m', 'Initial');
  const url = await listen(t, config);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.match(client.getInstructions() ?? '', /Read-only/);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'project_tree',
      'read_file',
      'read_files',
      'find_files',
      'search_text',
      'file_info',
      'git_status',
      'git_diff',
      'git_log',
    ].sort(),
  );
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.ok(tool.outputSchema);
  }
  const cases = [
    ['project_tree', {}],
    ['read_file', { path: 'src/auth.ts', startLine: 1, endLine: 1 }],
    ['read_files', { files: [{ path: 'src/auth.ts' }, { path: '.env' }] }],
    ['find_files', { pattern: '**/*.ts' }],
    ['search_text', { query: 'UserSession' }],
    ['file_info', { path: 'src/auth.ts' }],
    ['git_status', {}],
    ['git_diff', {}],
    ['git_log', { limit: 1 }],
  ] as const;
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    assert.equal((result.structuredContent as { ok: boolean }).ok, true);
  }
  for (const args of [
    { path: '../secret' },
    { path: '.env' },
    { path: 'src/auth.ts', startLine: -1 },
    { path: 'src/auth.ts', shell: 'whoami' },
  ]) {
    const result = await client.callTool({
      name: 'read_file',
      arguments: args,
    });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(config.root));
  }
  assert.equal(
    (await client.callTool({ name: 'shell', arguments: { command: 'whoami' } }))
      .isError,
    true,
  );
});

test('HTTP rejects malicious Host/Origin, invalid bodies and methods', async (t) => {
  const { config } = await fixture(t);
  const url = await listen(t, config);
  const hostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      request(url, { headers: { Host: 'attacker.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    },
  );
  assert.equal(hostStatus, 403);
  assert.equal(
    (await fetch(url, { headers: { Origin: 'https://attacker.example' } }))
      .status,
    403,
  );
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'a'.repeat(40000) }),
      })
    ).status,
    413,
  );
});

test('optional bearer auth enforced on every request and explicit browser origin allowlist', async (t) => {
  const { config } = await fixture(t);
  config.token = 'test-only-token-'.repeat(4);
  config.allowedOrigins = ['http://localhost:6274'];
  const url = await listen(t, config);
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:6274' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get('Access-Control-Allow-Origin'),
    'http://localhost:6274',
  );
  const client = new Client({ name: 'auth-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 9);
});

test('serialized output cap returns a structured error, not an unbounded response', async (t) => {
  const { config, put } = await fixture(t);
  config.limits.outputBytes = 8000;
  // Quotes are escaped again inside the text representation of the JSON result.
  await put('large', '"'.repeat(1500));
  const client = new Client({ name: 'limit-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(await listen(t, config))),
  );
  const result = await client.callTool({
    name: 'read_file',
    arguments: { path: 'large' },
  });
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    'OUTPUT_LIMIT',
  );
});
