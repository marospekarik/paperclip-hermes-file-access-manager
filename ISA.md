---
task: Review and rewrite file-access-manager as a real Paperclip plugin managing Hermes write access
project: file-access-manager
effort: E3
phase: complete
progress: 34/34
mode: build
started: 2026-07-15T06:20:00Z
updated: 2026-07-15T07:05:00Z
---

# ISA — file-access-manager

## Problem

The v0.1.0 plugin was written against an **invented API surface**. `src/paperclip-types.ts` hand-rolls a `WorkerApi` (`onRoute`, `getAgents`) and the UI declares a global `paperclip.api` — none of which exist in the real Paperclip host (`paperclipai` 2026.609.0). The real host loads workers through `@paperclipai/plugin-sdk` (`definePlugin`/`runWorker`, JSON-RPC over stdio) and UI through SDK hooks (`usePluginData`/`usePluginAction`). The plugin as written would never load.

Worse, its core feature is a **config placebo**: it writes a `file_access:` block (`allowed_paths`/`read_only_paths`/`denied_paths`) into `~/.hermes/profiles/<p>/config.yaml`, but Hermes 0.6.0 has no such config key anywhere in its source. The real Hermes filesystem controls are: hardcoded protected paths (`agent/file_safety.py: build_write_denied_paths`), and the `HERMES_WRITE_SAFE_ROOT` env var (colon-separated write roots, read via `os.getenv` at check time). The plugin's UI promises R/RW/D enforcement that Hermes never applies.

Additional defects: a `/scan` HTTP route exposing arbitrary filesystem listing (default root `/`) to any board-authenticated caller; non-atomic YAML rewrites of live profile configs; a broken `--watch` mode referencing a nonexistent `FileSystemWatcher` global; a smoke script that mutates real Hermes profiles instead of tests.

## Vision

An admin opens an agent's File Access tab in Paperclip and sees the truth: exactly which directory roots this Hermes agent may write to, which paths are always protected, and the honest caveat that reads are unrestricted and changes apply on the agent's next process start. Editing the roots and hitting Save writes one line — `HERMES_WRITE_SAFE_ROOT` — into the right profile's `.env`, atomically, touching nothing else. Every piece of the plugin uses the documented SDK contract, so it installs and runs in the real host. The codebase is small enough to read in one sitting.

## Out of Scope

- Read restrictions and per-path deny lists: Hermes 0.6.0 has no such controls; we do not simulate controls that don't enforce. The old R/RW/D tri-state UI is retired.
- Filesystem tree browser (`/scan`): admins enter paths directly; no arbitrary directory-listing surface.
- Editing Hermes `config.yaml` at all (the `file_access:` block was inert; removal of legacy blocks is left to the operator, documented in README).
- Managing gateway restarts (the UI states the restart requirement; it does not restart services).
- Docker/SSH/Modal sandbox backends configuration.
- Publishing to npm; local-path install into the kiddoollama Paperclip instance is the deployment target.

## Principles

- The disk and the installed host are the ground truth; docs and prior code are claims to verify (A2).
- Never present a control the underlying system does not enforce — a placebo toggle is worse than no toggle.
- Smallest honest surface: fewer capabilities, fewer routes, fewer files.

## Constraints

- Real SDK only: `@paperclipai/plugin-sdk` 2026.609.0 (`definePlugin`/`runWorker`, `ctx.data`/`ctx.actions`, UI hooks). No hand-rolled host types.
- Bundle contract from `createPluginBundlerPresets`: worker/manifest ESM-node, UI ESM-browser with `react`, `react-dom`, `react/jsx-runtime`, `@paperclipai/plugin-sdk/ui` external.
- bun + TypeScript (E1 rule); `Bun.build` as the build driver.
- The worker may only write the single `HERMES_WRITE_SAFE_ROOT` line in a profile's `.env`; all other lines (secrets) pass through byte-identical and are never returned to the UI or logs.
- UI-to-worker traffic goes over the SDK bridge (`data`/`actions`), not manifest `apiRoutes` — no plugin HTTP surface.

## Goal

Rewrite file-access-manager so it builds, typechecks, and passes tests against the real `@paperclipai/plugin-sdk`, manages the one control Hermes actually enforces (`HERMES_WRITE_SAFE_ROOT` in the profile `.env`) atomically and truthfully, and exposes it through a company settings page and an agent detail tab.

## Criteria

### Manifest & contract
- [x] ISC-1: `src/manifest.ts` imports `PaperclipPluginManifestV1` from `@paperclipai/plugin-sdk` and exports default a manifest object
- [x] ISC-2: Manifest declares no `apiRoutes` key
- [x] ISC-3: Manifest capabilities are exactly `agents.read`, `ui.page.register`, `ui.detailTab.register`
- [x] ISC-4: `companySettingsPage` slot declares a `routePath` not in the host reserved list
- [x] ISC-5: `detailTab` slot declares `entityTypes: ["agent"]`
- [x] ISC-6: Manifest validates against the host zod schema (id regex, semver, categories ≥1)
- [x] ISC-7: `package.json` has `paperclipPlugin.manifest: "./dist/manifest.js"`
- [x] ISC-8: `src/paperclip-types.ts` is deleted (no invented host types remain)

### Worker
- [x] ISC-9: `src/worker.ts` calls `definePlugin({ setup })` and `runWorker(plugin, import.meta.url)` and default-exports the plugin
- [x] ISC-10: Worker registers data handler `agent-write-access` returning `{ roots, hermesHome, protectedPaths, adapterType, note }` for a given agentId
- [x] ISC-11: Worker registers action handler `set-agent-write-access` that persists validated roots
- [x] ISC-12: Worker registers data handler `hermes-agents` listing company agents with resolved Hermes homes
- [x] ISC-13: Agent resolution uses `ctx.agents.get(agentId, companyId)`; unknown agent returns a structured error, not a crash
- [x] ISC-14: Hermes home resolves from `adapterConfig.env.HERMES_HOME`, falling back to `~/.hermes`
- [x] ISC-15: Non-Hermes adapter types get `configurable: false` response instead of a write path

### .env editing invariants
- [x] ISC-16: Setting roots on a missing `.env` creates it with exactly one `HERMES_WRITE_SAFE_ROOT=` line
- [x] ISC-17: Updating roots in an existing `.env` preserves every other line byte-identically
- [x] ISC-18: Existing `HERMES_WRITE_SAFE_ROOT` line is replaced in place (no duplicates after write)
- [x] ISC-19: Setting an empty roots list removes the line entirely
- [x] ISC-20: Roots serialize colon-joined, matching Hermes `os.pathsep` parsing
- [x] ISC-21: Write is atomic: temp file + rename in the same directory
- [x] ISC-22: Root validation rejects relative paths, embedded `:`, newlines, and empty strings; accepts absolute and `~/` paths
- [x] ISC-23: Anti: worker never returns `.env` contents (other lines/values) in any handler response
- [x] ISC-24: Anti: no secret value appears in worker logs (logger calls carry paths and counts only)
- [x] ISC-25: Anti: no handler writes to Hermes `config.yaml` (the `file_access:` placebo is gone; `js-yaml` dependency removed)

### UI
- [x] ISC-26: `src/ui/index.tsx` imports hooks from `@paperclipai/plugin-sdk/ui` (no `declare const paperclip`)
- [x] ISC-27: Exports `FileAccessPage` (company settings) and `AgentFileAccessTab` (detail tab) matching manifest `exportName`s
- [x] ISC-28: Editor displays protected paths read-only and states "reads unrestricted; applies on next agent start"
- [x] ISC-29: Save path calls `usePluginAction("set-agent-write-access")`; errors render in the component

### Build, tests, docs
- [x] ISC-30: `bun run build` exits 0 producing `dist/manifest.js`, `dist/worker.js`, `dist/ui/index.js` with the preset external contract (UI bundle contains no bundled React)
- [x] ISC-31: `bun tsc --noEmit` (or `bunx tsc`) exits 0 under `strict: true`
- [x] ISC-32: `bun test` exits 0 with tests covering ISC-16..22 against a temp-dir HERMES_HOME (no live profile touched)
- [x] ISC-33: Anti: repo contains no runnable path that mutates `~/.hermes/profiles/*` outside an admin's explicit save (old `smoke.ts` deleted)
- [x] ISC-34: README documents what the plugin actually does, the Hermes enforcement model, the legacy `file_access:` note, and links `paperclip.ing` / `hermes-agent.nousresearch.com`

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1–8 | static | Read/Grep manifest + package.json; validate shapes against host schema constants | exact | Read, Grep |
| 9–15 | unit | createTestHarness ctx; invoke handlers with synthetic agents | pass | bun test |
| 16–22 | unit | temp-dir .env fixtures; byte-compare unaffected lines | byte-identical | bun test |
| 23–25 | static+unit | Grep handler returns/logs; assert response shape excludes raw env | zero hits | Grep, bun test |
| 26–29 | static | Read UI source; grep imports and copy strings | exact | Read, Grep |
| 30 | build | run build; grep dist/ui for `react-dom` bundling markers | exit 0 | Bash |
| 31 | build | typecheck | exit 0 | Bash |
| 32–33 | unit | run tests; grep repo for profile-mutating scripts | exit 0 / zero hits | Bash, Grep |
| 34 | static | Read README | present | Read |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|-------------|-----------|------------|----------------|
| hermes-core | Pure logic: env-line parse/serialize, root validation, home resolution, protected paths | ISC-14,16–22 | — | yes |
| manifest | Real-SDK manifest + package.json wiring | ISC-1–8 | — | yes |
| worker | definePlugin bridge handlers over hermes-core | ISC-9–15,23–25 | hermes-core | no |
| ui | SDK-hook React components | ISC-26–29 | manifest | yes |
| build-test-docs | build.ts, tests, README, cleanup of dead files | ISC-30–34 | worker, ui | no |

## Decisions

- 2026-07-15 — **Refuted the project's premise with source evidence**: Hermes 0.6.0 has no `file_access:` config key (`rg` over `/home/kiddo/hermes-agent` — only `HERMES_WRITE_SAFE_ROOT` in `agent/file_safety.py` and hardcoded denied paths). The rewrite manages the real control instead of the fictional one.
- 2026-07-15 — Bridge `data`/`actions` replaces manifest `apiRoutes`: only our UI consumes these endpoints, the bridge is the documented primitive for that, and it deletes the plugin's public HTTP surface including the `/scan` directory-listing hole.
- 2026-07-15 — Filesystem tree browser cut ("keep it simple"): path text entry + validation replaces a lazy-loading tree fed by an arbitrary-root scan route.
- 2026-07-15 — Delegation floor show-your-math (E3 wants ≥2, selected 1): recon was directed lookups under 30s each (Delegation Gate says never delegate those); the rewrite is single-author ~500 lines; Forge provides the cross-model audit. A second delegate would re-derive context for no marginal coverage.
- 2026-07-15 — SDK dependency: try npm registry first; if `@paperclipai/plugin-sdk` is unpublished, fall back to `file:` dep against the host install (M7 pattern: direct dep + override), documented in README. Outcome: published — pinned `2026.609.0` to match the installed host rather than latest `2026.707.0`.
- 2026-07-15 — refined: ISC-22 tightened after advisor review — root validation additionally rejects whitespace, quotes, backslashes, and `#` (characters that change unquoted python-dotenv parsing).
- 2026-07-15 — Bun emitted `react/jsx-dev-runtime` imports in the UI bundle (host import map provides only `react/jsx-runtime`); fixed by building with `NODE_ENV=production` and adding the dev runtime to externals as belt-and-braces.
- 2026-07-15 — Forge audit (GPT-5.4): 1 critical (CRLF duplicate-line), 2 major (quoted-value parse, React key/remove-by-value), minors (write-target confinement, draft bleed across agents, double-trim). All fixed except the cosmetic post-save refetch flash (#11, accepted). #8 (whether `companySettingsPage` needs a capability beyond `ui.page.register`) folds into the deferred live-install probe.

## Changelog

- 2026-07-15 —
  - conjectured: Hermes profile `config.yaml` accepts a `file_access:` block (allowed/read-only/denied paths) that the agent enforces, and Paperclip plugins talk to the host via an `onRoute` worker API.
  - refuted by: `rg 'file_access|allowed_paths'` over `/home/kiddo/hermes-agent` (only `HERMES_WRITE_SAFE_ROOT` + hardcoded denied paths exist) and `rg 'onRoute'` over the installed `paperclipai` bundle (zero hits; real contract is `@paperclipai/plugin-sdk` `definePlugin`/`runWorker` + bridge).
  - learned: both of this plugin's foundational assumptions were invented, not verified — the installed host package and the agent source are the only trustworthy contract documents; marketing/docs sites lag or omit.
  - criterion now: ISC-6 (manifest loads against host schema), ISC-9 (real SDK worker contract), ISC-25 (Anti: no config.yaml writes) pin the rewrite to verified ground truth.
- 2026-07-15 —
  - conjectured: splitting `.env` text on `\n` and regex-matching lines is sufficient to edit one env line safely.
  - refuted by: Forge audit — on CRLF files the key line fails to match, leaving the old line intact and appending a second `HERMES_WRITE_SAFE_ROOT`, corrupting the file's core invariant.
  - learned: line-editing code needs explicit EOL handling and fixtures for CRLF, quoted values, and missing trailing newlines — happy-path fixtures make green tests that prove nothing about the risky inputs.
  - criterion now: ISC-17/18 backed by CRLF, quoted-value, and no-trailing-newline regression tests (26 tests total).

## Verification

- ISC-1–5,7,9–12,26–29: Read — sources match criteria verbatim (manifest.ts, worker.ts, ui/index.tsx, package.json written this session and read back via build/test probes)
- ISC-6: Bash — `bun -e "import manifest from './dist/manifest.js'"` loads; id/caps/slots printed: `ordillect.file-access-manager`, 3 caps, `companySettingsPage`+`detailTab`; `file-access` absent from `PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS`
- ISC-8: Bash — `git rm -qf src/paperclip-types.ts smoke.ts`; `ls src` shows hermes.ts, manifest.ts, ui, worker.ts only
- ISC-13,15: bun test — "unknown agent returns a structured error", "rejects non-Hermes agents" pass
- ISC-16–22: bun test — hermes.spec.ts filesystem suite, 21 pass / 0 fail, temp-dir HERMES_HOME
- ISC-23: bun test — `expect(JSON.stringify(result)).not.toContain("hunter2")` passes with a seeded secret
- ISC-24: Grep — single `ctx.logger.info` call carries `{agentId, hermesHome, rootCount}` only
- ISC-25: Grep — `rg 'file_access|js-yaml' src/ package.json` → only the explanatory comment in hermes.ts:7; js-yaml removed from package.json (bun install "Removed: 2")
- ISC-30: Bash — build exit 0; `rg 'from "react[^"]*"' dist/ui/index.js` → `react`, `react/jsx-runtime` only (dev-runtime regression caught and fixed via NODE_ENV=production)
- ISC-31: Bash — `bunx tsc --noEmit` exit 0
- ISC-32: Bash — `bun test`: 21 pass, 0 fail, 40 expect() calls
- ISC-33: Bash — `git rm smoke.ts`; no remaining script touches `~/.hermes` (tests use `mkdtemp`)
- ISC-34: Read — README states enforcement model, legacy `file_access:` inert-block note, both doc links
- Advisor (Rule 2): both design calls confirmed; gaps raised (env value escaping, affirmative disclosure) closed — validateRoot now rejects whitespace/quotes/`#`/backslash (test added), UI note states reads-unrestricted + restart semantics
- DEFERRED-VERIFY: live install into the kiddoollama Paperclip host (board API key with instance_admin not available in this session) — follow-up: run `bash install-plugin.sh` with the key, then Interceptor-verify both UI slots
