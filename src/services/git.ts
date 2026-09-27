import { spawn } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { clip, ProjectError } from '../errors.js';
import { isInside } from '../security/paths.js';
import type { FileService } from './filesystem.js';

// Conservative config parser: unsupported syntax/config fails closed, before invoking Git.
// In particular includes, filters, fsmonitor, external diffs, and partial-clone remotes cannot run.
const configKeys: Record<string, string[]> = {
  core: [
    'repositoryformatversion',
    'filemode',
    'bare',
    'logallrefupdates',
    'symlinks',
    'ignorecase',
    'precomposeunicode',
    'autocrlf',
    'eol',
    'safecrlf',
    'quotepath',
    'longpaths',
  ],
  user: ['name', 'email', 'signingkey'],
  remote: ['url', 'pushurl', 'fetch'],
  branch: ['remote', 'merge', 'vscode-merge-base'],
};
export function validateGitConfig(source: string) {
  let section = '';
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const header = /^\[([a-z]+)(?: "[^"\\\x00-\x1f]+")?\]$/i.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      if (!configKeys[section]) throw unsafeRepo();
      continue;
    }
    const value = /^([a-z][a-z0-9-]*)\s*=\s*(.*)$/i.exec(line);
    if (
      !value ||
      !configKeys[section]?.includes(value[1]!.toLowerCase()) ||
      /\\\s*$/.test(line)
    )
      throw unsafeRepo();
  }
}
function unsafeRepo() {
  return new ProjectError(
    'UNSAFE_REPOSITORY',
    'Git inspection requires a standalone repository with ordinary local metadata and supported configuration. See README.',
  );
}

export class GitService {
  private binary = '';
  constructor(private readonly fs: FileService) {}
  private async prepare() {
    this.fs.budget.check();
    let gitDirectory;
    try {
      gitDirectory = await this.fs.paths.resolve('.git');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ProjectError(
          'NOT_GIT_REPOSITORY',
          'PROJECT_ROOT must be the top level of a Git repository.',
        );
      throw unsafeRepo();
    }
    if (!(await lstat(gitDirectory.absolute)).isDirectory()) throw unsafeRepo();
    let entries = 0;
    const inspect = async (relative: string, depth: number): Promise<void> => {
      if (depth > 32) throw unsafeRepo();
      const dir = await opendir(
        (await this.fs.paths.resolve(relative)).absolute,
      );
      try {
        for await (const entry of dir) {
          this.fs.budget.check();
          if (++entries > this.fs.config.limits.scanEntries)
            throw new ProjectError(
              'GIT_LIMIT',
              'Repository metadata exceeds inspection limits.',
            );
          const child = `${relative}/${entry.name}`;
          if (
            [
              'alternates',
              'http-alternates',
              'commondir',
              'gitdir',
              'grafts',
              'shallow',
            ].includes(entry.name) ||
            entry.name.endsWith('.promisor')
          )
            throw unsafeRepo();
          try {
            await this.fs.paths.resolve(child);
          } catch {
            throw unsafeRepo();
          }
          if (entry.isDirectory()) await inspect(child, depth + 1);
          else if (!entry.isFile()) throw unsafeRepo();
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    };
    await inspect('.git', 0);
    validateGitConfig(
      (await this.fs.paths.read('.git/config', 64 * 1024)).toString('utf8'),
    );
    // Resolve a trusted installed executable, never an executable in the inspected project.
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      try {
        const candidate = await realpath(
          path.join(
            directory,
            process.platform === 'win32' ? 'git.exe' : 'git',
          ),
        );
        if (
          !isInside(this.fs.config.root, candidate) &&
          (await lstat(candidate)).isFile()
        ) {
          this.binary = candidate;
          break;
        }
      } catch {
        /* Try the next trusted PATH entry. */
      }
    }
    if (!this.binary)
      throw new ProjectError(
        'GIT_UNAVAILABLE',
        'Install Git and add its executable directory to PATH.',
      );
  }
  private run(
    args: string[],
    limit = this.fs.config.limits.gitBytes,
  ): Promise<{ text: string; truncated: boolean }> {
    this.fs.budget.check();
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const env: NodeJS.ProcessEnv = {
      PATH: path.dirname(this.binary),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: nullDevice,
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_PAGER: '',
      LC_ALL: 'C',
    };
    const fixed = [
      '--no-pager',
      '--no-optional-locks',
      `--git-dir=${path.join(this.fs.config.root, '.git')}`,
      `--work-tree=${this.fs.config.root}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${nullDevice}`,
      '-c',
      `core.attributesFile=${nullDevice}`,
      '-c',
      `core.excludesFile=${nullDevice}`,
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.quotePath=true',
      '-c',
      'color.ui=false',
      '-c',
      'diff.renames=false',
      '-c',
      'diff.ignoreSubmodules=all',
      '-c',
      'submodule.recurse=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'maintenance.auto=false',
      '-c',
      'gc.auto=0',
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...fixed, ...args], {
        cwd: this.fs.config.root,
        shell: false,
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let size = 0,
        truncated = false,
        timedOut = false;
      const stop = () => {
        timedOut = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(stop, this.fs.budget.remaining());
      this.fs.budget.signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        const remaining = limit - size;
        chunks.push(chunk.subarray(0, Math.max(0, remaining)));
        size += chunk.length;
        if (size > limit) {
          truncated = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', () => {
        /* Do not return stderr: it can contain host paths or secrets. */
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(
          new ProjectError('GIT_UNAVAILABLE', 'Git could not be started.'),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.fs.budget.signal?.removeEventListener('abort', stop);
        if (timedOut)
          reject(
            new ProjectError('TIMEOUT', 'Git operation deadline reached.'),
          );
        else if (code !== 0 && !truncated)
          reject(
            new ProjectError(
              'GIT_FAILED',
              'Git inspection failed; the repository may be unborn, unsupported, or corrupt.',
            ),
          );
        else
          resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
      });
    });
  }
  private async allowed(file: string) {
    try {
      await this.fs.policy.resolve(file, true);
      await this.fs.policy.assert(file, false);
      return true;
    } catch {
      return false;
    }
  }
  private async pathspec(input?: string) {
    if (!input) return '.';
    const value = await this.fs.policy.resolve(input, true);
    try {
      await this.fs.policy.assert(
        input,
        (await lstat(value.absolute)).isDirectory(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return value.relative;
  }
  async status() {
    await this.prepare();
    const result = await this.run([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=all',
      '--no-renames',
    ]);
    const entries: { path: string; status: string }[] = [];
    let omitted = 0;
    // A killed process may leave an incomplete last NUL record; never expose it.
    const records = result.text.split('\0').slice(0, -1);
    for (const record of records) {
      this.fs.budget.check();
      const file = record.slice(3);
      if (await this.allowed(file))
        entries.push({ path: file, status: record.slice(0, 2) });
      else omitted++;
    }
    // Git's untracked discovery can inspect nested repository pointers. Enumerate
    // those paths ourselves, using the same containment/ignore policy as reads.
    const index = await this.run(['ls-files', '--stage', '-z']);
    let truncated = result.truncated || index.truncated;
    if (!truncated) {
      const tracked = new Set<string>();
      const submodules = new Set<string>();
      for (const record of index.text.split('\0').slice(0, -1)) {
        const file = record.slice(record.indexOf('\t') + 1);
        tracked.add(file);
        if (record.startsWith('160000 ')) submodules.add(file);
      }
      let size = Buffer.byteLength(JSON.stringify(entries));
      const summary = await this.fs.walk(
        '.',
        { depth: 64, includeHidden: true },
        async (entry) => {
          if (submodules.has(entry.path)) return 'skip';
          if (entry.type === 'file' && !tracked.has(entry.path)) {
            const item = { path: entry.path, status: '??' };
            size += Buffer.byteLength(JSON.stringify(item));
            if (size > this.fs.config.limits.gitBytes) return false;
            entries.push(item);
          }
          return true;
        },
      );
      omitted += summary.omitted;
      truncated ||= summary.truncated;
    }
    return { entries, omitted, truncated };
  }
  async diff(input: { path?: string; staged?: boolean }) {
    const scope = await this.pathspec(input.path);
    await this.prepare();
    const base = [
      'diff',
      ...(input.staged ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=all',
    ];
    const changed = await this.run([...base, '--raw', '-z', '--', scope]);
    const records = changed.text.split('\0').slice(0, -1);
    let text = '',
      omitted = 0,
      truncated = changed.truncated;
    for (let i = 0; i + 1 < records.length; i += 2) {
      const fields = records[i]!.split(' ');
      const file = records[i + 1]!;
      const modes = [fields[0]?.slice(1), fields[1]];
      if (
        modes.some(
          (mode) => mode !== '000000' && mode !== '100644' && mode !== '100755',
        ) ||
        !(await this.allowed(file))
      ) {
        omitted++;
        continue;
      }
      const remaining =
        this.fs.config.limits.gitBytes - Buffer.byteLength(text);
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const result = await this.run(
        [
          ...base,
          '--no-color',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--unified=3',
          '--',
          file,
        ],
        remaining,
      );
      text += clip(result.text, remaining);
      truncated ||= result.truncated;
      if (truncated) break;
    }
    return { text, staged: input.staged ?? false, omitted, truncated };
  }
  async log(input: { path?: string; limit?: number }) {
    const scope = await this.pathspec(input.path);
    await this.prepare();
    // No --follow: that could traverse a denied historical filename.
    const result = await this.run([
      'log',
      `-${input.limit ?? 10}`,
      '--no-show-signature',
      '--no-use-mailmap',
      '--format=%H%x00%an%x00%aI%x00%s',
      '-z',
      '--',
      scope,
    ]);
    const fields = result.text.split('\0').slice(0, -1);
    const commits = [];
    for (let i = 0; i + 3 < fields.length; i += 4)
      commits.push({
        hash: fields[i]!,
        author: fields[i + 1]!,
        date: fields[i + 2]!,
        subject: fields[i + 3]!,
      });
    return { commits, truncated: result.truncated };
  }
}
