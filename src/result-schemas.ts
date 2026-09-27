import { z } from 'zod';

export const errorSchema = z.object({ code: z.string(), message: z.string() });
const summary = {
  truncated: z.boolean(),
  omitted: z.number().int().nonnegative(),
};
const file = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int().nullable(),
  totalLines: z.number().int(),
  text: z.string(),
  truncated: z.boolean(),
});

// Advertise tool-specific shapes so clients can validate and consume results reliably.
export const resultSchemas: Record<string, z.ZodType> = {
  project_tree: z.object({
    path: z.string(),
    entries: z.array(
      z.object({
        path: z.string(),
        type: z.enum(['directory', 'file']),
        depth: z.number().int(),
      }),
    ),
    ...summary,
    limits: z.object({ entries: z.number().int(), depth: z.number().int() }),
  }),
  read_file: file,
  read_files: z.object({
    files: z.array(
      z.union([
        file.extend({ ok: z.literal(true) }),
        z.object({ ok: z.literal(false), error: errorSchema }),
      ]),
    ),
    truncated: z.boolean(),
  }),
  find_files: z.object({ files: z.array(z.string()), ...summary }),
  search_text: z.object({
    matches: z.array(
      z.object({
        path: z.string(),
        line: z.number().int(),
        excerpt: z.string(),
        excerptTruncated: z.boolean(),
      }),
    ),
    ...summary,
    skipped: z.record(z.string(), z.number().int()),
  }),
  file_info: z.object({
    path: z.string(),
    type: z.enum(['directory', 'file', 'other']),
    size: z.number(),
    modified: z.string(),
    binary: z.union([z.boolean(), z.null()]),
    extension: z.union([z.string(), z.null()]),
  }),
  git_status: z.object({
    entries: z.array(z.object({ path: z.string(), status: z.string() })),
    ...summary,
  }),
  git_diff: z.object({ text: z.string(), staged: z.boolean(), ...summary }),
  git_log: z.object({
    commits: z.array(
      z.object({
        hash: z.string(),
        author: z.string(),
        date: z.string(),
        subject: z.string(),
      }),
    ),
    truncated: z.boolean(),
  }),
};
