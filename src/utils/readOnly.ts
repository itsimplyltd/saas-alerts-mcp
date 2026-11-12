import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

/**
 * IT Simply fork: fail-closed read-only mode.
 *
 * Read-only is the DEFAULT. Writes are enabled only when
 * SAAS_ALERTS_ALLOW_WRITES is exactly the string 'true'. The decision is made
 * from each tool's own `annotations.readOnlyHint` (never a name list), and is
 * read at call time so it cannot go stale.
 */
export function isReadOnlyMode(): boolean {
  return process.env.SAAS_ALERTS_ALLOW_WRITES !== 'true';
}

/** Strict `=== true`: a tool with no annotation is treated as a write and refused. */
export function isAllowedTool(tool: Pick<Tool, 'annotations'>): boolean {
  return !isReadOnlyMode() || tool.annotations?.readOnlyHint === true;
}

export function readOnlyRefusalText(name: string): string {
  return `Tool ${name} is disabled: this server runs in read-only mode (set SAAS_ALERTS_ALLOW_WRITES=true to enable writes).`;
}

export function logReadOnlyStartup(): void {
  logger.info(
    isReadOnlyMode()
      ? 'Read-only mode ON: write tools are disabled (set SAAS_ALERTS_ALLOW_WRITES=true to enable)'
      : 'Read-only mode OFF: write tools are enabled (SAAS_ALERTS_ALLOW_WRITES=true)'
  );
}
