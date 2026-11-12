# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fail-closed read-only mode (IT Simply fork, version `1.2.9-itsl1`). Only
  tools with `annotations.readOnlyHint === true` are listed, shown by
  `saas_alerts_navigate` or callable by default; write tools are refused
  before the SaaS Alerts client is invoked. `SAAS_ALERTS_WRITE_MODE` selects
  `off` (default; any other value means off), `on`, or `per-request`, where
  an S2S-verified HTTP request carrying `X-SaaS-Alerts-Tier: write` gets write
  access for that request only. `per-request` fails closed to `off` without
  HTTP transport and S2S enforcement.

- Response byte budget for compact mode: compacted event responses are now
  capped at `MAX_COMPACT_RESPONSE_CHARS` (40,000 characters as serialized by
  the MCP layer). Over-budget hit lists keep only the first K events that fit
  — response order preserved, all envelope metadata (`hits.total`, `_shards`,
  `_scroll_id`, pagination fields) untouched — and the `note` states how many
  of the fetched events are shown and how to get the rest. Scroll responses
  warn that the server-side cursor has already advanced past trimmed events,
  so the fix is re-querying with a smaller size, not continuing the scroll.
  Per-event compaction alone could not bound total size: production queries
  with `size: 200` returned ~199 KB and `size: 500` ~566 KB, breaking client
  display. `verbose: true` remains a complete bypass (raw, uncapped).

### Changed

- Added `@vitest/coverage-v8` to `devDependencies` (matching the installed
  `vitest@^2` major) so `npm run test:coverage` — run by the `Code Quality` CI
  check — no longer fails with `Cannot find dependency '@vitest/coverage-v8'`.

### Fixed

- **`saas_alerts_status` and the unknown-tool error advised calling
  `saas_alerts_navigate` to discover tools without qualification.** Conduit
  suppresses `*_navigate` / `*_back` at the gateway (tier filtering lives in
  the grant resolver, which the container cannot see) and replaces them with
  `conduit__my_access`, so that advice pointed callers behind the gateway at
  a tool that returns method-not-found. Both strings now point to
  `conduit__my_access` for gateway callers and keep `saas_alerts_navigate` as
  the standalone-mode discovery path. The tool itself is unchanged.
  (WYRE-AI/conduit#1236)
- `/health` liveness endpoint now returns an unconditional `200` instead of `503`
  when no credentials are present. The Azure Container Apps liveness probe calls
  `GET /health` without credentials, so gating the status code on credentials
  caused the probe to fail and ACA to crash-loop the container. Credential
  presence is still reported in the response body (`credentials.configured`).
  The request-scoped credential handling for `/mcp` is unchanged.
