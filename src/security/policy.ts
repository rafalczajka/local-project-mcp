import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import type { Config } from '../config.js';
import { errorCode, ProjectError } from '../errors.js';
import { Paths, normalizeInput, type ResolvedPath } from './paths.js';

const MAX_GITIGNORE_BYTES = 64 * 1024;

function matchesSensitivePattern(value: string, pattern: string): boolean {
  return minimatch(value, pattern, { nocase: true, dot: true, nonegate: true });
}

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
  '.pypirc'
];

export class Policy {
  private readonly exclusions: Ignore;
  private readonly gitignores = new Map<string, Ignore>();

  constructor(
    private readonly config: Config,
    public readonly paths: Paths
  ) {
    this.exclusions = ignore().add(config.ignore);
  }

  private sensitive(relative: string): boolean {
    const patterns = [...sensitivePatterns, ...this.config.sensitive];

    return relative.split('/').some((component, index, parts) => {
      const ancestor = parts.slice(0, index + 1).join('/');

      return patterns.some(
        (pattern) =>
          matchesSensitivePattern(component, pattern) || matchesSensitivePattern(ancestor, pattern)
      );
    });
  }

  private async gitignore(directory: string): Promise<Ignore> {
    const cached = this.gitignores.get(directory);

    if (cached) return cached;

    const matcher = ignore();

    try {
      matcher.add(
        (
          await this.paths.read(
            directory === '.' ? '.gitignore' : `${directory}/.gitignore`,
            MAX_GITIGNORE_BYTES
          )
        ).toString('utf8')
      );
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    this.gitignores.set(directory, matcher);
    return matcher;
  }

  async assert(input: string, directory = false): Promise<void> {
    const relative = normalizeInput(input);

    if (relative === '.') return;

    if (this.sensitive(relative))
      throw new ProjectError('SENSITIVE_PATH', 'Sensitive paths are not exposed.');

    const target = relative + (directory ? '/' : '');

    if (this.exclusions.ignores(target))
      throw new ProjectError('IGNORED_PATH', 'Path is excluded by project policy.');

    if (this.config.respectGitignore) await this.assertGitignoreAllows(relative, directory);
  }

  private async assertGitignoreAllows(relative: string, directory: boolean): Promise<void> {
    const parts = relative.split('/');

    // Check parents first: negations cannot resurrect an excluded directory.
    for (let end = 1; end <= parts.length; end++) {
      if (await this.isGitignored(parts.slice(0, end), end < parts.length || directory))
        throw new ProjectError('IGNORED_PATH', 'Path is excluded by .gitignore.');
    }
  }

  private async isGitignored(parts: readonly string[], directory: boolean): Promise<boolean> {
    let ignored = false;

    for (let base = 0; base < parts.length; base++) {
      const rule = await this.gitignore(parts.slice(0, base).join('/') || '.');
      const candidate = parts.slice(base).join('/') + (directory ? '/' : '');
      const result = rule.test(candidate);

      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  async resolve(input: string, allowMissing = false): Promise<ResolvedPath> {
    // Policy is evaluated before stat to avoid probing sensitive names.
    await this.assert(input);
    return this.paths.resolve(input, allowMissing);
  }
}
