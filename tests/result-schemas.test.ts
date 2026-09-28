import test from 'node:test';
import assert from 'node:assert/strict';
import { resultSchemas } from '../src/result-schemas.js';

const file = {
  path: 'empty.txt',
  startLine: 1,
  endLine: null,
  totalLines: 0,
  text: '',
  truncated: false
};

test('batch reads accept mixed outcomes and require matching success fields', () => {
  const schema = resultSchemas.read_files;
  const data = {
    files: [
      { ...file, ok: true },
      { ok: false, error: { code: 'NOT_FOUND', message: 'Missing' } }
    ],
    truncated: false
  };
  assert.deepEqual(schema.parse(data), data);
  for (const entry of [
    { ...file, ok: false },
    { ok: true },
    { ok: false, error: { code: 'NOT_FOUND' } }
  ]) {
    assert.equal(schema.safeParse({ files: [entry], truncated: false }).success, false);
  }
});

test('summary counts remain required nonnegative integers', () => {
  for (const [name, fields] of [
    ['project_tree', { path: '.', entries: [], limits: { entries: 10, depth: 2 } }],
    ['find_files', { files: [] }],
    ['search_text', { matches: [], skipped: {} }],
    ['git_status', { entries: [] }],
    ['git_diff', { text: '', staged: false }]
  ] as const) {
    const schema = resultSchemas[name];
    assert.equal(schema.safeParse({ ...fields, truncated: false, omitted: 0 }).success, true, name);
    for (const omitted of [-1, 0.5, '0', undefined]) {
      assert.equal(schema.safeParse({ ...fields, truncated: false, omitted }).success, false, name);
    }
  }
});

test('nullable metadata and unknown-key stripping retain their existing contract', () => {
  assert.deepEqual(resultSchemas.read_file.parse({ ...file, extra: true }), file);
  const info = {
    path: '.',
    type: 'directory',
    size: 0,
    modified: '',
    binary: null,
    extension: null
  };
  assert.deepEqual(resultSchemas.file_info.parse(info), info);
  assert.equal(resultSchemas.file_info.safeParse({ ...info, type: 'link' }).success, false);
  assert.equal(resultSchemas.file_info.safeParse({ ...info, binary: undefined }).success, false);
  assert.deepEqual(
    resultSchemas.git_log.parse({
      commits: [{ hash: 'abc', author: 'A', date: '', subject: 'S', extra: true }],
      truncated: false
    }),
    {
      commits: [{ hash: 'abc', author: 'A', date: '', subject: 'S' }],
      truncated: false
    }
  );
});
