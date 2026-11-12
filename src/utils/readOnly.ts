import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

/**
 * IT Simply fork: fail-closed read-only mode.
 *
 * SAAS_ALERTS_WRITE_MODE (exact, lowercase; anything else, including unset, is 'off'):
 *   off          read-only (default)
 *   on           all tools allowed (standalone use)
 *   per-request  read-only unless the S2S-verified HTTP request carries
 *                X-SaaS-Alerts-Tier: write. Only valid over HTTP with S2S
 *                enforced; otherwise it fails closed to 'off'.
 *
 * Whether a tool is a write is decided from its own annotations.readOnlyHint
 * (never a name list), with a strict === true.
 */
export type WriteMode = 'off' | 'on' | 'per-request';

export const TIER_HEADER = 'x-saas-alerts-tier';
export const TIER_WRITE_VALUE = 'write';

export function getWriteMode(): WriteMode {
  const v = process.env.SAAS_ALERTS_WRITE_MODE;
  return v === 'on' || v === 'per-request' ? v : 'off';
}

/**
 * The mode actually in force. per-request is honoured only over HTTP with S2S
 * enforced; anywhere else it fails closed to 'off'.
 */
export function effectiveWriteMode(transport: 'http' | 'stdio', s2sEnforced: boolean): WriteMode {
  const mode = getWriteMode();
  if (mode === 'per-request' && !(transport === 'http' && s2sEnforced)) {
    logger.error(
      'SAAS_ALERTS_WRITE_MODE=per-request requires HTTP transport with S2S enforced ' +
        '(CONDUIT_S2S_SECRET set, insecure-dev off). Failing closed: treating as off.'
    );
    return 'off';
  }
  return mode;
}

/** Strict `=== true` unless writes are allowed: a missing annotation is refused. */
export function isAllowedTool(tool: Pick<Tool, 'annotations'>, allowWrites: boolean): boolean {
  return allowWrites || tool.annotations?.readOnlyHint === true;
}

/**
 * Per-request decision. `tier` is the raw X-SaaS-Alerts-Tier header value and
 * must only be passed for a request that already passed S2S verification.
 */
export function allowWritesForRequest(mode: WriteMode, tier: string | undefined): boolean {
  if (mode === 'on') return true;
  if (mode === 'per-request') return tier === TIER_WRITE_VALUE;
  return false;
}

export function readOnlyRefusalText(name: string): string {
  return `Tool ${name} is disabled: this server is in read-only mode for this request.`;
}

export function logReadOnlyStartup(mode: WriteMode): void {
  logger.info(
    mode === 'off'
      ? 'Read-only mode ON (SAAS_ALERTS_WRITE_MODE=off): write tools are disabled'
      : mode === 'on'
        ? 'Read-only mode OFF (SAAS_ALERTS_WRITE_MODE=on): write tools are enabled'
        : 'Read-only mode PER-REQUEST: read-only unless the S2S-verified request carries X-SaaS-Alerts-Tier: write'
  );
}
