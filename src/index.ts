import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import { logReadOnlyStartup, effectiveWriteMode } from './utils/readOnly.js';

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('SaaS Alerts MCP server started (stdio)');
logReadOnlyStartup(effectiveWriteMode('stdio', false));
