import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { FileService } from '../src/services/filesystem.js';
import { GitService, validateGitConfig } from '../src/services/git.js';
import { fixture } from './helpers.js';

test('Git status, working/staged diffs, log, deletions and sensitive filtering are read-only', async (t) => {
  const { config, put, root, git, initGit } = await fixture(t);
  initGit();
  await put('source.ts', 'export const value = 1;\n');
  await put('deleted.ts', 'delete me\n');
  await put('.env', 'SECRET=old\n');
  git('add', '.');
  git('commit', '-m', 'Initial source');
  await put('source.ts', 'export const value = 2;\n');
  await put('.env', 'SECRET=do-not-expose\n');
  git('rm', 'deleted.ts');
  const before = await readFile(path.join(root, '.git/index'));
  const service = () => new GitService(new FileService(config));
  const status = await service().status();
  assert.ok(status.entries.some((e) => e.path === 'source.ts'));
  assert.ok(!status.entries.some((e) => e.path === '.env'));
  const diff = await service().diff({});
  assert.match(diff.text, /value = 2/);
  assert.ok(!diff.text.includes('SECRET'));
  assert.equal(diff.omitted, 1);
  assert.match((await service().diff({ staged: true, path: 'deleted.ts' })).text, /delete me/);
  const log = await service().log({ limit: 1 });
  assert.equal(log.commits.length, 1);
  assert.equal(log.commits[0]?.subject, 'Initial source');
  assert.deepEqual(await readFile(path.join(root, '.git/index')), before);
  await assert.rejects(service().diff({ path: '.env' }), {
    code: 'SENSITIVE_PATH'
  });
  await assert.rejects(service().diff({ path: '../outside' }), {
    code: 'INVALID_PATH'
  });
});

test('Git diff does not follow rename from a sensitive file', async (t) => {
  const { config, put, git, initGit } = await fixture(t);
  initGit();
  await put('.env', 'SECRET\n');
  await put('source', 'safe\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  git('mv', '.env', 'renamed.txt');
  await put('renamed.txt', 'safe replacement\n');
  git('add', 'renamed.txt');
  const result = await new GitService(new FileService(config)).diff({
    staged: true
  });
  assert.ok(!result.text.includes('SECRET'));
  assert.match(result.text, /safe replacement/);
});

test('unsupported Git configs are rejected before execution', async (t) => {
  const { config, put, initGit } = await fixture(t);
  initGit();
  for (const source of [
    '[include]\npath = /outside\n',
    '[core]\nfsmonitor = malicious\n',
    '[filter "evil"]\nclean = malicious\n',
    '[core]\nworktree = /outside\n',
    '[remote "origin"]\npromisor = true\n'
  ]) {
    assert.throws(() => validateGitConfig(source), {
      code: 'UNSAFE_REPOSITORY'
    });
  }
  await put('.git/config', '[include]\npath = /outside\n');
  await assert.rejects(new GitService(new FileService(config)).status(), {
    code: 'UNSAFE_REPOSITORY'
  });
});

test('outside Git metadata, alternate object stores and non-repositories fail closed', async (t) => {
  const { config, put, initGit, root, temp } = await fixture(t);
  await assert.rejects(new GitService(new FileService(config)).status(), {
    code: 'NOT_GIT_REPOSITORY'
  });
  initGit();
  await mkdir(path.join(temp, 'outside'));
  await symlink(
    path.join(temp, 'outside'),
    path.join(root, '.git/escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(new GitService(new FileService(config)).status(), {
    code: 'UNSAFE_REPOSITORY'
  });
  await unlink(path.join(root, '.git/escape'));
  await put('.git/objects/info/alternates', '/outside');
  await assert.rejects(new GitService(new FileService(config)).diff({}), {
    code: 'UNSAFE_REPOSITORY'
  });
});

test('untracked status uses contained discovery and ignores external nested Git pointers', async (t) => {
  const { config, put, initGit, temp } = await fixture(t);
  initGit();
  await put('nested/.git', `gitdir: ${path.join(temp, 'outside')}\n`);
  await put('nested/source.ts', 'safe');
  await put('.env', 'SECRET');
  const result = await new GitService(new FileService(config)).status();
  assert.deepEqual(result.entries, [{ path: 'nested/source.ts', status: '??' }]);
  assert.equal(result.truncated, false);
});

test('Git diff output cap is explicit', async (t) => {
  const { config, put, git, initGit } = await fixture(t);
  initGit();
  await put('source', 'old\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  await put('source', 'new line\n'.repeat(1000));
  config.limits.gitBytes = 512;
  const result = await new GitService(new FileService(config)).diff({});
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 512);
});

test('truncated index does not misclassify tracked files as untracked', async (t) => {
  const { config, put, git, initGit } = await fixture(t);
  initGit();
  await put('tracked.ts', 'tracked\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  await put('untracked.ts', 'untracked\n');
  config.limits.gitBytes = 8;
  const result = await new GitService(new FileService(config)).status();
  assert.deepEqual(result.entries, []);
  assert.equal(result.truncated, true);
});

test('Git status skips submodule contents while retaining ordinary untracked files', async (t) => {
  const { config, put, git, initGit } = await fixture(t);
  initGit();
  await put('tracked.ts', 'tracked\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  const commit = git('rev-parse', 'HEAD').trim();
  git('update-index', '--add', '--cacheinfo', `160000,${commit},module`);
  await put('module/inside.ts', 'submodule content\n');
  await put('untracked.ts', 'ordinary content\n');
  const result = await new GitService(new FileService(config)).status();
  assert.ok(result.entries.some((entry) => entry.path === 'untracked.ts' && entry.status === '??'));
  assert.ok(!result.entries.some((entry) => entry.path.startsWith('module/')));
});

test('Git paths remain literal and logs discard incomplete commit records', async (t) => {
  const { config, put, git, initGit } = await fixture(t);
  initGit();
  await put('[source].ts', 'before\n');
  await put('s.ts', 'other\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  await put('[source].ts', 'after\n');
  await put('s.ts', 'unrelated change\n');
  const result = await new GitService(new FileService(config)).diff({
    path: '[source].ts'
  });
  assert.match(result.text, /\+after/);
  assert.ok(!result.text.includes('unrelated change'));
  config.limits.gitBytes = 45;
  const history = await new GitService(new FileService(config)).log({});
  assert.deepEqual(history.commits, []);
  assert.equal(history.truncated, true);
});

test('Git config parser preserves supported syntax and rejects continuations', () => {
  assert.doesNotThrow(() =>
    validateGitConfig(
      '# comment\n[core]\n bare = false\n[user]\nname = Test\n[remote "origin"]\nurl = https://example.invalid/repo\n'
    )
  );
  assert.throws(() => validateGitConfig('[core]\nfilemode = true\\\n'), {
    code: 'UNSAFE_REPOSITORY'
  });
});
