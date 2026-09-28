import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultIgnores, defaultLimits, loadConfig } from '../src/config.js';
import { fixture } from './helpers.js';

test('every configured limit keeps its integer bounds and merges with defaults', async (t) => {
  const { root, put } = await fixture(t);
  const args = ['--root', root, '--config', path.join(root, 'settings.json')];
  for (const key of Object.keys(defaultLimits)) {
    const minimum = key === 'outputBytes' ? 1024 : 1;
    for (const value of [minimum, 1024 * 1024 * 1024]) {
      await put('settings.json', JSON.stringify({ limits: { [key]: value } }));
      assert.deepEqual((await loadConfig(args, {})).limits, {
        ...defaultLimits,
        [key]: value
      });
    }
    for (const value of [minimum - 1, minimum + 0.5, 1024 * 1024 * 1024 + 1]) {
      await put('settings.json', JSON.stringify({ limits: { [key]: value } }));
      await assert.rejects(loadConfig(args, {}), { name: 'ZodError' });
    }
  }
});

test('CLI overrides environment values and omitted settings retain defaults', async (t) => {
  const { root } = await fixture(t);
  const config = await loadConfig(['--root', root, '--host', 'localhost', '--port', '4321'], {
    PROJECT_ROOT: path.join(root, 'missing'),
    HOST: '0.0.0.0',
    PORT: 'invalid'
  });
  assert.equal(config.root, root);
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 4321);
  assert.deepEqual(config.ignore, defaultIgnores);
  assert.deepEqual(config.limits, defaultLimits);
  assert.deepEqual(config.sensitive, []);
  assert.equal(config.respectGitignore, true);
  const fromEnv = await loadConfig([], {
    PROJECT_ROOT: root,
    HOST: '::1',
    PORT: '65535'
  });
  assert.equal(fromEnv.host, '::1');
  assert.equal(fromEnv.port, 65535);
});

test('settings replace ignore lists and merge partial limits', async (t) => {
  const { root, put } = await fixture(t);
  await put(
    'settings.json',
    JSON.stringify({
      ignore: [],
      sensitive: ['private/**'],
      respectGitignore: false,
      allowedHosts: ['example.test'],
      allowedOrigins: ['https://example.test'],
      limits: { readBytes: 123, outputBytes: 1024 }
    })
  );
  const config = await loadConfig(
    ['--root', root, '--config', path.join(root, 'settings.json')],
    {}
  );
  assert.deepEqual(config.ignore, []);
  assert.deepEqual(config.sensitive, ['private/**']);
  assert.equal(config.respectGitignore, false);
  assert.deepEqual(config.allowedHosts, ['example.test']);
  assert.deepEqual(config.allowedOrigins, ['https://example.test']);
  assert.deepEqual(config.limits, {
    ...defaultLimits,
    readBytes: 123,
    outputBytes: 1024
  });
});

test('settings reject unknown keys and invalid limits before binding validation', async (t) => {
  const { root, put } = await fixture(t);
  for (const settings of [
    { unknown: true },
    { limits: { unknown: 1 } },
    { limits: { readBytes: 0 } },
    { limits: { readBytes: 1.5 } },
    { limits: { outputBytes: 1023 } },
    { limits: { scanBytes: 2 ** 30 + 1 } }
  ]) {
    await put('settings.json', JSON.stringify(settings));
    await assert.rejects(
      loadConfig(
        ['--root', root, '--config', path.join(root, 'settings.json'), '--host', '0.0.0.0'],
        {}
      ),
      { name: 'ZodError' }
    );
  }
});

test('root and port validation precede bearer checks, which protect non-loopback binding', async (t) => {
  const { root, put } = await fixture(t);
  await put('file.txt', 'content');
  await assert.rejects(loadConfig(['--root', path.join(root, 'file.txt')], {}), {
    message: 'PROJECT_ROOT must be a directory.'
  });
  await assert.rejects(loadConfig(['--root', root, '--port', '0'], { MCP_BEARER_TOKEN: 'short' }), {
    name: 'ZodError'
  });
  await assert.rejects(loadConfig(['--root', root], { MCP_BEARER_TOKEN: 'short' }), {
    message: 'MCP_BEARER_TOKEN must contain at least 32 characters.'
  });
  await assert.rejects(
    loadConfig(['--root', root, '--host', '0.0.0.0'], { MCP_BEARER_TOKEN: '' }),
    {
      message: 'Non-loopback binding requires MCP_BEARER_TOKEN.'
    }
  );
  const token = 'test-only-token-'.repeat(3);
  const config = await loadConfig(['--root', root, '--host', '0.0.0.0'], {
    MCP_BEARER_TOKEN: token
  });
  assert.equal(config.token, token);
});
