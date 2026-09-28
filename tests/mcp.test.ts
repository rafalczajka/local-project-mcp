import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
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
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/mcp`;
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
      'git_log'
    ].sort()
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
    ['git_log', { limit: 1 }]
  ] as const;
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
    const content = result.structuredContent;
    assert.ok(content && typeof content === 'object' && 'ok' in content);
    assert.equal(content.ok, true);
  }
  for (const args of [
    { path: '../secret' },
    { path: '.env' },
    { path: 'src/auth.ts', startLine: -1 },
    { path: 'src/auth.ts', shell: 'whoami' }
  ]) {
    const result = await client.callTool({
      name: 'read_file',
      arguments: args
    });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(config.root));
  }
  assert.equal(
    (await client.callTool({ name: 'shell', arguments: { command: 'whoami' } })).isError,
    true
  );
});

test('HTTP rejects malicious Host/Origin, invalid bodies and methods', async (t) => {
  const { config } = await fixture(t);
  const url = await listen(t, config);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    request(url, { headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    })
      .on('error', reject)
      .end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
      })
    ).status,
    400
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[]'
      })
    ).status,
    400
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'a'.repeat(40000) })
      })
    ).status,
    413
  );
});

test('optional bearer auth enforced on every request and explicit browser origin allowlist', async (t) => {
  const { config } = await fixture(t);
  config.token = 'test-only-token-'.repeat(4);
  config.allowedOrigins = ['http://localhost:6274'];
  const url = await listen(t, config);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:6274' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://localhost:6274');
  const client = new Client({ name: 'auth-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
    })
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
  await client.connect(new StreamableHTTPClientTransport(new URL(await listen(t, config))));
  const result = await client.callTool({
    name: 'read_file',
    arguments: { path: 'large' }
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: {
      code: 'OUTPUT_LIMIT',
      message: 'Serialized result exceeds the output limit; narrow the request.'
    }
  });
});

test('HTTP guards preserve rejection order and headers before MCP handling', async (t) => {
  const { config } = await fixture(t);
  config.token = 'test-only-token-'.repeat(4);
  config.allowedOrigins = ['http://localhost:6274'];
  const url = await listen(t, config);
  const cases: {
    suffix: string;
    method: string;
    headers: Record<string, string>;
    status: number;
    error: string;
  }[] = [
    {
      suffix: '/missing',
      method: 'GET',
      headers: { Origin: 'https://attacker.example' },
      status: 403,
      error: 'Origin is not allowed'
    },
    {
      suffix: '/missing',
      method: 'GET',
      headers: {},
      status: 404,
      error: 'Not found'
    },
    {
      suffix: '',
      method: 'GET',
      headers: {},
      status: 401,
      error: 'Bearer authentication required'
    },
    {
      suffix: '',
      method: 'GET',
      headers: { Authorization: `Bearer ${config.token}` },
      status: 405,
      error: 'This stateless endpoint accepts POST'
    },
    {
      suffix: '',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Origin: 'http://localhost:6274'
      },
      status: 415,
      error: 'Content-Type must be application/json'
    }
  ];
  for (const entry of cases) {
    const response = await fetch(url + entry.suffix, {
      method: entry.method,
      headers: entry.headers
    });
    assert.equal(response.status, entry.status);
    assert.deepEqual(await response.json(), { error: entry.error });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    if (entry.status === 405) assert.equal(response.headers.get('Allow'), 'POST, OPTIONS');
    if (entry.status === 415)
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:6274');
  }
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:6274' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(
    preflight.headers.get('Access-Control-Allow-Headers'),
    'Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id'
  );
  assert.equal(preflight.headers.get('Access-Control-Expose-Headers'), 'MCP-Session-Id');
  assert.equal(preflight.headers.get('Vary'), 'Origin');
});
