import { RE2 } from 're2-wasm';
import { minimatch } from 'minimatch';
import { clip, ProjectError, safeError } from '../errors.js';
import type { FileService } from './filesystem.js';

export async function searchText(
  fs: FileService,
  input: {
    query: string;
    path?: string;
    glob?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
  },
) {
  let regex: RE2 | undefined;
  if (input.regex) {
    try {
      regex = new RE2(input.query, input.caseSensitive ? 'u' : 'iu');
    } catch {
      throw new ProjectError(
        'INVALID_REGEX',
        'Use an RE2 expression; backreferences and lookaround are unsupported.',
      );
    }
  }
  const query = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches: {
    path: string;
    line: number;
    excerpt: string;
    excerptTruncated: boolean;
  }[] = [];
  const skipped: Record<string, number> = {};
  let limitReached = false;
  const summary = await fs.walk(
    input.path ?? '.',
    { depth: 64, includeHidden: true },
    async (entry) => {
      if (
        entry.type !== 'file' ||
        (input.glob &&
          !minimatch(entry.path, input.glob, { dot: true, nonegate: true }))
      )
        return true;
      let source: string;
      try {
        source = await fs.text(entry.path);
      } catch (error) {
        const { code } = safeError(error);
        if (code === 'TIMEOUT') throw error;
        skipped[code] = (skipped[code] ?? 0) + 1;
        return true;
      }
      fs.budget.bytes += Buffer.byteLength(source);
      if (fs.budget.bytes > fs.config.limits.scanBytes) {
        limitReached = true;
        return false;
      }
      const lines = source.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        fs.budget.check();
        const line = lines[i]!;
        const comparable = input.caseSensitive ? line : line.toLowerCase();
        const index = regex
          ? (regex.exec(line)?.index ?? -1)
          : comparable.indexOf(query);
        if (index >= 0) {
          if (
            matches.length >=
            (input.maxResults ?? fs.config.limits.searchResults)
          ) {
            limitReached = true;
            return false;
          }
          const excerpt = clip(line.slice(Math.max(0, index - 100)), 500);
          matches.push({
            path: entry.path,
            line: i + 1,
            excerpt,
            excerptTruncated: excerpt !== line,
          });
        }
      }
      return true;
    },
  );
  return {
    matches,
    ...summary,
    truncated: summary.truncated || limitReached,
    skipped,
  };
}
