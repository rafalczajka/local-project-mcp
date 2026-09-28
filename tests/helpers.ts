import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { defaultIgnores, defaultLimits, type Config } from '../src/config.js';
import { isInside } from '../src/security/paths.js';

export async function fixture(t: TestContext) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'local-project-mcp-test-')));
  const root = path.join(temp, 'project');
  await mkdir(root);
  t.after(async () => {
    if (
      !isInside(await realpath(tmpdir()), temp) ||
      !path.basename(temp).startsWith('local-project-mcp-test-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(temp, { recursive: true, force: true });
  });
  const config: Config = {
    root,
    host: '127.0.0.1',
    port: 3000,
    ignore: defaultIgnores,
    sensitive: [],
    respectGitignore: true,
    allowedHosts: [],
    allowedOrigins: [],
    limits: { ...defaultLimits }
  };
  const put = async (relative: string, content: string | Buffer) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_TERMINAL_PROMPT: '0'
        }
      }
    );
  const initGit = () => {
    git('init');
    git('config', 'user.name', 'Test Author');
    git('config', 'user.email', 'test@example.invalid');
  };
  return { temp, root, config, put, git, initGit };
}
