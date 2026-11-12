/**
 * IT Simply fork: fail-closed read-only mode (second layer behind the gateway).
 *
 * The 22-name list below is a deliberate tripwire: when an upstream sync adds
 * or renames a tool, this test fails and forces a conscious review of whether
 * the new tool is a read or a write.
 */
import { createHmac } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../server.js';
import { isAllowedTool, getWriteMode } from '../utils/readOnly.js';

const getClientSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/client.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/client.js')>('../utils/client.js');
  return {
    ...actual,
    getCredentials: () => ({ apiKey: 'test-key' }),
    getClient: (...args: unknown[]) => {
      getClientSpy(...args);
      throw new Error('network disabled in test');
    },
  };
});

const READ_ONLY_TOOLS = [
  'saas_alerts_billing_get_details',
  'saas_alerts_billing_list_dates',
  'saas_alerts_customers_get',
  'saas_alerts_customers_list',
  'saas_alerts_devices_list_ignored',
  'saas_alerts_devices_list_mapped',
  'saas_alerts_devices_list_orgs',
  'saas_alerts_devices_list_unmapped',
  'saas_alerts_events_count',
  'saas_alerts_events_count_advanced',
  'saas_alerts_events_query',
  'saas_alerts_events_query_advanced',
  'saas_alerts_events_scroll',
  'saas_alerts_navigate',
  'saas_alerts_partner_get_profile',
  'saas_alerts_recommended_actions',
  'saas_alerts_reports_get_scheduled',
  'saas_alerts_reports_list_scheduled',
  'saas_alerts_status',
  'saas_alerts_users_get_msp',
  'saas_alerts_users_list_by_customer',
  'saas_alerts_users_list_partner',
];

const WRITE_TOOLS = [
  'saas_alerts_customers_create',
  'saas_alerts_customers_delete',
  'saas_alerts_customers_set_account_whitelists',
  'saas_alerts_customers_set_whitelists',
  'saas_alerts_customers_update',
  'saas_alerts_partner_update_branding',
  'saas_alerts_reports_create_scheduled',
  'saas_alerts_reports_delete_scheduled',
];

const originalValue = process.env.SAAS_ALERTS_WRITE_MODE;

async function connect(options?: { allowWrites?: boolean }): Promise<Client> {
  const server = createServer(options);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function listNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map(t => t.name).sort();
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map(c => c.text).join('\n');
}

function bare(annotations?: Tool['annotations']): Tool {
  return { name: 'x', inputSchema: { type: 'object' }, annotations } as Tool;
}

beforeEach(() => {
  delete process.env.SAAS_ALERTS_WRITE_MODE;
  getClientSpy.mockClear();
});

afterEach(() => {
  if (originalValue === undefined) delete process.env.SAAS_ALERTS_WRITE_MODE;
  else process.env.SAAS_ALERTS_WRITE_MODE = originalValue;
  vi.restoreAllMocks();
});

describe('read-only mode (default)', () => {
  it('tools/list returns exactly the 22 read-only tools', async () => {
    const names = await listNames(await connect());
    expect(names).toHaveLength(22);
    expect(names).toEqual([...READ_ONLY_TOOLS].sort());
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
  });

  it.each(WRITE_TOOLS)('refuses %s without touching the SaaS Alerts client', async (name) => {
    const client = await connect();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await client.callTool({ name, arguments: { customerId: 'x', id: 'x', name: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Tool ${name} is disabled: this server is in read-only mode for this request.`
    );
    expect(getClientSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.some(c => String(c[0]).includes('[WARN]') && String(c[0]).includes(name))).toBe(true);
  });

  it('still dispatches read tools (reaches the client)', async () => {
    const client = await connect();
    await client.callTool({ name: 'saas_alerts_customers_list', arguments: {} });
    expect(getClientSpy).toHaveBeenCalled();
  });

  it('unknown tools keep the existing unknown-tool response', async () => {
    const result = await (await connect()).callTool({ name: 'saas_alerts_nope', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool: saas_alerts_nope');
  });

  it.each(['customers', 'partner', 'reports'])('navigate %s does not list write tools', async (domain) => {
    const result = await (await connect()).callTool({ name: 'saas_alerts_navigate', arguments: { domain } });
    const text = textOf(result);
    for (const w of WRITE_TOOLS) expect(text).not.toContain(w);
  });

  it('refuses a tool object with no readOnlyHint', () => {
    expect(isAllowedTool(bare(), false)).toBe(false);
    expect(isAllowedTool(bare({}), false)).toBe(false);
    expect(isAllowedTool(bare({ readOnlyHint: false }), false)).toBe(false);
    expect(isAllowedTool(bare({ readOnlyHint: true }), false)).toBe(true);
  });
});

describe('SAAS_ALERTS_WRITE_MODE (stdio / in-process default)', () => {
  it('on lists all 30 tools and navigate shows the write tools', async () => {
    process.env.SAAS_ALERTS_WRITE_MODE = 'on';
    expect(getWriteMode()).toBe('on');
    const client = await connect();
    const names = await listNames(client);
    expect(names).toHaveLength(30);
    expect(names).toEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort());
    const nav = await client.callTool({ name: 'saas_alerts_navigate', arguments: { domain: 'customers' } });
    expect(textOf(nav)).toContain('saas_alerts_customers_create');
  });

  it('off lists 22', async () => {
    process.env.SAAS_ALERTS_WRITE_MODE = 'off';
    expect(await listNames(await connect())).toHaveLength(22);
  });

  it('per-request without an HTTP/S2S context fails closed to read-only', async () => {
    process.env.SAAS_ALERTS_WRITE_MODE = 'per-request';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await listNames(await connect())).toHaveLength(22);
  });

  it.each(['1', 'true', 'ON', 'On', 'PER-REQUEST', 'per_request', 'yes', '', ' on', 'write'])(
    '%j is invalid and keeps read-only on',
    async (value) => {
      process.env.SAAS_ALERTS_WRITE_MODE = value;
      expect(getWriteMode()).toBe('off');
      expect(await listNames(await connect())).toHaveLength(22);
    }
  );

  it('createServer({ allowWrites }) overrides per request', async () => {
    expect(await listNames(await connect({ allowWrites: true }))).toHaveLength(30);
    expect(await listNames(await connect({ allowWrites: false }))).toHaveLength(22);
  });
});

describe('read-only mode over S2S HTTP', () => {
  const SECRET = 'test-readonly-s2s-secret-do-not-use-in-prod';
  const keys = [
    'MCP_TRANSPORT', 'AUTH_MODE', 'MCP_HTTP_PORT', 'MCP_HTTP_HOST', 'CONDUIT_S2S_SECRET',
    'MCP_ALLOW_INSECURE_DEV', 'LOG_LEVEL',
  ];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let httpServer: HttpServer | undefined;

  afterEach(async () => {
    if (httpServer?.listening) await new Promise(r => httpServer!.close(r));
    httpServer = undefined;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function mint(): string {
    const t = `t=${Math.floor(Date.now() / 1000)}`;
    return `${t},v1=${createHmac('sha256', SECRET).update(t).digest('hex')}`;
  }

  async function start(mode: string | undefined, signed = true): Promise<number> {
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = '0';
    delete process.env.MCP_HTTP_HOST;
    process.env.LOG_LEVEL = 'error';
    if (signed) {
      process.env.CONDUIT_S2S_SECRET = SECRET;
      delete process.env.MCP_ALLOW_INSECURE_DEV;
    } else {
      delete process.env.CONDUIT_S2S_SECRET;
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
    }
    if (mode === undefined) delete process.env.SAAS_ALERTS_WRITE_MODE;
    else process.env.SAAS_ALERTS_WRITE_MODE = mode;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const mod = await import('../http.js');
    httpServer = mod.httpServers[0];
    if (!httpServer.listening) await new Promise<void>(r => httpServer!.once('listening', () => r()));
    log.mockRestore();
    return (httpServer.address() as AddressInfo).port;
  }

  type Rpc = { result: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] } };

  async function rpc(port: number, method: string, params: unknown, tier?: string, signed = true): Promise<Rpc> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-saas-alerts-api-key': 'header-key',
    };
    if (signed) headers['x-gateway-s2s'] = mint();
    if (tier !== undefined) headers['x-saas-alerts-tier'] = tier;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Rpc;
  }

  const list = async (port: number, tier?: string, signed = true) =>
    ((await rpc(port, 'tools/list', {}, tier, signed)).result.tools ?? []).map(t => t.name);
  const callWrite = (port: number, tier?: string, signed = true) =>
    rpc(port, 'tools/call', { name: 'saas_alerts_customers_delete', arguments: { customerId: 'x' } }, tier, signed);

  it('per-request + signed + tier write: 30 tools and the write call reaches the handler', async () => {
    const port = await start('per-request');
    expect(await list(port, 'write')).toHaveLength(30);
    getClientSpy.mockClear();
    await callWrite(port, 'write');
    expect(getClientSpy).toHaveBeenCalled();
  });

  it.each([undefined, 'Write', 'true', 'read', ''])(
    'per-request + signed + tier %j: 22 tools, write refused, client never called',
    async (tier) => {
      const port = await start('per-request');
      expect(await list(port, tier)).toHaveLength(22);
      const r = await callWrite(port, tier);
      expect(r.result.isError).toBe(true);
      expect(r.result.content?.[0].text).toContain('read-only mode for this request');
      expect(getClientSpy).not.toHaveBeenCalled();
    }
  );

  it('per-request decides per request on the same process', async () => {
    const port = await start('per-request');
    expect(await list(port, 'write')).toHaveLength(30);
    expect(await list(port)).toHaveLength(22);
    expect(await list(port, 'write')).toHaveLength(30);
  });

  it('per-request with S2S disabled (insecure dev) ignores the header', async () => {
    const port = await start('per-request', false);
    expect(await list(port, 'write', false)).toHaveLength(22);
    const r = await callWrite(port, 'write', false);
    expect(r.result.isError).toBe(true);
    expect(getClientSpy).not.toHaveBeenCalled();
  });

  it('on: 30 tools regardless of the header', async () => {
    const port = await start('on');
    expect(await list(port)).toHaveLength(30);
  });

  it.each([undefined, 'off', 'ON', ''])('mode %j: 22 tools even with tier write', async (mode) => {
    const port = await start(mode);
    expect(await list(port, 'write')).toHaveLength(22);
    await callWrite(port, 'write');
    expect(getClientSpy).not.toHaveBeenCalled();
  });
});
