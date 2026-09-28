import type { ToolData, ToolName } from '../src/result-schemas.js';
import type { FileService } from '../src/services/filesystem.js';

// Checked by tsc, never executed: these errors must remain compile-time errors.
export function checkResultContracts(
  item: ToolData<'read_files'>['files'][number],
  fs: FileService,
): void {
  if (item.ok) {
    item.text satisfies string;
    // @ts-expect-error Successful reads do not have an error payload.
    item.error;
  } else {
    item.error.code satisfies string;
    // @ts-expect-error Failed reads do not have file text.
    item.text;
  }
  // @ts-expect-error Only registered tool names are allowed.
  'shell' satisfies ToolName;
  // @ts-expect-error A service result must match its advertised MCP shape.
  fs.readFile({ path: 'file' }) satisfies Promise<ToolData<'git_diff'>>;
}
