import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy } from '../src/security/policy.js';
import { Paths } from '../src/security/paths.js';
import { fixture } from './helpers.js';

test('sensitive rules match components and ancestor paths before project exclusions', async (t) => {
  const { root, config } = await fixture(t);
  config.ignore = ['private/**'];
  config.sensitive = ['private/keys', '!literal'];
  const policy = new Policy(config, new Paths(root));
  for (const input of [
    'PRIVATE/KEYS/file.txt',
    'src/.ENV.local/file',
    '!literal',
  ]) {
    await assert.rejects(policy.resolve(input, true), {
      code: 'SENSITIVE_PATH',
    });
  }
  await policy.assert('ordinary.txt');
  await policy.assert('.');
  await assert.rejects(policy.assert('private/ordinary.txt'), {
    code: 'IGNORED_PATH',
    message: 'Path is excluded by project policy.',
  });
});

test('nested negations override file rules but cannot resurrect excluded parents', async (t) => {
  const { root, config, put } = await fixture(t);
  await put('.gitignore', '*.log\nblocked/\n');
  await put('src/.gitignore', '!keep.log\n');
  await put('blocked/.gitignore', '!keep.log\n');
  const policy = new Policy(config, new Paths(root));
  await policy.assert('src/keep.log');
  for (const input of ['src/drop.log', 'blocked/keep.log']) {
    await assert.rejects(policy.assert(input), {
      code: 'IGNORED_PATH',
      message: 'Path is excluded by .gitignore.',
    });
  }
});

test('directory rules respect the directory flag and gitignore can be disabled', async (t) => {
  const { root, config, put } = await fixture(t);
  await put('.gitignore', 'cache/\n');
  const policy = new Policy(config, new Paths(root));
  await policy.assert('cache');
  await assert.rejects(policy.assert('cache', true), { code: 'IGNORED_PATH' });
  await assert.rejects(policy.assert('cache/file'), { code: 'IGNORED_PATH' });
  config.respectGitignore = false;
  await policy.assert('cache/file');
  await assert.rejects(policy.assert('.env'), { code: 'SENSITIVE_PATH' });
});

test('gitignore caches missing rules and propagates read failures', async (t) => {
  const { root, config, put } = await fixture(t);
  const policy = new Policy(config, new Paths(root));
  await policy.assert('file.txt');
  await put('.gitignore', 'file.txt\n');
  await policy.assert('file.txt');
  await assert.rejects(new Policy(config, new Paths(root)).assert('file.txt'), {
    code: 'IGNORED_PATH',
  });
  await put('.gitignore', 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(new Policy(config, new Paths(root)).assert('file.txt'), {
    code: 'FILE_TOO_LARGE',
  });
});
