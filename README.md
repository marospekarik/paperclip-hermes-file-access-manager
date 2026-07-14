# File Access Manager

A [Paperclip AI](https://paperclipai.com) plugin that gives administrators a visual UI for managing Hermes `file_access` permissions per agent.

## What it does

Paperclip agents that run on top of Hermes inherit filesystem access from a Hermes profile (`~/.hermes/profiles/<profile>/config.yaml`). This plugin adds:

- **Filesystem tree browser** — scan and expand paths starting from a configurable root.
- **R / RW / Denied permissions** — cycle each path through None, Read-only (`R`), Read+Write (`RW`), or Denied (`D`).
- **Hermes `config.yaml` injection** — persisted under the `file_access:` block in the matching Hermes profile.
- **Two UI surfaces** — a company settings page and a per-agent detail tab.

## Repository layout

```
.
├── src/
│   ├── manifest.ts          # Paperclip plugin manifest
│   ├── worker.ts            # Plugin worker (routes + config read/write)
│   ├── paperclip-types.ts   # Minimal Paperclip runtime types
│   └── ui/
│       └── index.tsx        # React UI for the settings page and agent tab
├── build.ts                 # Bun build script
├── smoke.ts                 # Standalone CLI smoke test (no Paperclip host)
├── tsconfig.json
└── package.json
```

## Build

```bash
bun install
bun run build
```

The build produces:

- `dist/worker.js`
- `dist/ui/index.js`
- `dist/manifest.js`

## Install in Paperclip

After building, install the plugin from the project directory:

```bash
export PAPERCLIP_API_KEY="your-board-api-key"
bash install-plugin.sh
```

Or use the Paperclip API directly:

```bash
curl -X POST "$PAPERCLIP_API_BASE/plugins/install" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/path/to/file-access-manager","isLocalPath":true}'
```

## Smoke test (standalone)

`smoke.ts` exercises the worker logic against real Hermes profiles without needing a Paperclip host:

```bash
bun run smoke.ts
```

It reads/writes `file_access` blocks in `~/.hermes/profiles/<profile>/config.yaml` and reverts the changes at the end.

## Requirements

- Bun runtime
- Paperclip AI host >= `2026.609.0`
- Hermes profile config at `~/.hermes/profiles/<profile>/config.yaml`

## License

MIT
