# Repository Guidelines

## Project Structure & Module Organization

- `src/server.ts` starts the listener; `src/http.ts` handles HTTP guards and transport lifecycle.
- `src/tools.ts` registers MCP tools; `src/result-schemas.ts` defines structured outputs.
- `src/security/` centralizes path containment and filtering. `src/services/` implements filesystem, search, and Git inspection.
- `src/config.ts` owns configuration and limits; `src/errors.ts` provides sanitized errors and operation budgets.
- `tests/` contains service, security, and HTTP integration tests, with shared fixtures in `helpers.ts`.
- `dist/` is generated and ignored. There are no UI assets. Read `README.md` and `DESIGN.md` for behavior, decisions, and verification limits.

## Build, Test, and Development Commands

Use Node.js 24 LTS and install Git for Git tests/tools.

- `npm ci`: install locked dependencies.
- `npm run dev -- --root "C:\Projects\my-app"`: run TypeScript directly.
- `npm run build`: compile production code into `dist/`.
- `npm start -- --root "C:\Projects\my-app"`: serve compiled MCP at `http://127.0.0.1:3000/mcp`.
- `npm run typecheck`: check source and test types.
- `npm test`: run all tests through `tsx` and Node's test runner.
- `npm run format` / `npm run format:check`: apply/check Prettier formatting.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports with `.js` suffixes, two-space indentation, single quotes, semicolons, and trailing commas. Let Prettier control formatting; no separate linter is configured. Use camelCase for functions/variables, PascalCase for classes/types, and descriptive lowercase filenames such as `result-schemas.ts`. Preserve snake_case MCP tool names and explicit Zod schemas.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name suites `tests/*.test.ts` with behavior-focused test descriptions. Reuse temporary fixtures and cleanup hooks. Add regression coverage for security changes, including rejected inputs and unchanged project state. Test protocol changes through the HTTP MCP client. No numeric coverage threshold is configured. Before submitting code, run formatting checks, typechecking, build, and tests.

## Commit & Pull Request Guidelines

Existing history uses short descriptive subjects, e.g. `Add an MCP for local files read-only access`; no Conventional Commits requirement is established. Use imperative subjects. PRs should explain the problem, resulting behavior, security implications, and checks run; link relevant issues. Update documentation for tool/configuration changes. Screenshots are unnecessary for this tools-only server.

## Security & Configuration

Preserve read-only scope: never add arbitrary shell execution, writes, or model-selected network access. Route paths through centralized containment and policy checks, including Git outputs. Keep loopback defaults, bounded operations, and sanitized errors. Never log source contents or credentials. Store local settings in ignored `local-project-mcp.config.json` and bearer secrets in `MCP_BEARER_TOKEN`.
