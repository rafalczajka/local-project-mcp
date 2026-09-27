import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { ProjectError } from '../errors.js';

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function normalizeInput(input: string): string {
  if (
    input.length > 1024 ||
    /[\x00-\x1f\x7f:]/u.test(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input)
  )
    throw new ProjectError('INVALID_PATH', 'Use a relative project path.');
  const parts = input.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (p) =>
        p === '..' ||
        (p !== '.' && /[. ]$/.test(p)) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
        p.includes('~'),
    )
  )
    throw new ProjectError(
      'INVALID_PATH',
      'Traversal and ambiguous platform paths are not allowed.',
    );
  return parts.filter((p) => p !== '' && p !== '.').join('/') || '.';
}

export class Paths {
  constructor(public readonly root: string) {}
  async resolve(input: string, allowMissing = false) {
    const relative = normalizeInput(input);
    const absolute = path.resolve(this.root, relative);
    if (!isInside(this.root, absolute))
      throw new ProjectError('OUTSIDE_ROOT', 'Path is outside the project.');
    let current = this.root;
    // Recheck the root as well: replacement after startup must not silently redirect reads.
    if ((await realpath(current)) !== this.root)
      throw new ProjectError(
        'ROOT_CHANGED',
        'Project root changed; restart the server.',
      );
    for (const part of relative === '.' ? [] : relative.split('/')) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new ProjectError(
            'SYMLINK_DENIED',
            'Symbolic links and junctions are not exposed.',
          );
        if (info.isFile() && info.nlink > 1)
          throw new ProjectError(
            'HARDLINK_DENIED',
            'Hard-linked files are not exposed.',
          );
        if (!isInside(this.root, await realpath(current)))
          throw new ProjectError(
            'OUTSIDE_ROOT',
            'Path is outside the project.',
          );
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
          break;
        throw error;
      }
    }
    return { relative, absolute };
  }
  async read(input: string, maxBytes: number): Promise<Buffer> {
    const { absolute } = await this.resolve(input);
    const before = await lstat(absolute);
    if (!before.isFile())
      throw new ProjectError('NOT_FILE', 'The path is not a regular file.');
    if (before.size > maxBytes)
      throw new ProjectError(
        'FILE_TOO_LARGE',
        'File exceeds the configured byte limit.',
      );
    const handle = await open(
      absolute,
      constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink > 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        throw new ProjectError(
          'PATH_CHANGED',
          'File changed during validation; retry.',
        );
      await this.resolve(input);
      const data = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(
          data,
          length,
          data.length - length,
          length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes)
        throw new ProjectError(
          'FILE_TOO_LARGE',
          'File exceeds the configured byte limit.',
        );
      return data.subarray(0, length);
    } finally {
      await handle.close();
    }
  }
}
