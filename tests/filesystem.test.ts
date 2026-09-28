import test from 'node:test';
import assert from 'node:assert/strict';
import { FileService, type Entry } from '../src/services/filesystem.js';
import { searchText } from '../src/services/search.js';
import { Budget } from '../src/errors.js';
import { fixture } from './helpers.js';

test('line ranges, empty files, invalid ranges, UTF-8 clipping and oversized/binary files', async (t) => {
  const { config, put } = await fixture(t);
  await put('a.ts', 'first\r\nsecond\r\nthird\r\n');
  await put('empty', '');
  await put('binary', Buffer.from([0, 1, 2]));
  await put('invalid-utf8', Buffer.from([0xff, 0xfe]));
  await put('unicode', '😀'.repeat(100));
  const fs = new FileService(config);
  assert.equal(
    (await fs.readFile({ path: 'a.ts', startLine: 2, endLine: 2 })).text,
    '2 | second\n'
  );
  assert.equal((await fs.readFile({ path: 'empty' })).totalLines, 0);
  assert.equal((await fs.readFile({ path: 'a.ts', startLine: 100 })).endLine, null);
  await assert.rejects(fs.readFile({ path: 'a.ts', startLine: 3, endLine: 1 }), {
    code: 'INVALID_RANGE'
  });
  for (const file of ['binary', 'invalid-utf8'])
    await assert.rejects(fs.readFile({ path: file }), { code: 'BINARY_FILE' });
  const clipped = await fs.readFile({ path: 'unicode' }, 15);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.text) <= 15);
  assert.ok(!clipped.text.includes('�'));
  config.limits.fileBytes = 16;
  await assert.rejects(fs.readFile({ path: 'unicode' }), {
    code: 'FILE_TOO_LARGE'
  });
  assert.equal((await fs.info('unicode')).binary, null);
  assert.equal((await fs.info('binary')).binary, true);
});

test('batch reads have independent errors and combined byte limits', async (t) => {
  const { config, put } = await fixture(t);
  config.limits.batchBytes = 20;
  await put('one', 'a'.repeat(100));
  await put('two', 'b'.repeat(100));
  const result = await new FileService(config).readFiles([
    { path: '.env' },
    { path: 'missing' },
    { path: 'one' },
    { path: 'two' }
  ]);
  assert.equal(result.files.length, 4);
  assert.equal(result.files[0]?.ok, false);
  assert.equal(result.files[2]?.ok, true);
  assert.equal(result.files[3]?.ok, false);
  assert.equal(result.truncated, true);
});

test('nested gitignore, negation, generated paths, hidden files, and configurable exclusions', async (t) => {
  const { config, put } = await fixture(t);
  for (const file of [
    'keep.ts',
    'drop.log',
    'src/keep.log',
    'src/drop.log',
    'node_modules/x.ts',
    '.hidden',
    'excluded/a.ts'
  ])
    await put(file, 'needle');
  await put('.gitignore', '*.log\nexcluded/\n');
  await put('src/.gitignore', '!keep.log\n');
  const fs = new FileService(config);
  const found = (await fs.find({ pattern: '**/*' })).files;
  assert.ok(found.includes('keep.ts'));
  assert.ok(found.includes('src/keep.log'));
  assert.ok(!found.includes('src/drop.log'));
  assert.ok(!found.includes('node_modules/x.ts'));
  await assert.rejects(fs.readFile({ path: 'drop.log' }), {
    code: 'IGNORED_PATH'
  });
  await assert.rejects(fs.tree({ path: 'node_modules' }), {
    code: 'IGNORED_PATH'
  });
  const tree = await fs.tree({});
  assert.ok(!tree.entries.some((e) => e.path === '.hidden'));
  config.ignore = [];
  config.respectGitignore = false;
  const overridden = await new FileService(config).find({ pattern: '**/*.ts' });
  assert.ok(overridden.files.includes('node_modules/x.ts'));
  assert.ok(overridden.files.includes('excluded/a.ts'));
});

test('search literal, regex, case, glob, limits, sensitive and binary omissions', async (t) => {
  const { config, put } = await fixture(t);
  await put('src/auth.ts', 'UserSession created\nuserSession used\nuserSession closed\n');
  await put('src/auth.js', 'UserSession js\n');
  await put('.env', 'UserSession SECRET');
  await put('node_modules/a.ts', 'UserSession ignored');
  await put('binary', Buffer.from([0, 1, 2]));
  const search = (args: Parameters<typeof searchText>[1]) =>
    searchText(new FileService(config), args);
  assert.equal((await search({ query: 'UserSession', glob: '**/*.ts' })).matches.length, 3);
  assert.equal((await search({ query: 'UserSession', caseSensitive: true })).matches.length, 2);
  assert.equal(
    (
      await search({
        query: '^userSession.*used$',
        regex: true,
        caseSensitive: true
      })
    ).matches[0]?.line,
    2
  );
  const limited = await search({ query: 'UserSession', maxResults: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal((await search({ query: 'SECRET' })).matches.length, 0);
  await assert.rejects(search({ query: '(?=x)', regex: true }), {
    code: 'INVALID_REGEX'
  });
});

test('tree entry/depth, file discovery and scan byte limits report truncation', async (t) => {
  const { config, put } = await fixture(t);
  for (const file of ['src/deep/a', 'a', 'b', 'c']) await put(file, 'needle');
  config.limits.treeEntries = 2;
  assert.equal((await new FileService(config).tree({})).truncated, true);
  assert.equal((await new FileService(config).tree({ depth: 1 })).truncated, true);
  assert.equal(
    (await new FileService(config).find({ pattern: '**/*', maxResults: 1 })).truncated,
    true
  );
  config.limits.scanBytes = 1;
  assert.equal((await searchText(new FileService(config), { query: 'needle' })).truncated, true);
});

test('cancellation stops work', async (t) => {
  const { config, put } = await fixture(t);
  await put('a', 'text');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    new FileService(config, new Budget(1000, abort.signal)).readFile({
      path: 'a'
    }),
    { code: 'TIMEOUT' }
  );
});

test('numbered reads preserve byte boundaries and blank final lines', async (t) => {
  const { config, put } = await fixture(t);
  await put('lines', 'a\n\n');
  const fs = new FileService(config);
  const exact = await fs.readFile({ path: 'lines', endLine: 1 }, 6);
  assert.equal(exact.text, '1 | a\n');
  assert.equal(exact.truncated, false);
  const bounded = await fs.readFile({ path: 'lines' }, 6);
  assert.equal(bounded.text, exact.text);
  assert.equal(bounded.endLine, 1);
  assert.equal(bounded.totalLines, 2);
  assert.equal(bounded.truncated, true);
  const empty = await fs.readFile({ path: 'lines' }, 0);
  assert.equal(empty.text, '');
  assert.equal(empty.endLine, null);
  assert.equal(empty.truncated, true);
  assert.equal((await fs.readFile({ path: 'lines', startLine: 2 })).text, '2 | \n');
});

test('walk preserves skip, stop and single-file visitor semantics', async (t) => {
  const { config, put } = await fixture(t);
  await put('directory/child', 'text');
  const options = { depth: 4, includeHidden: true };
  const skipped: string[] = [];
  const summary = await new FileService(config).walk('.', options, async (entry) => {
    skipped.push(entry.path);
    return 'skip';
  });
  assert.deepEqual(skipped, ['directory']);
  assert.deepEqual(summary, { truncated: false, omitted: 0 });
  const stopped = await new FileService(config).walk('.', options, async () => false);
  assert.deepEqual(stopped, { truncated: true, omitted: 0 });
  const entries: Entry[] = [];
  const single = await new FileService(config).walk('directory/child', options, async (entry) => {
    entries.push(entry);
    return false;
  });
  assert.deepEqual(entries, [{ path: 'directory/child', type: 'file', depth: 0 }]);
  assert.deepEqual(single, { truncated: false, omitted: 0 });
});

test('walk reports excluded entries and respects the shared scan budget', async (t) => {
  const { config, put } = await fixture(t);
  await put('.hidden', 'text');
  await put('.env', 'SECRET');
  await put('visible', 'text');
  const hidden = await new FileService(config).tree({});
  assert.equal(hidden.omitted, 2);
  assert.deepEqual(
    hidden.entries.map((entry) => entry.path),
    ['visible']
  );
  config.limits.scanEntries = 1;
  const fs = new FileService(config);
  const summary = await fs.walk('.', { depth: 4, includeHidden: true }, async () => true);
  assert.equal(summary.truncated, true);
  assert.equal(fs.budget.visited, 2);
});
