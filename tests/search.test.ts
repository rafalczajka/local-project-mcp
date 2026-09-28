import test from 'node:test';
import assert from 'node:assert/strict';
import { FileService } from '../src/services/filesystem.js';
import { searchText } from '../src/services/search.js';
import { Budget } from '../src/errors.js';
import { fixture } from './helpers.js';

test('search only reports result truncation when another matching line exists', async (t) => {
  const { config, put } = await fixture(t);
  await put('source', 'needle needle\nother\n');
  const search = () =>
    searchText(new FileService(config), {
      query: 'needle',
      path: 'source',
      maxResults: 1,
    });
  const exact = await search();
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.truncated, false);
  await put('source', 'needle needle\nother\nneedle\n');
  const limited = await search();
  assert.deepEqual(limited.matches, exact.matches);
  assert.equal(limited.truncated, true);
});

test('search excerpts retain leading context and clip UTF-8 without replacement characters', async (t) => {
  const { config, put } = await fixture(t);
  await put('source', 'x'.repeat(150) + 'needle' + '😀'.repeat(200));
  const result = await searchText(new FileService(config), {
    query: 'needle',
    path: 'source',
  });
  const match = result.matches[0]!;
  assert.equal(match.line, 1);
  assert.ok(match.excerpt.startsWith('x'.repeat(100) + 'needle'));
  assert.ok(Buffer.byteLength(match.excerpt) <= 500);
  assert.ok(!match.excerpt.includes('�'));
  assert.equal(match.excerptTruncated, true);
});

test('search counts skipped files and applies globs before reading', async (t) => {
  const { config, put } = await fixture(t);
  config.limits.fileBytes = 32;
  await put('text.ts', 'needle\n');
  await put('binary.bin', Buffer.from([0, 1]));
  await put('large.bin', 'a'.repeat(33));
  const all = await searchText(new FileService(config), { query: 'needle' });
  assert.deepEqual(all.skipped, { BINARY_FILE: 1, FILE_TOO_LARGE: 1 });
  const filtered = await searchText(new FileService(config), {
    query: 'needle',
    glob: '**/*.ts',
  });
  assert.deepEqual(filtered.skipped, {});
  assert.deepEqual(filtered.matches, all.matches);
});

test('regex search preserves blank lines and propagates cancellation', async (t) => {
  const { config, put } = await fixture(t);
  await put('source', 'Needle\r\n\r\nneedle\r\n');
  const blank = await searchText(new FileService(config), {
    query: '^$',
    regex: true,
    path: 'source',
  });
  assert.deepEqual(
    blank.matches.map((match) => match.line),
    [2, 4],
  );
  const sensitive = await searchText(new FileService(config), {
    query: '^needle$',
    regex: true,
    caseSensitive: true,
    path: 'source',
  });
  assert.deepEqual(
    sensitive.matches.map((match) => match.line),
    [3],
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchText(new FileService(config, new Budget(1000, controller.signal)), {
      query: 'needle',
      path: 'source',
    }),
    { code: 'TIMEOUT' },
  );
});
