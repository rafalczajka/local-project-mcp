# Local Project MCP

A local-first, read-only MCP server for discussing one software project with ChatGPT. Inspect structure, read selected source ranges, search text, and review Git changes without giving the model a shell or write access.

**Local endpoint: `http://127.0.0.1:3000/mcp`**. No custom UI, OpenAI API dependency, or outbound network tool. Prefer Secure MCP Tunnel when connecting ChatGPT.

## Requirements and quick start

- Node.js 24 or newer.
- Git on `PATH` for Git tools; filesystem/search tools work without Git.
- No ripgrep installation required. Bounded traversal and RE2 WebAssembly provide search without shell execution or backtracking regex denial of service.

```sh
npm ci
npm run build
npm start -- --root /absolute/path/to/your/project
```

`npm install` also works; `npm ci` reproduces the lockfile. On Windows:

```powershell
npm start -- --root "C:\Projects\my-app"
```

Development (TypeScript directly):

```sh
npm run dev -- --root /absolute/path/to/your/project
```

Alternatively set `PROJECT_ROOT` and run `npm start`. The root is required; startup canonicalizes it and verifies it is a directory. Stop with Ctrl+C; active operations have bounded time to finish.

## Tools and outputs

Paths are project-relative. All tools advertise `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`. Results contain `ok` and either `data` or a sanitized `error`, as both MCP structured content and text. Tool errors also set MCP `isError`.

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

No arbitrary revisions, `git_show`, shell, write, network, or package-management tool is exposed.

Globs match **project-relative paths**, even when `path` narrows traversal: `**/*auth*`, `src/**/*.ts`, `**/package.json`. Simple `*`, `**`, `?` and character classes work; braces and extglobs are rejected. Text search defaults to literal, case-insensitive matching. [RE2 regex syntax](https://github.com/google/re2-wasm) excludes lookaround and backreferences. Results contain one match per line, with at most 500 UTF-8 bytes around its first match.

Source lines look like `42 | export const value = 1;`. Empty files and ranges beyond EOF return `endLine: null`. Invalid UTF-8 and NUL-containing files are classified as binary. Oversized input files are rejected; allowed files can have their numbered output truncated, including a partial final line. `file_info.binary` is `null` when unchecked (directories/oversized files).

Returned tree entries are sorted. `omitted` counts encountered excluded/inaccessible entries, not every descendant of an excluded directory. Depth limits conservatively indicate truncation when a directory is not descended into. Search/find stop at 64 directory levels. Narrow the path after truncation; `TIMEOUT` and `OUTPUT_LIMIT` return structured errors instead of incomplete JSON.

## Security model

The authorized MCP client receives source-code contents. **Scope `PROJECT_ROOT` narrowly; never point it at your home directory.** Sensitive-file filtering is defense in depth, not a replacement for a safe root.

- Component-based canonical containment avoids `/project` versus `/project-other` prefix bugs.
- Reject absolute paths, traversal, controls/NUL, Windows alternate streams, device names, trailing-dot/space aliases and short-name (`~`) aliases.
- Reject **all symlinks/junctions**, including internal ones, and hard-linked files. Open regular files read-only; use `O_NOFOLLOW` where supported, compare file identities and recheck containment before reading.
- Share centralized policy across reads, metadata, discovery, searches and returned Git paths/patches. MCP inputs cannot disable exclusions.
- Git is the only subprocess: resolved installed executable, fixed argument arrays, no shell, minimal environment, literal pathspecs, optional locks disabled, helpers disabled, and no lazy fetching/network protocols.
- Bound requests, concurrency, rate, time, traversal, file reads and output. Bodies: 32 KiB; headers: 8 KiB. Global rate bucket: burst 120, refill two requests/second.
- Bind to loopback by default; validate Host headers against loopback names and explicit additions. Reject browser Origins unless explicitly allowlisted. No wildcard CORS.
- Do not log contents, secrets, client arguments, filesystem errors, Git stderr or tool results. Startup logs only the listener URL or a generic configuration error.

This is an **application containment boundary**, not a kernel sandbox. A hostile local writer can race validation and opens, swap mounts, or corrupt repository metadata. Portable Node APIs cannot eliminate every such race. Use a stable snapshot and OS-enforced read-only filesystem/network isolation for that threat model. Do not run as administrator/root. Ordinary concurrent edits may cause retryable errors or a mixed-time view.

The server performs no project writes. Operator installation/build and tests create files in this server repository or temporary fixtures, never through MCP tools. Node/Git need their installed runtime files outside the root, but model-selected paths cannot read them.

Treat returned source and commit messages as data, not instructions: they can contain prompt injection. A filename policy cannot detect credentials embedded in normal source, copied to allowed files, or included in commit metadata. Logs return project history metadata unless narrowed to a path.

## Sensitive paths and ignore rules

Built-ins in `src/security/policy.ts` match case-insensitively, including ancestor components:

```text
.env  .env.*  *.pem  *.key  *.p12  *.pfx
id_rsa*  id_ed25519*  id_dsa*  id_ecdsa*
credentials  credentials.*  secrets  secrets.*
.ssh  .aws  .gnupg  .git  .hg  .svn  .npmrc  .netrc  .pypirc
```

This also denies `.env.example`. Configuration can add sensitive globs, not remove built-ins. Additional patterns match basenames or root-relative prefixes, e.g. `*.token`, `private/**`.

Root/nested `.gitignore` files are evaluated per operation, including negations and ignored-parent behavior. They apply to **explicit reads and Git output**, even for tracked files. Global excludes and `.git/info/exclude` are not imported into filesystem policy. Ignore files above the root are never read. Linked, inaccessible or oversized ignore files fail closed; each is capped at 64 KiB.

Default exclusions: `node_modules/`, `vendor/`, `dist/`, `build/`, `coverage/`, `.next/`, `.cache/`, `target/`. The config `ignore` array **replaces** these defaults; `[]` disables them. `respectGitignore: false` disables `.gitignore` filtering. Neither setting disables containment or sensitive filtering. `includeHidden` cannot bypass policy.

## Git scope

The root must contain its own ordinary `.git` directory. Parent repository discovery, linked worktrees, submodule roots (`.git` pointer files), bare repositories, shallow/partial clones, alternate object stores, and linked Git metadata are rejected. Submodule patches are omitted.

Before invoking Git, bounded metadata validation and a conservative config parser reject unsafe/unsupported layouts. Supported config sections and keys:

- `core`: `repositoryformatversion`, `filemode`, `bare`, `logallrefupdates`, `symlinks`, `ignorecase`, `precomposeunicode`, `autocrlf`, `eol`, `safecrlf`, `quotepath`, `longpaths`.
- `user`: `name`, `email`, `signingkey`.
- `remote`: `url`, `pushurl`, `fetch`.
- `branch`: `remote`, `merge`, `vscode-merge-base`.

Other settings, includes, continuation syntax, filters and fsmonitor configuration return `UNSAFE_REPOSITORY`. The server never edits Git config. Filesystem/search remain available. For Git inspection, use a separate ordinary checkout with standard config; local clones with hardlinked objects need a non-hardlinked checkout. Keep Git patched.

Diffs disable rename detection and filter paths before obtaining patches, including deleted paths; symlink/submodule modes are omitted. This prevents a denied historical source from appearing through rename detection. Binary notices may appear, not binary contents. Logs return metadata only. Unborn history may return `GIT_FAILED`. Untracked status entries come from the server's contained walker, not Git's nested-repository discovery; global Git excludes are therefore not applied to those entries.

## Configuration and limits

CLI overrides the corresponding environment setting:

| CLI        | Environment        | Default        |
| ---------- | ------------------ | -------------- |
| `--root`   | `PROJECT_ROOT`     | Required       |
| `--host`   | `HOST`             | `127.0.0.1`    |
| `--port`   | `PORT`             | `3000`         |
| `--config` | —                  | No config file |
| —          | `MCP_BEARER_TOKEN` | Unset          |

Use `--config config.example.json` for the example. Machine settings can go in gitignored `local-project-mcp.config.json`. Unknown fields/invalid limits fail startup. Restart after config changes. Never put credentials in project configuration.

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

Limits are positive integers under `limits` (`outputBytes` has a minimum of 1 KiB). Raising them increases resource exposure. Text limits measure UTF-8 bytes; both layers of JSON escaping and metadata count toward the final cap.

`allowedHosts` adds exact hostnames without ports/schemes; it does not enable remote binding. `allowedOrigins` adds exact browser origins with port. Inspector direct-browser mode may require `http://localhost:6274`; its proxy mode normally sends no Origin.

For optional local authentication set `MCP_BEARER_TOKEN` to a random secret of at least 32 characters. Clients send `Authorization: Bearer <token>` on every MCP request. Non-loopback binding requires a token and appropriate allowed hostname. Static bearer mode is **not an OAuth server** and does not implement ChatGPT OAuth discovery.

## Tests and MCP Inspector

```sh
npm run format:check
npm run typecheck
npm run build
npm test
```

Tests use temporary fixtures, real Git repositories and actual HTTP MCP calls. They cover traversal, prefix confusion, junction escapes, hardlinks, secrets, ignore rules, ranges, large/binary files, bounds, regex search, Git filtering/index immutability, discovery, schemas, Host/Origin checks and bearer authentication.

With the server running:

```sh
npx @modelcontextprotocol/inspector@latest
```

Select **Streamable HTTP** and `http://127.0.0.1:3000/mcp`. Review instructions, tools, schemas and annotations. Call `project_tree`, read a source file, then attempt `read_file` with `../outside` (must fail). Configure the bearer header if enabled. An address-bar `GET /mcp` returns 405 by design: this is a stateless MCP POST endpoint.

CLI checks:

```sh
npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector@latest --cli http://127.0.0.1:3000/mcp --transport http --method tools/call --tool-name project_tree --tool-arg depth=1
```

See [official Inspector documentation](https://modelcontextprotocol.io/docs/tools/inspector) for current options.

## Connect ChatGPT using Secure MCP Tunnel

Follow the [current OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The tunnel keeps the local listener private and connects outbound. The **separate tunnel client** needs a runtime credential; this MCP server needs no OpenAI key.

1. Run and validate this server locally.
2. Create/select a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), associate the target ChatGPT workspace, and download its supported client or the [official latest release](https://github.com/openai/tunnel-client/releases/latest).
3. In a separate terminal run `tunnel-client help quickstart`. Set its `CONTROL_PLANE_API_KEY` through your normal secret-management method, outside this repository.
4. Configure the private HTTP target, run diagnostics and keep the client running. The [official onboarding guide](https://github.com/openai/tunnel-client/blob/main/docs/onboarding.md) provides the HTTP profile pattern:

```sh
tunnel-client init --sample sample_mcp_remote_no_auth --profile local-project --tunnel-id tunnel_YOUR_ID --mcp-server-url http://127.0.0.1:3000/mcp
tunnel-client doctor --profile local-project --explain
tunnel-client run --profile local-project
```

The sample assumes no local bearer token: remote access is authorized by the tunnel, while trusted local processes can access loopback. With local bearer auth enabled, arrange the Authorization header using supported tunnel/app configuration and verify discovery. Keep both processes running.

5. Enable developer mode and use **Create MCP App** / **Apps → Create**, or the **Plugins +** entry point in current docs. Choose **Tunnel**, select/paste its ID, review tools and create the connection. Select it in a new chat.

UI names and workspace permissions vary; follow the [Developer mode Help Center article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Creating tunnels requires Platform Read + Manage; running/using them requires Read + Use. ChatGPT developer permission is separate. Missing tunnel: check workspace association and permissions. Failed discovery: check client readiness and `doctor`. Refresh the app after tool metadata changes.

## Alternative HTTPS tunnel for development

Keep the server on loopback and put a trusted HTTPS tunnel/proxy in front. Provide its HTTPS URL ending in `/mcp` in ChatGPT's app-creation flow. Configure authentication supported by your workspace **before forwarding private source**—for example an OAuth-capable gateway. This project does not implement OAuth. Static bearer headers work only where the client connection supports them.

The proxy must preserve MCP headers/responses and either rewrite Host to `127.0.0.1:3000` or have its exact hostname added to `allowedHosts`. For disposable non-sensitive fixtures, `ngrok http 3000` provides a development endpoint; configure its hostname/Host rewriting and use its HTTPS `/mcp` URL. Reachability alone is not authorization. Do not publicly expose a no-auth source endpoint. Prefer Secure MCP Tunnel over unnecessary public exposure. A temporary tunnel/local endpoint is not a public plugin submission deployment.

## Example prompts

- Inspect the project structure and explain how authentication is implemented.
- Review my current uncommitted changes and point out potential problems.
- Find where UserSession is created and explain the data flow.
- Compare the implementation in src/auth with the tests and tell me which cases are not covered.

## Architecture and API decisions

`src/http.ts` owns HTTP guards and SDK lifecycle; `src/tools.ts` owns MCP schemas/metadata; `src/config.ts` centralizes settings/limits. `src/security/` handles paths/policy and `src/services/` handles inspection. Tests exercise services and the real HTTP transport.

Each request gets a fresh `McpServer` and `StreamableHTTPServerTransport`, sessions disabled and JSON responses. There are no resources, prompts, subscriptions, legacy SSE endpoint or UI. See OpenAI's [server guidance](https://developers.openai.com/plugins/build/mcp-server), [quickstart](https://developers.openai.com/plugins/build/app-quickstart), and [DESIGN.md](DESIGN.md), which records decisions made before coding. ChatGPT/tunnel account setup is an operator step, not performed by `npm start`.
