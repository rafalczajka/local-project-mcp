# Local Project MCP

Read-only MCP server for secure access to local project files. Inspect structure, read selected source ranges, search text, and review Git changes.

> [!WARNING]  
> This project was mostly vibe-coded. It is designed to be read-only, which limits the risk, but you should still review the code before using it with sensitive projects or files.

## Requirements and quick start

- Node.js 24 or newer.
- Git on `PATH` for Git tools.

```sh
npm ci
npm run build
npm start -- --root /absolute/path/to/your/project
```

## Tools and outputs

| Tool           | Arguments                                                            | Result                                                     |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `project_tree` | `path?`, `depth?`, `includeHidden?`                                  | Typed entries, omitted count, truncation; default depth 2  |
| `read_file`    | `path`, `startLine?`, `endLine?`                                     | Numbered UTF-8 text, actual range, total lines, truncation |
| `read_files`   | `files: [{path, startLine?, endLine?}]`                              | Ordered independent results/errors with shared byte budget |
| `find_files`   | `pattern`, `path?`, `maxResults?`                                    | Matching relative filenames and truncation                 |
| `search_text`  | `query`, `path?`, `glob?`, `regex?`, `caseSensitive?`, `maxResults?` | Path, 1-based line, excerpt, skipped/truncation metadata   |
| `file_info`    | `path`                                                               | Type, size, modification time, extension, binary status    |
| `git_status`   | none                                                                 | Filtered two-column Git status and relative paths          |
| `git_diff`     | `path?`, `staged?`                                                   | Filtered unstaged/staged patch, omitted count, truncation  |
| `git_log`      | `path?`, `limit?`                                                    | Hash, author, ISO date, subject; default 10, maximum 50    |

Globs match **project-relative paths**, even when `path` narrows traversal: `**/*auth*`, `src/**/*.ts`, `**/package.json`. Simple `*`, `**`, `?` and character classes work; braces and extglobs are rejected. Text search defaults to literal, case-insensitive matching. [RE2 regex syntax](https://github.com/google/re2-wasm) excludes lookaround and backreferences. Results contain one match per line, with at most 500 UTF-8 bytes around its first match.

## Configuration

| CLI        | Environment        | Default        |
| ---------- | ------------------ | -------------- |
| `--root`   | `PROJECT_ROOT`     | Required       |
| `--host`   | `HOST`             | `127.0.0.1`    |
| `--port`   | `PORT`             | `3000`         |
| `--config` | —                  | No config file |
| —          | `MCP_BEARER_TOKEN` | Unset          |

Use `--config config.example.json`. You can create your own config file. Don't forget to add it to `.gitignore`.

| JSON limit key  | Default                                                              |
| --------------- | -------------------------------------------------------------------- |
| `fileBytes`     | 2 MiB input per file                                                 |
| `readBytes`     | 64 KiB numbered text per file                                        |
| `batchBytes`    | 256 KiB combined numbered text                                       |
| `batchFiles`    | 10                                                                   |
| `searchResults` | 100; also maximum find results                                       |
| `treeEntries`   | 500                                                                  |
| `treeDepth`     | 6 maximum (requested default 2)                                      |
| `gitBytes`      | 128 KiB per subprocess output / combined patch                       |
| `timeoutMs`     | 10,000 per operation; HTTP allows 1,000 ms extra                     |
| `scanEntries`   | 20,000 per traversal / Git metadata validation                       |
| `scanBytes`     | 32 MiB searched text, checked after each bounded file read           |
| `outputBytes`   | 1 MiB serialized result, including text + structured representations |
| `concurrency`   | 4 HTTP requests                                                      |

## Tests and MCP Inspector

```sh
npm run format:check
npm run typecheck
npm run build
npm test
```

With the server running:

```sh
npx @modelcontextprotocol/inspector@latest
```

See [official Inspector documentation](https://modelcontextprotocol.io/docs/tools/inspector) for current options.

## Connect ChatGPT using Secure MCP Tunnel

Follow the [current OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The tunnel keeps the local listener private and connects outbound. The **separate tunnel client** needs a runtime credential; this MCP server needs no OpenAI key.
