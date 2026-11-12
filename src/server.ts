import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getNavigationTools, DOMAINS } from './domains/navigation.js';
import { getDomainHandler } from './domains/index.js';
import { getCredentials } from './utils/client.js';
import { logger } from './utils/logger.js';
import type { DomainName } from './utils/types.js';
import { registerPromptHandlers } from './prompts.js';
import { isAllowedTool, readOnlyRefusalText, effectiveWriteMode, allowWritesForRequest } from './utils/readOnly.js';

export interface CreateServerOptions {
  /** Per-request write decision. Defaults to the env mode (stdio: 'on' only). */
  allowWrites?: boolean;
}

export function createServer(options: CreateServerOptions = {}): Server {
  const allowWrites =
    options.allowWrites ?? allowWritesForRequest(effectiveWriteMode('stdio', false), undefined);
  const server = new Server(
    { name: 'saas-alerts-mcp', version: '1.2.9-itsl1' },
    { capabilities: { tools: {}, logging: {}, prompts: {} } }
  );

  registerPromptHandlers(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = [...getNavigationTools()];
    for (const domain of DOMAINS) {
      const handler = await getDomainHandler(domain);
      allTools.push(...handler.getTools());
    }
    return { tools: allTools.filter(t => isAllowedTool(t, allowWrites)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    // Second-layer read-only guard: resolve the tool object by name and refuse
    // BEFORE any handler (and so any SaaS Alerts client call) runs.
    const known = [...getNavigationTools()];
    for (const domain of DOMAINS) {
      known.push(...(await getDomainHandler(domain)).getTools());
    }
    const tool = known.find(t => t.name === name);
    if (tool && !isAllowedTool(tool, allowWrites)) {
      logger.warn('Refused tool call: read-only mode', { tool: name });
      return {
        content: [{ type: 'text' as const, text: readOnlyRefusalText(name) }],
        isError: true,
      };
    }

    if (name === 'saas_alerts_navigate') {
      const domain = (args?.domain as string) as DomainName;
      if (!DOMAINS.includes(domain)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid domain: ${domain}. Valid: ${DOMAINS.join(', ')}` }],
          isError: true,
        };
      }
      const handler = await getDomainHandler(domain);
      const tools = handler.getTools().filter(t => isAllowedTool(t, allowWrites)).map(t => `${t.name}: ${t.description}`);
      return {
        content: [{ type: 'text' as const, text: `Domain: ${domain}\n\nAvailable tools:\n${tools.join('\n')}` }],
      };
    }

    if (name === 'saas_alerts_status') {
      const creds = getCredentials();
      if (!creds) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ connected: false, domains: DOMAINS, status: 'No credentials configured. Set SAAS_ALERTS_API_KEY.' }, null, 2),
          }],
        };
      }
      try {
        const { getClient } = await import('./utils/client.js');
        const me = await getClient().users.getMspUser();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ connected: true, mspUser: me, domains: DOMAINS, status: 'Connected. Call conduit__my_access to see which tools you can use under the gateway, or saas_alerts_navigate to browse tools by domain when running standalone.' }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ connected: false, domains: DOMAINS, status: `Connectivity check failed: ${(error as Error).message}` }, null, 2),
          }],
          isError: true,
        };
      }
    }

    for (const domain of DOMAINS) {
      const handler = await getDomainHandler(domain);
      if (handler.getTools().some(t => t.name === name)) {
        try {
          const handlerExtra = { ...(extra as object), server };
          return await handler.handleCall(name, (args || {}) as Record<string, unknown>, handlerExtra);
        } catch (error) {
          logger.error('Tool call failed', { tool: name, error: (error as Error).message });
          return {
            content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}. Call conduit__my_access to see which tools you can use under the gateway, or saas_alerts_navigate to browse available tools when running standalone.` }],
      isError: true,
    };
  });

  return server;
}
