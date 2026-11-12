import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { logReadOnlyStartup, effectiveWriteMode, allowWritesForRequest, TIER_HEADER } from './utils/readOnly.js';
import { runWithCredentials } from './utils/client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader } from './s2s-verify.js';
import { NonceCache, ReportRateLimiter, handleGatewayRequest } from './itsl/s2s-v3.js';

// Conduit service-to-service auth (gateway#377 parity). HTTP startup fails
// closed. An empty CONDUIT_S2S_SECRET refuses to boot unless
// MCP_ALLOW_INSECURE_DEV=1, and that bypass binds 127.0.0.1 only. A known
// placeholder secret always refuses to start. When a real secret is set,
// every /mcp request must carry a valid X-Gateway-S2S header. The secret
// value is never logged.
//
// Public example values. A copied placeholder must not verify as a real secret.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty. ' +
  'An empty secret would accept unauthenticated /mcp requests (CWE-306). ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP server: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. ' +
  'Local development only; do not expose this port.';

const SHORT_S2S_SECRET_ERROR =
  'Refusing to start HTTP server: CONDUIT_S2S_SECRET is shorter than 32 characters. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const MIN_S2S_SECRET_LENGTH = 32;
const S2S_AUDIENCE = 'saas-alerts';

const LOOPBACK_HOST = '127.0.0.1';

/** One per process: v3 nonces are single-use inside the skew window. */
const nonceCache = new NonceCache();
const reportRateLimiter = new ReportRateLimiter();
const failureLimiter = new ReportRateLimiter();

/** Servers started by this module. Tests close them; production uses one. */
export const httpServers: Server[] = [];

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Untrimmed on purpose: the tier header must match exactly. */
function exactHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Fail closed: an empty or placeholder CONDUIT_S2S_SECRET used to skip
 * X-Gateway-S2S checks. Placeholder values always refuse to start. An empty
 * secret refuses unless MCP_ALLOW_INSECURE_DEV=1. Never log the secret.
 */
function resolveHttpS2sSecret(): string {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) {
    if (raw.length < MIN_S2S_SECRET_LENGTH) {
      logger.error(SHORT_S2S_SECRET_ERROR);
      process.exit(1);
    }
    return raw;
  }
  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }
  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No real secret (the insecure-dev bypass) always listens on 127.0.0.1.
 * A configured secret honors MCP_HTTP_HOST, defaulting to 127.0.0.1.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackHost(configured)) {
    logger.error(
      `MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

function startHttpServer(): void {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveListenHost(s2sSecret);
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';
  // S2S is enforced only with a real secret (insecure-dev leaves it empty).
  const writeMode = effectiveWriteMode('http', Boolean(s2sSecret));

  // Operator switch for the S2S v3 rollout. Passed through raw: anything that is
  // not an integer 1..3 is treated as 3 by the verifier (a typo can only tighten).
  const minVersion = Number(process.env.ITSL_S2S_MIN_VERSION ?? '1');

  const httpServer = createHttpServer(async (req, res) => {
    // Raw target, not a parsed URL: the signed path is exactly what was sent.
    const rawTarget = req.url ?? '/';
    const queryAt = rawTarget.indexOf('?');
    const pathname = queryAt === -1 ? rawTarget : rawTarget.slice(0, queryAt);

    // Shallow, unauthenticated liveness probe. Always 200 while the process is
    // up. Must not read credentials: this route is unauthenticated, and gateway
    // mode has no process-level vendor credentials to report.
    if (pathname === '/health' || pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        transport: 'http',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health', '/healthz'] }));
      return;
    }

    // The shared wrapper runs the S2S check FIRST (before method checks or
    // credential extraction), reads the body once, and never rejects: an aborted
    // upload or a throwing handler ends that request, not the process. Empty
    // s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise.
    await handleGatewayRequest(
      req,
      res,
      {
        secret: s2sSecret || undefined,
        // Only the MCP_ALLOW_INSECURE_DEV escape hatch may serve without a secret.
        allowUnauthenticated: !s2sSecret && process.env.MCP_ALLOW_INSECURE_DEV === '1',
        aud: S2S_AUDIENCE,
        floor: 1,
        minVersion,
        verifyLegacy: (headerValue) => (verifyS2sHeader(headerValue, s2sSecret) ? 1 : 0),
        nonceCache,
        reportLimiter: reportRateLimiter,
        failureLimiter,
        logger,
      },
      async ({ version, parsedBody, headerRuleEnforced }) => {
      const apiKey = headerValue(req.headers['x-saas-alerts-api-key']);

      // Gateway mode: the API key must arrive on every request. Reject explicitly
      // if it is missing rather than falling through — falling through would
      // resolve SAAS_ALERTS_API_KEY from the process environment (CWE-306).
      if (isGatewayMode && !apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Unauthorized: missing required gateway credential header X-SaaS-Alerts-API-Key',
        }));
        return;
      }

      const handle = async () => {
        // Tier header is trusted only when this request verified as v3 AND the
        // header rule was enforced (effective minimum 3): only then was the
        // header covered by the signature. Anything else is treated as read.
        const tierTrusted = version === 3 && headerRuleEnforced;
        const allowWrites = allowWritesForRequest(
          writeMode,
          writeMode === 'per-request' && tierTrusted ? exactHeader(req.headers[TIER_HEADER]) : undefined,
        );
        const server = createServer({ allowWrites });
        // SECURITY-CRITICAL invariant: this transport MUST stay stateless
        // (sessionIdGenerator: undefined + enableJsonResponse: true). Per-request
        // tenant credentials are carried in an AsyncLocalStorage context opened by
        // runWithCredentials() below. A stateless request->single-response flow
        // keeps the tool call inside that context. Switching to a stateful/SSE
        // transport (sessionIdGenerator set, persistent stream) would let a
        // long-lived connection serve later messages under a stale/foreign
        // credential context — re-review tenant isolation before changing this.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
      };

      if (isGatewayMode && apiKey) {
        await runWithCredentials({ apiKey }, handle);
      } else {
        await handle();
      }
      },
    );
  });

  httpServers.push(httpServer);
  httpServer.listen(port, host, () => {
    const addr = httpServer.address();
    const bound = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    logger.info(`HTTP streaming server listening on ${bound}`);
    logReadOnlyStartup(writeMode);
  });
}

const transport = process.env.MCP_TRANSPORT;
if (transport === 'http') {
  startHttpServer();
} else {
  import('./index.js');
}
