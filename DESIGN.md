# Transport and API decisions

Documentation reviewed on 2026-09-27, before implementation:

- [OpenAI: Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [OpenAI: MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [OpenAI: Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI Help: Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [OpenAI: MCP servers](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

Use the current published `@modelcontextprotocol/sdk` package (npm reports 1.30.1), `McpServer.registerTool`, Zod schemas, and the SDK Streamable HTTP transport at `/mcp`. Upstream also documents a newer v2 line with split packages; v1 still receives fixes. We select the maintained v1 package requested here and used by the current OpenAI examples, not legacy SSE. Each HTTP request gets a fresh server/transport with sessions disabled and JSON responses: this application has no subscriptions or per-client mutable state. Close both after the response. No custom UI/resources are needed.

All tools carry `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`. Initialization instructions guide targeted discovery and bounded reads. Return structured results plus a text serialization for compatible clients, with explicit truncation and sanitized errors.

Node.js 24 LTS is the runtime baseline. Prefer Secure MCP Tunnel for private developer-mode connections. Its separate tunnel client requires a control-plane runtime credential; this inspection server does not require or consume an OpenAI API key. ChatGPT UI names and workspace permissions vary; follow the linked current documentation. Generic HTTPS ingress requires operator-provided authentication before exposure.

Security decisions: one canonical project root; reject symlinks (including internal ones), Windows alternate streams/ambiguous paths, hard-linked files, and sensitive paths. Share filtering across filesystem, search, and Git outputs. Use bounded in-process traversal and RE2 regex search to avoid shell execution, rg installation requirements, and backtracking regex denial of service. Git is the only subprocess, with fixed read commands, disabled helpers and optional locks, a restricted environment, and conservative repository validation. The application boundary is not an OS sandbox against a hostile local process racing filesystem changes; use an OS read-only sandbox/snapshot for that threat model.
