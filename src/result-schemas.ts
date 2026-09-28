import { z } from 'zod';

export const errorSchema = z.object({ code: z.string(), message: z.string() });

const truncationSummaryShape = {
  truncated: z.boolean(),
  omitted: z.number().int().nonnegative()
};

const fileReadSchema = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int().nullable(),
  totalLines: z.number().int(),
  text: z.string(),
  truncated: z.boolean()
});

const treeEntrySchema = z.object({
  path: z.string(),
  type: z.enum(['directory', 'file']),
  depth: z.number().int()
});

const batchFileResultSchema = z.union([
  fileReadSchema.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: errorSchema })
]);

const searchMatchSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  excerpt: z.string(),
  excerptTruncated: z.boolean()
});

const gitCommitSchema = z.object({
  hash: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string()
});

// Advertise tool-specific shapes so clients can validate and consume results reliably.
export const resultSchemas = {
  project_tree: z.object({
    path: z.string(),
    entries: z.array(treeEntrySchema),
    ...truncationSummaryShape,
    limits: z.object({ entries: z.number().int(), depth: z.number().int() })
  }),
  read_file: fileReadSchema,
  read_files: z.object({
    files: z.array(batchFileResultSchema),
    truncated: z.boolean()
  }),
  find_files: z.object({
    files: z.array(z.string()),
    ...truncationSummaryShape
  }),
  search_text: z.object({
    matches: z.array(searchMatchSchema),
    ...truncationSummaryShape,
    skipped: z.record(z.string(), z.number().int())
  }),
  file_info: z.object({
    path: z.string(),
    type: z.enum(['directory', 'file', 'other']),
    size: z.number(),
    modified: z.string(),
    binary: z.union([z.boolean(), z.null()]),
    extension: z.union([z.string(), z.null()])
  }),
  git_status: z.object({
    entries: z.array(z.object({ path: z.string(), status: z.string() })),
    ...truncationSummaryShape
  }),
  git_diff: z.object({
    text: z.string(),
    staged: z.boolean(),
    ...truncationSummaryShape
  }),
  git_log: z.object({
    commits: z.array(gitCommitSchema),
    truncated: z.boolean()
  })
} satisfies Record<string, z.ZodType>;

export type ToolName = keyof typeof resultSchemas;

export type ToolData<Name extends ToolName> = z.output<(typeof resultSchemas)[Name]>;
