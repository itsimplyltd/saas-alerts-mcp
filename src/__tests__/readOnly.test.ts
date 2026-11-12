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
import { isAllowedTool, isReadOnlyMode } from '../utils/readOnly.js';

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

const originalValue = process.env.SAAS_ALERTS_ALLOW_WRITES;

async function connect(): Promise<Client> {
  const server = createServer();
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
  delete process.env.SAAS_ALERTS_ALLOW_WRITES;
  getClientSpy.mockClear();
});

afterEach(() => {
  if (originalValue === undefined) delete process.env.SAAS_ALERTS_ALLOW_WRITES;
  else process.env.SAAS_ALERTS_ALLOW_WRITES = originalValue;
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
      `Tool ${name} is disabled: this server runs in read-only mode (set SAAS_ALERTS_ALLOW_WRITES=true to enable writes).`
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
    expect(isAllowedTool(bare())).toBe(false);
    expect(isAllowedTool(bare({}))).toBe(false);
    expect(isAllowedTool(bare({ readOnlyHint: false }))).toBe(false);
    expect(isAllowedTool(bare({ readOnlyHint: true }))).toBe(true);
  });
});

describe('SAAS_ALERTS_ALLOW_WRITES', () => {
  it('true lists all 30 tools and navigate shows the write tools', async () => {
    process.env.SAAS_ALERTS_ALLOW_WRITES = 'true';
    expect(isReadOnlyMode()).toBe(false);
    const client = await connect();
    const names = await listNames(client);
    expect(names).toHaveLength(30);
    expect(names).toEqual([...READ_ONLY_TOOLS, ...WRITE_TOOLS].sort());
    const nav = await client.callTool({ name: 'saas_alerts_navigate', arguments: { domain: 'customers' } });
    expect(textOf(nav)).toContain('saas_alerts_customers_create');
    expect(isAllowedTool(bare())).toBe(true);
  });

  it.each(['1', 'TRUE', 'True', 'yes', '', ' true', 'false'])('%j keeps read-only on', async (value) => {
    process.env.SAAS_ALERTS_ALLOW_WRITES = value;
    expect(isReadOnlyMode()).toBe(true);
    expect(await listNames(await connect())).toHaveLength(22);
  });
});

describe('read-only mode over signed HTTP (S2S)', () => {
  const SECRET = 'test-readonly-s2s-secret-do-not-use-in-prod';
  const keys = ['MCP_TRANSPORT', 'AUTH_MODE', 'MCP_HTTP_PORT', 'MCP_HTTP_HOST', 'CONDUIT_S2S_SECRET', 'LOG_LEVEL'];
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

  it('a correctly signed tools/call for a write tool is still refused', async () => {
    process.env.MCP_TRANSPORT = 'http';
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_PORT = '0';
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = SECRET;
    process.env.LOG_LEVEL = 'error';
    vi.resetModules();
    const mod = await import('../http.js');
    httpServer = mod.httpServers[0];
    if (!httpServer.listening) await new Promise<void>(r => httpServer!.once('listening', () => r()));
    const { port } = httpServer.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'x-gateway-s2s': mint(),
        'x-saas-alerts-api-key': 'header-key',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'saas_alerts_customers_delete', arguments: { customerId: 'x' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('read-only mode');
    expect(body).toContain('"isError":true');
  });
});
