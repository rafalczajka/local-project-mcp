import type { Dirent } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type { ToolData } from '../result-schemas.js';
import type { Config } from '../config.js';
import { Budget, clip, errorCode, ProjectError, safeError } from '../errors.js';
import { Paths } from '../security/paths.js';
import { Policy } from '../security/policy.js';

export function decodeText(data: Buffer): string {
  if (data.includes(0))
    throw new ProjectError(
      'BINARY_FILE',
      'Binary files are not exposed as text.',
    );
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ProjectError(
      'BINARY_FILE',
      'File is binary or is not valid UTF-8.',
    );
  }
}
export interface FileRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

interface TreeRequest {
  readonly path?: string;
  readonly depth?: number;
  readonly includeHidden?: boolean;
}

interface FindRequest {
  readonly pattern: string;
  readonly path?: string;
  readonly maxResults?: number;
}
export type Entry = ToolData<'project_tree'>['entries'][number];

type WalkSummary = Pick<ToolData<'project_tree'>, 'truncated' | 'omitted'>;

type WalkOptions = { depth: number; includeHidden: boolean };
type EntryVisitor = (entry: Entry) => Promise<boolean | 'skip'>;

function formatLineRange(
  source: string,
  input: FileRequest,
  maxBytes: number,
  budget: Budget,
) {
  const lines = source.length === 0 ? [] : source.split(/\r?\n/);
  if (source.endsWith('\n')) lines.pop();
  const start = input.startLine ?? 1;
  const end = Math.min(input.endLine ?? lines.length, lines.length);
  let text = '';
  let lastLine = start - 1;
  let truncated = false;
  for (let line = start; line <= end; line++) {
    budget.check();
    const next = `${line} | ${lines[line - 1]}\n`;
    const remaining = maxBytes - Buffer.byteLength(text);
    if (Buffer.byteLength(next) > remaining) {
      text += clip(next, remaining);
      if (remaining > 0) lastLine = line;
      truncated = true;
      break;
    }
    text += next;
    lastLine = line;
  }
  return {
    startLine: start,
    endLine: lastLine >= start ? lastLine : null,
    totalLines: lines.length,
    text,
    truncated,
  };
}

export class FileService {
  readonly paths: Paths;
  readonly policy: Policy;
  constructor(
    public readonly config: Config,
    public readonly budget = new Budget(config.limits.timeoutMs),
  ) {
    this.paths = new Paths(config.root);
    this.policy = new Policy(config, this.paths);
  }
  async text(input: string): Promise<string> {
    this.budget.check();
    await this.policy.assert(input);
    const buffer = await this.paths.read(input, this.config.limits.fileBytes);
    this.budget.check();
    return decodeText(buffer);
  }
  async readFile(
    input: FileRequest,
    maxBytes = this.config.limits.readBytes,
  ): Promise<ToolData<'read_file'>> {
    if ((input.endLine ?? Infinity) < (input.startLine ?? 1))
      throw new ProjectError(
        'INVALID_RANGE',
        'endLine must be at least startLine.',
      );
    const source = await this.text(input.path);
    const result = formatLineRange(source, input, maxBytes, this.budget);
    return { path: (await this.paths.resolve(input.path)).relative, ...result };
  }
  async readFiles(
    files: readonly FileRequest[],
  ): Promise<ToolData<'read_files'>> {
    let remaining = this.config.limits.batchBytes;
    const results: ToolData<'read_files'>['files'] = [];
    for (const file of files) {
      try {
        if (remaining <= 0)
          throw new ProjectError(
            'BATCH_LIMIT',
            'Combined read output limit reached.',
          );
        const data = await this.readFile(
          file,
          Math.min(remaining, this.config.limits.readBytes),
        );
        remaining -= Buffer.byteLength(data.text);
        results.push({ ...data, ok: true });
      } catch (error) {
        results.push({ ok: false, error: safeError(error) });
      }
    }
    return {
      files: results,
      truncated: results.some((result) => !result.ok || result.truncated),
    };
  }
  async info(input: string): Promise<ToolData<'file_info'>> {
    const { target, stat: info } = await this.inspectPath(input);
    let binary: boolean | null = null;
    if (info.isFile() && info.size <= this.config.limits.fileBytes) {
      try {
        decodeText(await this.paths.read(input, this.config.limits.fileBytes));
        binary = false;
      } catch (error) {
        if (error instanceof ProjectError && error.code === 'BINARY_FILE')
          binary = true;
        else throw error;
      }
    }
    return {
      path: target.relative,
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      size: info.size,
      modified: info.mtime.toISOString(),
      binary,
      extension: path.extname(target.relative) || null,
    };
  }
  private async inspectPath(input: string) {
    const target = await this.policy.resolve(input);
    const stat = await lstat(target.absolute);
    await this.policy.assert(input, stat.isDirectory());
    return { target, stat };
  }

  private async canVisitChild(input: string, child: Dirent): Promise<boolean> {
    try {
      await this.policy.assert(input, child.isDirectory());
      await this.paths.resolve(input);
    } catch (error) {
      if (
        error instanceof ProjectError ||
        ['ENOENT', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '')
      )
        return false;
      throw error;
    }
    return child.isFile() || child.isDirectory();
  }

  async walk(
    input: string,
    options: Readonly<WalkOptions>,
    visit: EntryVisitor,
  ): Promise<WalkSummary> {
    const { target, stat } = await this.inspectPath(input);
    let truncated = false;
    let omitted = 0;
    let stopped = false;
    const recurse = async (relative: string, depth: number): Promise<void> => {
      this.budget.check();
      const current = await this.paths.resolve(relative);
      const directory = await opendir(current.absolute);
      try {
        for await (const child of directory) {
          this.budget.check();
          if (++this.budget.visited > this.config.limits.scanEntries) {
            truncated = true;
            stopped = true;
            break;
          }
          const childPath =
            relative === '.' ? child.name : `${relative}/${child.name}`;
          if (!options.includeHidden && child.name.startsWith('.')) {
            omitted++;
            continue;
          }
          if (!(await this.canVisitChild(childPath, child))) {
            omitted++;
            continue;
          }
          const decision = await visit({
            path: childPath,
            type: child.isDirectory() ? 'directory' : 'file',
            depth,
          });
          if (decision === false) {
            truncated = true;
            stopped = true;
            break;
          }
          if (child.isDirectory() && decision !== 'skip') {
            if (depth < options.depth) await recurse(childPath, depth + 1);
            else truncated = true;
          }
          if (stopped) break;
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    };
    if (stat.isFile())
      await visit({ path: target.relative, type: 'file', depth: 0 });
    else if (stat.isDirectory()) await recurse(target.relative, 1);
    else
      throw new ProjectError(
        'NOT_FILE',
        'Only regular files and directories are supported.',
      );
    return { truncated, omitted };
  }
  async tree(input: TreeRequest): Promise<ToolData<'project_tree'>> {
    const entries: Entry[] = [];
    const depth = input.depth ?? Math.min(2, this.config.limits.treeDepth);
    const summary = await this.walk(
      input.path ?? '.',
      { depth, includeHidden: input.includeHidden ?? false },
      async (entry) => {
        if (entries.length >= this.config.limits.treeEntries) return false;
        entries.push(entry);
        return true;
      },
    );
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      path: input.path ?? '.',
      entries,
      ...summary,
      limits: { entries: this.config.limits.treeEntries, depth },
    };
  }
  async find(input: FindRequest): Promise<ToolData<'find_files'>> {
    const files: string[] = [];
    const summary = await this.walk(
      input.path ?? '.',
      { depth: 64, includeHidden: true },
      async (entry) => {
        if (
          entry.type === 'file' &&
          minimatch(entry.path, input.pattern, {
            dot: true,
            nonegate: true,
            nocase: false,
          })
        ) {
          if (
            files.length >=
            (input.maxResults ?? this.config.limits.searchResults)
          )
            return false;
          files.push(entry.path);
        }
        return true;
      },
    );
    return { files, ...summary };
  }
}
