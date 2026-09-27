import { realpath, stat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';

export const defaultLimits = {
  fileBytes: 2 * 1024 * 1024,
  readBytes: 64 * 1024,
  batchBytes: 256 * 1024,
  batchFiles: 10,
  searchResults: 100,
  treeEntries: 500,
  treeDepth: 6,
  gitBytes: 128 * 1024,
  timeoutMs: 10_000,
  scanEntries: 20_000,
  scanBytes: 32 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  concurrency: 4,
};
export type Limits = typeof defaultLimits;
const limitSchema = z
  .object(
    Object.fromEntries(
      Object.keys(defaultLimits).map((key) => [
        key,
        z
          .number()
          .int()
          .min(key === 'outputBytes' ? 1024 : 1)
          .max(1024 * 1024 * 1024)
          .optional(),
      ]),
    ),
  )
  .strict();
const configSchema = z
  .object({
    ignore: z.array(z.string().min(1).max(512)).max(100).optional(),
    sensitive: z.array(z.string().min(1).max(512)).max(100).default([]),
    respectGitignore: z.boolean().default(true),
    allowedHosts: z.array(z.string().min(1).max(253)).max(20).default([]),
    allowedOrigins: z.array(z.url()).max(20).default([]),
    limits: limitSchema.default({}),
  })
  .strict();
export const defaultIgnores = [
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  'coverage/',
  '.next/',
  '.cache/',
  'target/',
];
export interface Config {
  root: string;
  host: string;
  port: number;
  token?: string;
  ignore: string[];
  sensitive: string[];
  respectGitignore: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  limits: Limits;
}

export async function loadConfig(
  args = process.argv.slice(2),
  env = process.env,
): Promise<Config> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      config: { type: 'string' },
    },
    strict: true,
  });
  const rootInput = values.root ?? env.PROJECT_ROOT;
  if (!rootInput)
    throw new Error('Set PROJECT_ROOT or pass --root /path/to/project.');
  const root = await realpath(rootInput);
  if (!(await stat(root)).isDirectory())
    throw new Error('PROJECT_ROOT must be a directory.');
  const settings = configSchema.parse(
    values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {},
  );
  const host = values.host ?? env.HOST ?? '127.0.0.1';
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(values.port ?? env.PORT ?? 3000);
  const token = env.MCP_BEARER_TOKEN;
  if (token && token.length < 32)
    throw new Error('MCP_BEARER_TOKEN must contain at least 32 characters.');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token)
    throw new Error('Non-loopback binding requires MCP_BEARER_TOKEN.');
  return {
    root,
    host,
    port,
    token,
    ...settings,
    ignore: settings.ignore ?? defaultIgnores,
    limits: { ...defaultLimits, ...settings.limits } as Limits,
  };
}
