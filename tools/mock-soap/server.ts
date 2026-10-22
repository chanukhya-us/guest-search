/**
 * Local Node mock SOAP server (task 13.1): a zero-Docker stand-in for the real SOAP service
 * so the whole app runs end to end on `npm run dev` / `npm run dev:all`.
 *
 * DEV TOOLING ONLY — never shipped. Plain `node:http`, zero dependencies, erasable TypeScript,
 * so it runs under `node --experimental-strip-types` (Node 22.15+, matching the repo engines).
 *
 *   node --experimental-strip-types tools/mock-soap/server.ts
 *   npm run mock:soap            # from the repo root
 *
 * Behaviour:
 *   - Answers POST to the InitiateService path with content-type text/xml.
 *   - Parses the incoming searchGuestRequest criteria, filters the synthetic seed and returns
 *     a searchGuestResponse the BFF responseParser accepts (see handler.ts).
 *   - Magic demo inputs by surname: "nomatch" (empty), "fault" (SOAP Fault), "boom"/"many"
 *     (all seed guests). See README.md.
 *   - GET /health returns 200 "ok" for quick liveness checks.
 *
 * Config via environment:
 *   MOCK_SOAP_PORT   (default 8080)
 *   MOCK_SOAP_PATH   (default /InitiateService)
 *   MOCK_SOAP_HOST   (default 127.0.0.1)
 *   MOCK_SOAP_MAX_BYTES (default 1048576 — request body cap)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { handleRequest } from './handler.ts';

export interface MockServerOptions {
  port?: number;
  host?: string;
  path?: string;
  maxBytes?: number;
  /** Line logger; defaults to no-op so tests stay quiet. */
  log?: (line: string) => void;
}

const DEFAULTS = {
  port: 8080,
  host: '127.0.0.1',
  path: '/InitiateService',
  maxBytes: 1024 * 1024,
} as const;

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const XML_CT = 'text/xml; charset=utf-8';

/** Build the request listener. Exposed so a test can mount it without binding a socket. */
export function createMockListener(
  options: MockServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const path = options.path ?? DEFAULTS.path;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const log = options.log ?? ((): void => {});

  return (req, res): void => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST' || !url.startsWith(path)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    void readBody(req, maxBytes).then(
      (body) => {
        const result = handleRequest(body);
        const suffix = result.magic === undefined ? '' : ` [magic:${result.magic}]`;
        log(`POST ${url} -> ${result.status} (${result.count} guests)${suffix}`);
        res.writeHead(result.status, { 'content-type': XML_CT });
        res.end(result.xml);
      },
      (err: unknown) => {
        log(`POST ${url} -> 413 (${err instanceof Error ? err.message : 'read error'})`);
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('payload too large');
      },
    );
  };
}

/** Start the server and resolve with the bound address once listening. */
export function startMockServer(
  options: MockServerOptions = {},
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const host = options.host ?? DEFAULTS.host;
  const port = options.port ?? DEFAULTS.port;
  const server = createServer(createMockListener(options));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = addr !== null && typeof addr === 'object' ? addr.port : port;
      resolve({
        server,
        port: boundPort,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

// ---------------------------------------------------------------------------------------
// CLI entry: start only when executed directly (not when imported by a test).

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

if (isMain) {
  const port = envInt('MOCK_SOAP_PORT', DEFAULTS.port);
  const path = process.env.MOCK_SOAP_PATH ?? DEFAULTS.path;
  const host = process.env.MOCK_SOAP_HOST ?? DEFAULTS.host;
  const maxBytes = envInt('MOCK_SOAP_MAX_BYTES', DEFAULTS.maxBytes);
  // Dev tooling CLI logging (the no-console rule applies to the BFF only, not tools/).
  const log = (line: string): void => console.log(`[mock-soap] ${line}`);

  void startMockServer({ port, host, path, maxBytes, log }).then(({ port: bound }) => {
    log(`listening on http://${host}:${bound}${path} (POST searchGuestRequest, GET /health)`);
    log(`magic surnames: "nomatch" (empty), "fault" (SOAP Fault), "boom"/"many" (all guests)`);
  });
}
