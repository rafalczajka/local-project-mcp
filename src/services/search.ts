import { RE2 } from 're2-wasm';
import { minimatch } from 'minimatch';
import { clip, ProjectError, safeError } from '../errors.js';
import type { FileService } from './filesystem.js';

const SEARCH_DEPTH = 64;
const EXCERPT_LEADING_CHARACTERS = 100;
const MAX_EXCERPT_BYTES = 500;

interface SearchInput {
  query: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

interface SearchMatch {
  path: string;
  line: number;
  excerpt: string;
  excerptTruncated: boolean;
}

function createLineMatcher(input: SearchInput): (line: string) => number {
  if (input.regex) {
    try {
      const regex = new RE2(input.query, input.caseSensitive ? 'u' : 'iu');
      return (line) => regex.exec(line)?.index ?? -1;
    } catch {
      throw new ProjectError(
        'INVALID_REGEX',
        'Use an RE2 expression; backreferences and lookaround are unsupported.',
      );
    }
  }
  const query = input.caseSensitive ? input.query : input.query.toLowerCase();
  return (line) =>
    (input.caseSensitive ? line : line.toLowerCase()).indexOf(query);
}

function createMatch(
  path: string,
  lineNumber: number,
  line: string,
  index: number,
): SearchMatch {
  const excerpt = clip(
    line.slice(Math.max(0, index - EXCERPT_LEADING_CHARACTERS)),
    MAX_EXCERPT_BYTES,
  );
  return {
    path,
    line: lineNumber,
    excerpt,
    excerptTruncated: excerpt !== line,
  };
}

export async function searchText(fs: FileService, input: SearchInput) {
  const findIndex = createLineMatcher(input);
  const matches: SearchMatch[] = [];
  const skipped: Record<string, number> = {};
  let limitReached = false;
  const summary = await fs.walk(
    input.path ?? '.',
    { depth: SEARCH_DEPTH, includeHidden: true },
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
        const index = findIndex(line);
        if (index < 0) continue;
        if (
          matches.length >= (input.maxResults ?? fs.config.limits.searchResults)
        ) {
          limitReached = true;
          return false;
        }
        matches.push(createMatch(entry.path, i + 1, line, index));
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
