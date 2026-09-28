import type { Server } from 'node:http';
import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';

const SHUTDOWN_GRACE_MS = 1500;

function registerShutdownHandlers(server: Server, timeoutMs: number): void {
  const shutdown = () => {
    server.close();

    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, timeoutMs + SHUTDOWN_GRACE_MS);

    timer.unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const server = createHttpServer(config);

  server.on('error', () => {
    console.error('Unable to start listener. Check HOST, PORT and permissions.');
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    const host = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.error(`Read-only project MCP listening at http://${host}:${config.port}/mcp`);
  });

  registerShutdownHandlers(server, config.limits.timeoutMs);
}

main().catch(() => {
  console.error(
    'Startup failed. Check --root / PROJECT_ROOT, --config, HOST, PORT and MCP_BEARER_TOKEN.'
  );
  process.exitCode = 1;
});
