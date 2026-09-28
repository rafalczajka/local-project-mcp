import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rename, symlink } from 'node:fs/promises';
import { normalizeInput, Paths } from '../src/security/paths.js';
import { fixture } from './helpers.js';

test('path normalization preserves safe names and enforces input length before normalization', () => {
  for (const input of ['', '.', '././'])
    assert.equal(normalizeInput(input), '.');
  assert.equal(normalizeInput('./src\\nested//file.ts/'), 'src/nested/file.ts');
  assert.equal(normalizeInput('console.txt'), 'console.txt');
  assert.equal(normalizeInput('a'.repeat(1024)), 'a'.repeat(1024));
  assert.throws(() => normalizeInput('./'.repeat(513)), {
    code: 'INVALID_PATH',
    message: 'Use a relative project path.',
  });
  for (const input of ['a/../b', 'AUX.txt', 'file.', 'file ', 'a~b']) {
    assert.throws(() => normalizeInput(input), {
      code: 'INVALID_PATH',
      message: 'Traversal and ambiguous platform paths are not allowed.',
    });
  }
});

test('missing paths are optional but existing linked ancestors remain rejected', async (t) => {
  const { root } = await fixture(t);
  const paths = new Paths(root);
  await assert.rejects(paths.resolve('missing/file'), { code: 'ENOENT' });
  assert.deepEqual(await paths.resolve('missing/file', true), {
    relative: 'missing/file',
    absolute: path.join(root, 'missing/file'),
  });
  await assert.rejects(paths.resolve('missing/../file', true), {
    code: 'INVALID_PATH',
  });
  await mkdir(path.join(root, 'target'));
  await symlink(
    path.join(root, 'target'),
    path.join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(paths.resolve('alias/missing', true), {
    code: 'SYMLINK_DENIED',
  });
});

test('reads enforce byte limits and require a regular file', async (t) => {
  const { root, put } = await fixture(t);
  const paths = new Paths(root);
  await put('text.txt', 'ąb');
  await put('empty.txt', '');
  assert.deepEqual(await paths.read('text.txt', 3), Buffer.from('ąb'));
  assert.deepEqual(await paths.read('empty.txt', 0), Buffer.alloc(0));
  await assert.rejects(paths.read('text.txt', 2), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(paths.read('.', 0), { code: 'NOT_FILE' });
});

test('root replacement is rejected even when missing paths are allowed', async (t) => {
  const { root, temp } = await fixture(t);
  const paths = new Paths(root);
  const original = path.join(temp, 'original');
  await rename(root, original);
  await symlink(
    original,
    root,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(paths.resolve('.', true), { code: 'ROOT_CHANGED' });
});
