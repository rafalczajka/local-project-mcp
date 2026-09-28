import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { lstat, realpath, open, type FileHandle } from 'node:fs/promises';
import { errorCode, ProjectError } from '../errors.js';

const MAX_INPUT_LENGTH = 1024;

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

export function normalizeInput(input: string): string {
  if (
    input.length > MAX_INPUT_LENGTH ||
    /[\x00-\x1f\x7f:]/u.test(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input)
  )
    throw new ProjectError('INVALID_PATH', 'Use a relative project path.');
  const parts = input.replaceAll('\\', '/').split('/');
  if (parts.some(isAmbiguousComponent))
    throw new ProjectError(
      'INVALID_PATH',
      'Traversal and ambiguous platform paths are not allowed.'
    );
  return parts.filter((p) => p !== '' && p !== '.').join('/') || '.';
}

function isAmbiguousComponent(part: string): boolean {
  return (
    part === '..' ||
    (part !== '.' && /[. ]$/.test(part)) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
    part.includes('~')
  );
}

function assertWithinByteLimit(size: number, maxBytes: number): void {
  if (size > maxBytes)
    throw new ProjectError('FILE_TOO_LARGE', 'File exceeds the configured byte limit.');
}

function assertSameFile(before: Stats, opened: Stats): void {
  if (
    !opened.isFile() ||
    opened.nlink > 1 ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino
  )
    throw new ProjectError('PATH_CHANGED', 'File changed during validation; retry.');
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  // Read one extra byte to detect growth since the initial size check.
  const data = Buffer.alloc(maxBytes + 1);
  let length = 0;

  while (length < data.length) {
    const { bytesRead } = await handle.read(data, length, data.length - length, length);

    if (bytesRead === 0) break;

    length += bytesRead;
  }
  assertWithinByteLimit(length, maxBytes);
  return data.subarray(0, length);
}

export interface ResolvedPath {
  relative: string;
  absolute: string;
}

export class Paths {
  constructor(public readonly root: string) {}

  async resolve(input: string, allowMissing = false): Promise<ResolvedPath> {
    const relative = normalizeInput(input);
    const absolute = path.resolve(this.root, relative);

    if (!isInside(this.root, absolute))
      throw new ProjectError('OUTSIDE_ROOT', 'Path is outside the project.');

    let current = this.root;

    // Recheck the root as well: replacement after startup must not silently redirect reads.
    if ((await realpath(current)) !== this.root)
      throw new ProjectError('ROOT_CHANGED', 'Project root changed; restart the server.');

    for (const part of relative === '.' ? [] : relative.split('/')) {
      current = path.join(current, part);

      try {
        await this.assertSafeComponent(current);
      } catch (error) {
        if (allowMissing && errorCode(error) === 'ENOENT') break;
        throw error;
      }
    }
    return { relative, absolute };
  }
  private async assertSafeComponent(absolute: string): Promise<void> {
    const info = await lstat(absolute);

    if (info.isSymbolicLink())
      throw new ProjectError('SYMLINK_DENIED', 'Symbolic links and junctions are not exposed.');

    if (info.isFile() && info.nlink > 1)
      throw new ProjectError('HARDLINK_DENIED', 'Hard-linked files are not exposed.');

    if (!isInside(this.root, await realpath(absolute)))
      throw new ProjectError('OUTSIDE_ROOT', 'Path is outside the project.');
  }

  async read(input: string, maxBytes: number): Promise<Buffer> {
    const { absolute } = await this.resolve(input);
    const before = await lstat(absolute);

    if (!before.isFile()) throw new ProjectError('NOT_FILE', 'The path is not a regular file.');

    assertWithinByteLimit(before.size, maxBytes);

    const handle = await open(
      absolute,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
    );

    try {
      const opened = await handle.stat();
      assertSameFile(before, opened);

      await this.resolve(input);

      // Await the read before finally closes the handle.
      return await readBounded(handle, maxBytes);
    } finally {
      await handle.close();
    }
  }
}
