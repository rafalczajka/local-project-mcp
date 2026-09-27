import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import type { Config } from '../config.js';
import { ProjectError } from '../errors.js';
import { Paths, normalizeInput } from './paths.js';

export const sensitivePatterns = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'id_dsa*',
  'id_ecdsa*',
  'credentials',
  'credentials.*',
  'secrets',
  'secrets.*',
  '.ssh',
  '.aws',
  '.gnupg',
  '.git',
  '.hg',
  '.svn',
  '.npmrc',
  '.netrc',
  '.pypirc',
];
export class Policy {
  private readonly exclusions: Ignore;
  private readonly gitignores = new Map<string, Ignore>();
  constructor(
    private readonly config: Config,
    public readonly paths: Paths,
  ) {
    this.exclusions = ignore().add(config.ignore);
  }
  private sensitive(relative: string) {
    const patterns = [...sensitivePatterns, ...this.config.sensitive];
    return relative.split('/').some((component, i, parts) =>
      patterns.some(
        (pattern) =>
          minimatch(component, pattern, {
            nocase: true,
            dot: true,
            nonegate: true,
          }) ||
          minimatch(parts.slice(0, i + 1).join('/'), pattern, {
            nocase: true,
            dot: true,
            nonegate: true,
          }),
      ),
    );
  }
  private async gitignore(directory: string) {
    const cached = this.gitignores.get(directory);
    if (cached) return cached;
    const matcher = ignore();
    try {
      matcher.add(
        (
          await this.paths.read(
            directory === '.' ? '.gitignore' : `${directory}/.gitignore`,
            64 * 1024,
          )
        ).toString('utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.gitignores.set(directory, matcher);
    return matcher;
  }
  async assert(input: string, directory = false) {
    const relative = normalizeInput(input);
    if (relative === '.') return;
    if (this.sensitive(relative))
      throw new ProjectError(
        'SENSITIVE_PATH',
        'Sensitive paths are not exposed.',
      );
    const target = relative + (directory ? '/' : '');
    if (this.exclusions.ignores(target))
      throw new ProjectError(
        'IGNORED_PATH',
        'Path is excluded by project policy.',
      );
    if (this.config.respectGitignore) {
      const parts = relative.split('/');
      // Evaluate each parent directory as a directory: negations cannot resurrect an excluded parent.
      for (let end = 1; end <= parts.length; end++) {
        let ignored = false;
        for (let base = 0; base < end; base++) {
          const rule = await this.gitignore(
            parts.slice(0, base).join('/') || '.',
          );
          const candidate =
            parts.slice(base, end).join('/') +
            (end < parts.length || directory ? '/' : '');
          const result = rule.test(candidate);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored)
          throw new ProjectError(
            'IGNORED_PATH',
            'Path is excluded by .gitignore.',
          );
      }
    }
  }
  async resolve(input: string, allowMissing = false) {
    // Policy is evaluated before stat to avoid probing sensitive names.
    await this.assert(input);
    return this.paths.resolve(input, allowMissing);
  }
}
