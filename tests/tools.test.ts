import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/tools.js';
import type { Config } from '../src/config.js';
import { fixture } from './helpers.js';

async function connect(t: TestContext, config: Config, signal?: AbortSignal) {
  const server = createMcpServer(config, signal);
  const client = new Client({ name: 'tools-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('tool responses keep text and structured results identical for success and errors', async (t) => {
  const { config, put } = await fixture(t);
  await put('file.txt', 'hello');
  const client = await connect(t, config);
  for (const [path, code] of [
    ['file.txt', undefined],
    ['missing', 'NOT_FOUND'],
    ['.env', 'SENSITIVE_PATH'],
  ] as const) {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path },
    });
    assert.equal(result.isError, code !== undefined);
    assert.deepEqual(result.content, [
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    if (code)
      assert.deepEqual(result.structuredContent, {
        ok: false,
        error: {
          code,
          message:
            code === 'NOT_FOUND'
              ? 'The project path does not exist.'
              : 'Sensitive paths are not exposed.',
        },
      });
  }
  const batch = await client.callTool({
    name: 'read_files',
    arguments: { files: [{ path: 'file.txt' }, { path: '.env' }] },
  });
  assert.equal(batch.isError, false);
  assert.deepEqual(batch.content, [
    { type: 'text', text: JSON.stringify(batch.structuredContent) },
  ]);
});

test('output limit includes both representations and accepts the exact byte boundary', async (t) => {
  const { config, put } = await fixture(t);
  await put('file.txt', 'ą"\\\n');
  const client = await connect(t, config);
  const request = { name: 'read_file', arguments: { path: 'file.txt' } };
  const result = await client.callTool(request);
  const response = {
    isError: result.isError,
    structuredContent: result.structuredContent,
    content: result.content,
  };
  config.limits.outputBytes = Buffer.byteLength(JSON.stringify(response)) + 128;
  assert.deepEqual(await client.callTool(request), result);
  config.limits.outputBytes--;
  const limited = await client.callTool(request);
  assert.equal(limited.isError, true);
  assert.deepEqual(limited.structuredContent, {
    ok: false,
    error: {
      code: 'OUTPUT_LIMIT',
      message:
        'Serialized result exceeds the output limit; narrow the request.',
    },
  });
  assert.deepEqual(limited.content, [
    { type: 'text', text: JSON.stringify(limited.structuredContent) },
  ]);
});

test('an aborted operation returns a structured timeout error', async (t) => {
  const { config, put } = await fixture(t);
  await put('file.txt', 'hello');
  const controller = new AbortController();
  const client = await connect(t, config, controller.signal);
  controller.abort();
  const result = await client.callTool({
    name: 'read_file',
    arguments: { path: 'file.txt' },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: {
      code: 'TIMEOUT',
      message: 'Operation deadline reached; narrow the request.',
    },
  });
});
