import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { createMcpServer } from './tools.js';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const REQUEST_BURST = 120;
const TOKEN_REFILL_MS = 500;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function respond(res: ServerResponse, status: number, message: string) {
  if (!res.headersSent)
    res
      .writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      })
      .end(JSON.stringify({ error: message }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('BODY_LIMIT');
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respondToRequestError(res: ServerResponse, error: unknown): void {
  if (error instanceof Error && error.message === 'BODY_LIMIT') {
    respond(res, 413, 'Request body too large');
    return;
  }

  if (error instanceof SyntaxError) {
    respond(res, 400, 'Invalid JSON');
    return;
  }

  respond(res, 500, 'Request failed');
}

function validateRequestOrigin(req: IncomingMessage, res: ServerResponse, config: Config): boolean {
  let hostname: string;

  if (
    !req.headers.host ||
    !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/i.test(req.headers.host)
  ) {
    respond(res, 403, 'Invalid Host');
    return false;
  }

  try {
    hostname = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    respond(res, 403, 'Invalid Host');
    return false;
  }

  if (!['127.0.0.1', 'localhost', '[::1]', ...config.allowedHosts].includes(hostname)) {
    respond(res, 403, 'Host is not allowed');
    return false;
  }

  const origin = req.headers.origin;

  if (origin && !config.allowedOrigins.includes(origin)) {
    respond(res, 403, 'Origin is not allowed');
    return false;
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  return true;
}

function acceptMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: Buffer | undefined
): boolean {
  if (req.url !== '/mcp') {
    respond(res, 404, 'Not found');
    return false;
  }

  if (req.method === 'OPTIONS') {
    res
      .writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id',
        'Access-Control-Expose-Headers': 'MCP-Session-Id'
      })
      .end();

    return false;
  }

  if (expectedToken && !timingSafeEqual(digest(req.headers.authorization ?? ''), expectedToken)) {
    respond(res, 401, 'Bearer authentication required');
    return false;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    respond(res, 405, 'This stateless endpoint accepts POST');
    return false;
  }

  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    respond(res, 415, 'Content-Type must be application/json');
    return false;
  }

  return true;
}

export function createHttpServer(config: Config): Server {
  let active = 0;
  let tokens = REQUEST_BURST;
  let updated = Date.now();

  const expectedToken = config.token ? digest(`Bearer ${config.token}`) : undefined;

  const http = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (!validateRequestOrigin(req, res, config)) return;

    if (!acceptMcpRequest(req, res, expectedToken)) return;

    tokens = Math.min(REQUEST_BURST, tokens + (Date.now() - updated) / TOKEN_REFILL_MS);

    updated = Date.now();

    if (active >= config.limits.concurrency || tokens < 1) {
      res.setHeader('Retry-After', '1');
      respond(res, 429, 'Server busy; retry later');
      return;
    }

    tokens--;
    active++;

    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
      respond(res, 504, 'Request deadline reached');
      req.destroy();
    }, config.limits.timeoutMs + 1000);

    res.once('close', () => controller.abort());

    const server = createMcpServer(config, controller.signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    try {
      const parsed = await readJsonBody(req);

      if (Array.isArray(parsed)) {
        respond(res, 400, 'Batch requests are not supported');
        return;
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      respondToRequestError(res, error);
    } finally {
      clearTimeout(timer);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      active--;
    }
  });

  http.requestTimeout = config.limits.timeoutMs + 2000;
  http.headersTimeout = Math.min(10_000, http.requestTimeout);
  http.keepAliveTimeout = 5000;
  http.maxRequestsPerSocket = 200;

  return http;
}
