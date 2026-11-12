# saas-alerts-mcp

Model Context Protocol server for [Kaseya SaaS Alerts](https://saasalerts.com/) — a SaaS security monitoring platform for M365 and Google Workspace events.

Part of the [WYRE Technology MCP fleet](https://github.com/WYRE-AI).

## Features

Exposes the full SaaS Alerts External Partner API (v0.20.0) through 30 MCP tools organized by domain:

| Domain | Tools |
|--------|-------|
| **events** | Query/count security events by severity, customer, user, event type; advanced Elasticsearch queries; scroll pagination; recommended actions |
| **customers** | List, get, create, update, delete customers; set IP/country and account whitelists |
| **users** | MSP user info, partner users, customer users |
| **devices** | Unify mapped/unmapped/ignored devices, device organizations |
| **billing** | Billing details by date, billing date history |
| **reports** | List/get/create/delete scheduled reports |
| **partner** | Partner profile, branding settings |

Write/destructive tools require user confirmation via MCP elicitation (fail-open: proceeds if client doesn't support elicitation).

## Authentication

SaaS Alerts uses an API key sent as the `api_key` HTTP header.

Generate your API key in the SaaS Alerts UI under **Settings → API Keys**.

Copy [`.env.example`](.env.example). Leave `CONDUIT_S2S_SECRET` empty in that file and never commit a real value.

| Variable | Required | Description |
|----------|----------|-------------|
| `SAAS_ALERTS_API_KEY` | For stdio and `AUTH_MODE=env` | SaaS Alerts API key. Gateway mode does not read it. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-SaaS-Alerts-API-Key` on each `/mcp` request and never falls back to `SAAS_ALERTS_API_KEY`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `your-s2s-secret`, and the other example values). Compose will not start when it is unset. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and listens on `127.0.0.1` only. A wider `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden. A placeholder secret is still rejected. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. Without a real secret the listener is forced to `127.0.0.1`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### X-Gateway-S2S signing

With `MCP_TRANSPORT=http` and a real `CONDUIT_S2S_SECRET`, every `/mcp` request must include `X-Gateway-S2S`. A missing or invalid header returns 401 before any vendor credential is read.

The header value is `t=<unix seconds>,v1=<hex hmac-sha256>`:

1. Set `t` to the current unix time in seconds.
2. Sign the ASCII message `t=<unix seconds>` with HMAC-SHA256, using `CONDUIT_S2S_SECRET` as the key.
3. Hex-encode the digest (64 lowercase hex characters) and send `t=<unix seconds>,v1=<hex>`.

The timestamp must be within 300 seconds of the server clock. Example:

```js
import { createHmac } from 'node:crypto';

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', process.env.CONDUIT_S2S_SECRET).update(`t=${t}`).digest('hex');
const xGatewayS2s = `t=${t},v1=${v1}`;
```

### Local / stdio mode

```bash
export SAAS_ALERTS_API_KEY=your-api-key
node dist/index.js
```

### HTTP mode

`CONDUIT_S2S_SECRET` is required. If it is empty, the process logs an error and exits non-zero.

```bash
export CONDUIT_S2S_SECRET="$(openssl rand -hex 32)"
export SAAS_ALERTS_API_KEY=your-api-key
export MCP_TRANSPORT=http
export AUTH_MODE=env
export MCP_HTTP_PORT=8080
node dist/http.js
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` even if `MCP_HTTP_HOST` is `0.0.0.0`, and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

### WYRE Gateway mode

When running behind the WYRE MCP Gateway, set `AUTH_MODE=gateway` (the image and Compose default). The gateway signs each request with `X-Gateway-S2S` and injects the API key via `X-SaaS-Alerts-API-Key`. A request missing that credential header returns 401 and does not use `SAAS_ALERTS_API_KEY` from the environment.

```js
await fetch('http://127.0.0.1:8080/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-gateway-s2s': xGatewayS2s,
    'x-saas-alerts-api-key': apiKey,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
```

## Running with Docker

The image listens on `0.0.0.0` inside the container and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode the SaaS Alerts API key arrives on each request; it is not read from the environment.

```bash
docker build -t saas-alerts-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  saas-alerts-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not pass `SAAS_ALERTS_API_KEY` into the gateway service:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SAAS_ALERTS_API_KEY`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SAAS_ALERTS_API_KEY=your-key \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/saas-alerts-mcp:latest
```

## Development

```bash
npm install
npm run build
npm test
npm run lint
node scripts/lint-destructive-warnings.mjs src
```

## Read-only mode (IT Simply fork)

This fork is read-only by default. Tools whose `annotations.readOnlyHint` is not exactly `true` (customer create/update/delete/whitelists, partner branding, scheduled report create/delete) are hidden from `tools/list` and `saas_alerts_navigate`, and a direct `tools/call` for one is refused before the SaaS Alerts client is ever invoked.

- Env variable: `SAAS_ALERTS_ALLOW_WRITES`. Writes are enabled only when it is exactly `true`; any other value (`1`, `TRUE`, `yes`, empty, unset) keeps read-only on.
- Why: defence in depth. Our gateway already blocks the write tools with its own allow-list; this is a second, independent layer inside the server. It uses the tools' own annotations, so a new upstream tool without a `readOnlyHint: true` is refused (fails closed) rather than silently exposed.
- The test `src/__tests__/readOnly.test.ts` pins the exact list of read-only tools; an upstream sync that adds or renames a tool will fail it until reviewed.

## Destructive tool confirmation

Tools that permanently delete data (customer delete, scheduled report delete) carry:
- `⚠ DESTRUCTIVE — IRREVERSIBLE` description prefix
- `annotations.destructiveHint: true`
- Elicitation confirmation guard (additive — proceeds if client doesn't support elicitation)

Always confirm with the user before invoking these tools.

## License

Apache-2.0 — see [LICENSE](LICENSE).
