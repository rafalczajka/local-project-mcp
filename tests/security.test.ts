import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink, link, writeFile } from 'node:fs/promises';
import { FileService } from '../src/services/filesystem.js';
import { isInside } from '../src/security/paths.js';
import { loadConfig } from '../src/config.js';
import { fixture } from './helpers.js';

test('traversal, absolute paths, alternate streams, device names and ambiguous Windows paths fail', async (t) => {
  const { config } = await fixture(t);
  const fs = new FileService(config);
  for (const value of [
    '../secret.txt',
    '../../etc/passwd',
    'foo/../../../etc/passwd',
    '..\\secret',
    '/etc/passwd',
    'C:\\secret',
    '\\\\host\\share',
    'src/file:secret',
    'NUL',
    'foo. /file',
    'PROJEC~1/file',
    'foo\0bar',
  ]) {
    await assert.rejects(
      fs.readFile({ path: value }),
      { code: 'INVALID_PATH' },
      value,
    );
  }
});

test('containment uses path components, not string prefixes', async (t) => {
  const { root, temp, config } = await fixture(t);
  const other = path.join(temp, 'project-other');
  await mkdir(other);
  await writeFile(path.join(other, 'secret.txt'), 'OUTSIDE');
  assert.equal(isInside(root, other), false);
  assert.equal(isInside(root, path.join(root, 'src')), true);
  await assert.rejects(
    new FileService(config).readFile({ path: '../project-other/secret.txt' }),
  );
});

test('external junction/symlink is rejected by every filesystem operation', async (t) => {
  const { root, temp, config } = await fixture(t);
  const outside = path.join(temp, 'project-other');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE');
  await symlink(
    outside,
    path.join(root, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const fs = new FileService(config);
  await assert.rejects(fs.readFile({ path: 'link/secret.txt' }), {
    code: 'SYMLINK_DENIED',
  });
  await assert.rejects(fs.info('link'), { code: 'SYMLINK_DENIED' });
  assert.equal((await fs.tree({})).entries.length, 0);
  assert.deepEqual((await fs.find({ pattern: '**/*' })).files, []);
});

test('hard-linked files cannot alias secrets', async (t) => {
  const { root, temp, config } = await fixture(t);
  const outside = path.join(temp, 'secret.txt');
  await writeFile(outside, 'SECRET');
  await link(outside, path.join(root, 'innocent.txt'));
  await assert.rejects(
    new FileService(config).readFile({ path: 'innocent.txt' }),
    { code: 'HARDLINK_DENIED' },
  );
});

test('sensitive paths are denied case-insensitively, including ancestors and custom patterns', async (t) => {
  const { config, put } = await fixture(t);
  config.sensitive = ['private/**', '*.token'];
  const fs = new FileService(config);
  for (const file of [
    '.env',
    '.ENV.local',
    'cert.pem',
    'cert.key',
    'cert.p12',
    'cert.pfx',
    'id_rsa',
    'id_ed25519',
    'credentials',
    'credentials.json',
    'secrets.yaml',
    '.ssh/config',
    '.aws/config',
    '.gnupg/config',
    '.git/config',
    '.npmrc',
    'private/data.txt',
    'login.token',
  ]) {
    await put(file, 'SECRET');
    await assert.rejects(
      fs.readFile({ path: file }),
      { code: 'SENSITIVE_PATH' },
      file,
    );
    await assert.rejects(fs.info(file), { code: 'SENSITIVE_PATH' }, file);
  }
});

test('configuration canonicalizes root, requires explicit root and protects network binding', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await loadConfig(['--root', root], {})).root, root);
  await assert.rejects(loadConfig([], {}));
  await assert.rejects(loadConfig(['--root', root, '--host', '0.0.0.0'], {}));
  await assert.rejects(loadConfig(['--root', root, '--port', '0'], {}));
  assert.equal(
    (await loadConfig([], { PROJECT_ROOT: root })).host,
    '127.0.0.1',
  );
});
