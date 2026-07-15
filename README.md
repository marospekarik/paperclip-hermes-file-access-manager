# File Access Manager

A [Paperclip](https://paperclip.ing) plugin that manages the write sandbox of
[Hermes](https://hermes-agent.nousresearch.com)-backed agents from the Paperclip UI.

## What it actually does

Hermes (0.6.x) enforces exactly two filesystem write controls
(`agent/file_safety.py`):

1. **Protected paths** — credential stores (`~/.ssh/`, `~/.aws/`, `.env` files,
   `auth.json`, …) are always write-denied. Not configurable.
2. **`HERMES_WRITE_SAFE_ROOT`** — an optional env var of colon-separated
   directory roots. When set, `write_file`/`patch` operations outside those
   roots are hard-blocked.

Reads are unrestricted, and there is **no** `file_access:` block in Hermes
`config.yaml` — earlier versions of this plugin wrote one, and it was inert.
If your profiles still contain a `file_access:` block, it is safe to delete.

This plugin edits the one line Hermes actually honors:
`HERMES_WRITE_SAFE_ROOT=...` in the profile's `$HERMES_HOME/.env`. All other
`.env` lines (API keys, bot tokens) pass through byte-identically via an
atomic temp-file-plus-rename write. Changes apply the next time the agent's
Hermes process starts.

## UI surfaces

- **Company settings → File Access** — pick any Hermes-backed agent, edit its
  write roots.
- **Agent detail → File Access tab** — the same editor scoped to that agent.

Per-agent profile resolution: the
[hermes-paperclip-adapter](https://github.com/henkey/hermes-paperclip-adapter)
passes extra env through `adapterConfig.env`; agents with
`adapterConfig.env.HERMES_HOME` use that profile, others default to `~/.hermes`.

## Architecture

Built on the official [`@paperclipai/plugin-sdk`](https://www.npmjs.com/package/@paperclipai/plugin-sdk):

```
src/
├── manifest.ts   # PaperclipPluginManifestV1 — two UI slots, three capabilities
├── hermes.ts     # Pure logic: .env line editing, root validation (unit-tested)
├── worker.ts     # definePlugin: data/actions bridge handlers
└── ui/index.tsx  # React components using SDK hooks (usePluginData/usePluginAction)
tests/            # bun test — hermes core + worker via createTestHarness
build.ts          # Bun.build per the SDK bundler contract
```

The UI talks to the worker over the SDK bridge (`usePluginData` /
`usePluginAction`) — the plugin registers no HTTP API routes.

## Build & test

```bash
bun install
bun run build       # dist/worker.js, dist/manifest.js, dist/ui/index.js
bun run typecheck
bun test
```

## Install into Paperclip

```bash
export PAPERCLIP_API_KEY="<board api key with instance_admin>"
bash install-plugin.sh
```

Or via the API directly:

```bash
curl -X POST "$PAPERCLIP_API_BASE/plugins/install" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/file-access-manager","isLocalPath":true}'
```

## Requirements

- Bun (build/test) — the worker itself runs under the host's node runtime
- Paperclip host `2026.609.0` (SDK version is pinned to match)
- Hermes profiles at `$HERMES_HOME` (default `~/.hermes`)

## License

MIT
