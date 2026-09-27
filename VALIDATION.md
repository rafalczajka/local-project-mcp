# Validation record

Validated locally on Windows with Node.js 24.12.0 and Git 2.45.2.windows.1.

- Formatting, strict source/test typechecking, and the production TypeScript build pass.
- All 22 automated tests pass, including calls to all nine tools through real Streamable HTTP.
- The production dependency audit reports zero known vulnerabilities.
- MCP Inspector 2.8.0 CLI discovers the nine read-only tools and their schemas/annotations. Representative `project_tree` and ranged `read_file` calls succeed. Traversal returns the expected structured `INVALID_PATH` / `isError: true` result.
- Inspector strict schema inspection reports zero errors and two portability warnings for nullable `file_info` fields. These are valid JSON Schema/MCP types; the warnings concern clients that translate schemas into other providers' restricted dialects.

Inspector's Windows CLI printed a libuv cleanup assertion after the expected error-case exit; the server returned the correct rejection and remained healthy. Successful Inspector calls exited normally. Automated SDK-client tests independently verify the same rejection.

The ChatGPT account connection and Secure MCP Tunnel were not provisioned or tested: they require the operator's workspace/tunnel permissions and credentials. No endpoint was exposed publicly. Linux/macOS execution has not been verified in this local session.

Security limits and assumptions, including trusted local writers and conservative supported Git configurations, are documented in README.md. This validation is not a claim of a formal security audit or OS-level sandboxing.
