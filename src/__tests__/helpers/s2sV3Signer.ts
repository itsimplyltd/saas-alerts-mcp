/**
 * TEST HELPER ONLY. A port of the gateway signer (MCP-Gateway
 * cred-router/src/s2sV3.js at commit 0cadb83, s2sHeaderV3 + canonicalV3), kept
 * independent of the vendored verifier so the two cannot share a bug.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

const INGRESS_EXEMPT_HEADERS = ['x-request-id'];
const sha256hex = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');

export function signV3(
  secret: string,
  p: { aud: string; method: string; path: string; body?: string; headers?: Record<string, string>; t?: number; n?: string },
): string {
  const t = p.t ?? Math.floor(Date.now() / 1000);
  const n = p.n ?? randomBytes(16).toString('hex');
  const entries = Object.entries(p.headers ?? {}).filter(([k]) => !INGRESS_EXEMPT_HEADERS.includes(k.toLowerCase()));
  const names = entries.map(([k]) => k.toLowerCase()).sort();
  const sh = names.join(';');
  const hashes: Record<string, string> = {};
  for (const [k, v] of entries) hashes[k.toLowerCase()] = sha256hex(Buffer.from(v, 'utf8'));
  const lines = [
    'ITSL-S2S-v3',
    `t=${t}`,
    `n=${n}`,
    `aud=${p.aud}`,
    `m=${p.method.toUpperCase()}`,
    `p=${p.path}`,
    `b=${sha256hex(Buffer.from(p.body ?? '', 'utf8'))}`,
    `sh=${sh}`,
    ...names.map((name) => `${name}:${hashes[name]}`),
  ];
  const v3 = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');
  return `t=${t},n=${n},sh=${sh},v3=${v3}`;
}
