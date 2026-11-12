/**
 * S2S v3 phase A over a real http server: v1 and v3 are both accepted at
 * ITSL_S2S_MIN_VERSION=1, v3 only at 3, and the tier header is honoured only
 * for a v3 request when the effective minimum is 3.
 */
import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signV3 } from './helpers/s2sV3Signer.js';

const SECRET = 'test-s2s-v3-secret-0123456789abcdef-do-not-use';
const AUD = 'saas-alerts';

const ENV_KEYS = [
  'MCP_TRANSPORT', 'AUTH_MODE', 'MCP_HTTP_PORT', 'MCP_HTTP_HOST', 'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV', 'SAAS_ALERTS_API_KEY', 'SAAS_ALERTS_WRITE_MODE', 'ITSL_S2S_MIN_VERSION', 'LOG_LEVEL',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let httpServer: Server | undefined;

afterEach(async () => {
  if (httpServer?.listening) await new Promise((r) => httpServer!.close(r));
  httpServer = undefined;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

type Seen = { headers: Record<string, unknown>; rawHeaders: string[]; parsedBody: unknown };

/** Starts the server; returns its port and the requests the MCP transport actually received. */
async function start(opts: { min?: string; mode?: string; logLevel?: string } = {}) {
  vi.restoreAllMocks(); // a second start() in one test must not stack spies
  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'env';
  process.env.SAAS_ALERTS_API_KEY = 'env-key';
  process.env.MCP_HTTP_PORT = '0';
  delete process.env.MCP_HTTP_HOST;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  process.env.CONDUIT_S2S_SECRET = SECRET;
  process.env.LOG_LEVEL = opts.logLevel ?? 'error';
  if (opts.min === undefined) delete process.env.ITSL_S2S_MIN_VERSION;
  else process.env.ITSL_S2S_MIN_VERSION = opts.min;
  if (opts.mode === undefined) delete process.env.SAAS_ALERTS_WRITE_MODE;
  else process.env.SAAS_ALERTS_WRITE_MODE = opts.mode;
  const logs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  });
  vi.resetModules();
  const mod = await import('../http.js');
  // Same module registry as http.ts until the next resetModules().
  const sdk = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const seen: Seen[] = [];
  const original = sdk.StreamableHTTPServerTransport.prototype.handleRequest;
  vi.spyOn(sdk.StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementation(function (this: unknown, req, res, parsedBody) {
    seen.push({ headers: { ...req.headers }, rawHeaders: [...req.rawHeaders], parsedBody });
    return original.call(this as never, req, res, parsedBody);
  });
  httpServer = mod.httpServers[0];
  if (!httpServer.listening) await new Promise<void>((r) => httpServer!.once('listening', () => r()));
  return { port: (httpServer.address() as AddressInfo).port, seen, logs };
}

type Resp = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function send(
  port: number,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: string; writeBody?: boolean },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const body = o.body ?? '';
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.method !== 'GET' && !('content-length' in headers)) headers['content-length'] = String(Buffer.byteLength(body));
    const rq = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/mcp', headers, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    rq.on('error', reject);
    if (o.writeBody !== false) rq.write(body);
    if (o.writeBody === false) setTimeout(() => rq.destroy(), 200);
    else rq.end();
  });
}

const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const BASE = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function v1Header(secret = SECRET): string {
  const t = `t=${Math.floor(Date.now() / 1000)}`;
  return `${t},v1=${createHmac('sha256', secret).update(t).digest('hex')}`;
}

/** A request signed as v3. `extra` headers are sent AND signed; `unsigned` are sent only. */
function v3Request(o: { body?: string; method?: string; path?: string; extra?: Record<string, string>; unsigned?: Record<string, string> } = {}) {
  const body = o.body ?? LIST;
  const method = o.method ?? 'POST';
  const path = o.path ?? '/mcp';
  const extra = o.extra ?? {};
  const header = signV3(SECRET, { aud: AUD, method, path, body, headers: extra });
  return { method, path, body, headers: { ...BASE, ...extra, ...(o.unsigned ?? {}), 'x-gateway-s2s': header } };
}

const toolCount = (r: Resp): number => (JSON.parse(r.body) as { result: { tools: unknown[] } }).result.tools.length;

describe('versions and minimum', () => {
  it('accepts legacy v1 at min 1', async () => {
    const { port, logs } = await start({ logLevel: 'debug' });
    const r = await send(port, { headers: { ...BASE, 'x-gateway-s2s': v1Header() }, body: LIST });
    expect(r.status).toBe(200);
    expect(logs.join('\n')).toContain('"version":1');
  });

  it('accepts v3 at min 1 and at min 3', async () => {
    for (const min of ['1', '3']) {
      const { port, logs } = await start({ min, logLevel: 'debug' });
      const r = await send(port, v3Request());
      expect(r.status).toBe(200);
      expect(logs.join('\n')).toContain('"version":3');
      await new Promise((res) => httpServer!.close(res));
    }
  });

  it('refuses legacy v1 at min 3, and treats an invalid minimum as 3', async () => {
    for (const min of ['3', 'abc', '0', '4']) {
      const { port } = await start({ min });
      const r = await send(port, { headers: { ...BASE, 'x-gateway-s2s': v1Header() }, body: LIST });
      expect(r.status).toBe(401);
      await new Promise((res) => httpServer!.close(res));
    }
  });

  it('refuses a missing header and a v1 header signed with the wrong secret', async () => {
    const { port } = await start();
    expect((await send(port, { headers: BASE, body: LIST })).status).toBe(401);
    expect((await send(port, { headers: { ...BASE, 'x-gateway-s2s': v1Header('wrong-secret-0123456789abcdef0123456789') }, body: LIST })).status).toBe(401);
  });

  it('answers 401 with a generic body and logs only the reason', async () => {
    const { port, logs } = await start({ logLevel: 'warn' });
    const r = await send(port, { headers: { ...BASE, 'x-gateway-s2s': 'garbage-value-xyz' }, body: LIST });
    expect(r.status).toBe(401);
    expect(r.body).not.toContain('garbage-value-xyz');
    const text = logs.join('\n');
    expect(text).toContain('"reason"');
    expect(text).not.toContain('garbage-value-xyz');
    expect(text).not.toContain(SECRET);
  });
});

describe('v3 binding', () => {
  it('refuses a tampered body, method or path', async () => {
    const { port } = await start();
    const a = v3Request();
    expect((await send(port, { ...a, body: a.body.replace('tools/list', 'tools/call') })).status).toBe(401);
    const b = v3Request({ method: 'GET', body: '' });
    expect((await send(port, { method: 'POST', headers: b.headers, body: '' })).status).toBe(401);
    const c = v3Request({ path: '/other' });
    expect((await send(port, { headers: c.headers, body: c.body })).status).toBe(401);
  });

  it('refuses a replayed request', async () => {
    const { port, logs } = await start({ logLevel: 'warn' });
    const a = v3Request();
    expect((await send(port, { headers: a.headers, body: a.body })).status).toBe(200);
    expect((await send(port, { headers: a.headers, body: a.body })).status).toBe(401);
    expect(logs.join('\n')).toContain('replay');
  });

  it('refuses /mcp?x=1 even when the query is signed', async () => {
    const { port } = await start();
    const a = v3Request({ path: '/mcp?x=1' });
    expect((await send(port, { path: '/mcp?x=1', headers: a.headers, body: a.body })).status).toBe(401);
  });

  it('answers a signed DELETE with no body without a 401 (empty body means no parsed body)', async () => {
    const { port, seen } = await start();
    const a = v3Request({ method: 'DELETE', body: '' });
    const r = await send(port, { method: 'DELETE', headers: a.headers });
    expect(r.status).not.toBe(401);
    expect(seen[0]?.parsedBody).toBeUndefined();
  });

  it('answers 400 for a signed body that is not JSON', async () => {
    const { port } = await start();
    const a = v3Request({ body: '{not json' });
    expect((await send(port, { headers: a.headers, body: a.body })).status).toBe(400);
  });
});

describe('paths and bodies', () => {
  it('404s unknown paths before any auth, including /mcp/', async () => {
    const { port } = await start();
    for (const path of ['/', '/other', '/mcp/', '/mcp/x']) {
      expect((await send(port, { path, headers: BASE, body: LIST })).status).toBe(404);
    }
  });

  it('serves /health without auth', async () => {
    const { port } = await start();
    expect((await send(port, { method: 'GET', path: '/health' })).status).toBe(200);
  });

  it('answers an oversize body with 413 and Connection: close', async () => {
    const { port } = await start();
    const a = v3Request();
    const r = await send(port, { headers: { ...a.headers, 'content-length': String(6 * 1024 * 1024) }, body: 'x' });
    expect(r.status).toBe(413);
    expect(String(r.headers.connection).toLowerCase()).toBe('close');
  });

  it('answers a gzip content-encoding with 415', async () => {
    const { port } = await start();
    const a = v3Request();
    const r = await send(port, { headers: { ...a.headers, 'content-encoding': 'gzip' }, body: a.body });
    expect(r.status).toBe(415);
  });
});

describe('header rule', () => {
  it('accepts an unsigned x-api-url in report mode at min 1 but refuses it at min 3', async () => {
    const lo = await start({ min: '1', logLevel: 'warn' });
    const a = v3Request({ unsigned: { 'x-api-url': 'https://attacker.invalid' } });
    expect((await send(lo.port, { headers: a.headers, body: a.body })).status).toBe(200);
    const report = lo.logs.join('\n');
    expect(report).toContain('x-api-url');
    expect(report).not.toContain('attacker.invalid');
    await new Promise((res) => httpServer!.close(res));

    const hi = await start({ min: '3' });
    const b = v3Request({ unsigned: { 'x-api-url': 'https://attacker.invalid' } });
    expect((await send(hi.port, { headers: b.headers, body: b.body })).status).toBe(401);
  });

  it('strips x-request-id before the app sees it', async () => {
    const { port, seen } = await start();
    const a = v3Request({ unsigned: { 'x-request-id': 'ingress-rewritten' } });
    expect((await send(port, { headers: a.headers, body: a.body })).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['x-request-id']).toBeUndefined();
    expect(seen[0].rawHeaders.map((h) => h.toLowerCase())).not.toContain('x-request-id');
  });
});

describe('tier header', () => {
  const tier = { 'x-saas-alerts-tier': 'write' };

  it('is ignored at min 1 even on a valid v3 request that signed it', async () => {
    const { port } = await start({ min: '1', mode: 'per-request' });
    const a = v3Request({ extra: tier });
    expect(toolCount(await send(port, { headers: a.headers, body: a.body }))).toBe(22);
  });

  it('is ignored at min 1 on a legacy v1 request', async () => {
    const { port } = await start({ min: '1', mode: 'per-request' });
    const r = await send(port, { headers: { ...BASE, ...tier, 'x-gateway-s2s': v1Header() }, body: LIST });
    expect(toolCount(r)).toBe(22);
  });

  it('is honoured at min 3 when the v3 request signed it', async () => {
    const { port } = await start({ min: '3', mode: 'per-request' });
    const a = v3Request({ extra: tier });
    expect(toolCount(await send(port, { headers: a.headers, body: a.body }))).toBe(30);
  });

  it('is honoured when the minimum is invalid (treated as 3)', async () => {
    const { port } = await start({ min: 'bogus', mode: 'per-request' });
    const a = v3Request({ extra: tier });
    expect(toolCount(await send(port, { headers: a.headers, body: a.body }))).toBe(30);
  });

  it('read tier at min 3 gives the read tools', async () => {
    const { port } = await start({ min: '3', mode: 'per-request' });
    const a = v3Request({ extra: { 'x-saas-alerts-tier': 'read' } });
    expect(toolCount(await send(port, { headers: a.headers, body: a.body }))).toBe(22);
  });

  it('is refused at min 3 when sent but not signed', async () => {
    const { port } = await start({ min: '3', mode: 'per-request' });
    const a = v3Request({ unsigned: tier });
    expect((await send(port, { headers: a.headers, body: a.body })).status).toBe(401);
  });
});

describe('boot', () => {
  it('refuses to start with a secret shorter than 32 characters', async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = '0';
    process.env.CONDUIT_S2S_SECRET = 'a-real-but-short-secret-31-char';
    expect(process.env.CONDUIT_S2S_SECRET).toHaveLength(32 - 1);
    delete process.env.MCP_ALLOW_INSECURE_DEV;
    process.env.LOG_LEVEL = 'error';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 'undefined'}`);
    }) as typeof process.exit);
    vi.resetModules();
    await expect(import('../http.js')).rejects.toThrow('process.exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
