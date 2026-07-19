---
task: Rework file-access-manager to enforce per-path filesystem isolation via Docker bind mounts (v0.3.0)
project: file-access-manager
effort: E4
phase: complete
progress: 34/34
mode: build
started: 2026-07-15T06:20:00Z
updated: 2026-07-18T21:10:00Z
---

> **v0.3.0 addendum (2026-07-18).** The sections below record the v0.2.0
> `HERMES_WRITE_SAFE_ROOT` rewrite and remain accurate history. The v0.3.0
> Docker-isolation rework — its rationale, the reversal of the "no config.yaml
> writes" decision, criteria, and verification — is captured in the
> **v0.3.0 — Docker backend** section appended at the end of this file.

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
- [x] ISC-28: Editor displays protected paths read-only and states scope honestly: write_file/patch tools only, reads unrestricted, terminal not path-restricted on local backend, applies on next agent start (refined 2026-07-17)
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

- 2026-07-17 —
  - conjectured: `HERMES_WRITE_SAFE_ROOT` is "the one control Hermes actually enforces" for filesystem access, so managing it fully manages agent file access.
  - refuted by: Maros — file access also flows through the terminal; confirmed in source: `tools/terminal_tool.py` never imports `agent/file_safety.py` (its guard is dangerous-command approval), so local-backend shell writes bypass the write roots; docs (configuration#local-backend) state "no isolation… same filesystem access as your user account".
  - learned: the write-roots setting is a tool-level restriction on `write_file`/`patch`, not a sandbox; presenting it without the terminal caveat repeats the over-promising pattern this rewrite existed to remove. The `file_access:` config block remains unread by any Hermes code (only unrelated OAuth/Slack identifiers match).
  - criterion now: ISC-28 requires the UI to state the tool-level scope, the terminal bypass on local backend, and the Docker-backend recommendation; README carries the same caveat with a docs link.

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

---

# v0.3.0 — Docker backend

## Problem

The v0.2.0 plugin managed `HERMES_WRITE_SAFE_ROOT`, which — as this ISA's own
2026-07-17 decision records — is a **tool-level** restriction on Hermes's
`write_file`/`patch` tools only. The local-backend terminal bypasses it
(`tools/terminal_tool.py` never imports `agent/file_safety.py`) and reads are
unrestricted. It is not real isolation. The task is to enforce filesystem access
at the OS level via Docker bind mounts, with a secure-by-default per-path model
and a tree UI, plus a mandatory real-container integration suite.

## Vision

An admin browses an agent's host filesystem as a tree, marks paths Read/Write,
Read Only, or Denied (default), and saves. The plugin generates the exact
`docker_volumes` Hermes feeds to `docker run`, switches the profile to the Docker
terminal backend, and writes both the `.env` (runtime-authoritative) and
`config.yaml` `terminal.*` (human-facing) surfaces atomically. Isolation is then
enforced by the kernel: unmounted paths are absent, `:ro` mounts are unwritable,
and denied children under a mounted parent are masked with an empty read-only
directory. A standalone suite launches real containers and proves Docker — not
the app — enforces every mode, on Linux and macOS, in CI.

## Decision — reversing "no config.yaml writes" (ISC-25)

The v0.2.0 ISA forbade writing `config.yaml` because the `file_access:` block it
wrote was fiction no Hermes code read. That was correct then and is wrong now:

- **`terminal.docker_volumes` is real, consumed config.** `docker.py:653-666`
  passes each entry to `docker run` as `-v <spec>` (`:ro` → read-only; nested
  destinations resolve by depth, giving override semantics for free).
- **Runtime reads env vars; config.yaml is bridged to them at agent start.**
  `terminal_tool.py:1349-1382` reads `TERMINAL_ENV` and parses
  `TERMINAL_DOCKER_VOLUMES` as JSON from the environment;
  `_ensure_terminal_env_bridged` (`terminal_tool.py:1315`) backfills `TERMINAL_*`
  from config.yaml when a launcher didn't, and explicit `.env` values win.
- Therefore the plugin **dual-writes** `.env` + config.yaml, exactly as
  `hermes config set terminal.*` does (`config.py:8442` + `:8448`) — the `.env`
  surface authoritative, the config.yaml surface human-facing. Not a placebo
  (A4): the readback verifies `TERMINAL_DOCKER_VOLUMES` JSON parses to the
  generated volume list.

## Criteria

- [x] D-1: `src/model.ts` is a pure, no-`node:*` module (bundles for browser +
      node) exporting the permission model + `generateDockerVolumes`.
- [x] D-2: rw → `<p>:<p>`; ro → `<p>:<p>:ro`; denied with a mounted ancestor →
      `<maskDir>:<p>:ro`; denied without one → omitted. Deterministic (sorted).
- [x] D-3: nearest-ancestor inheritance with the secure default `denied`;
      child assignments override parents (`resolveEffectiveMode`).
- [x] D-4: `set-agent-access` persists the model to plugin state, ensures an
      empty `0555` mask dir, writes `.env` + `config.yaml` atomically, switches
      `backend: docker` + `docker_run_as_host_user: true`.
- [x] D-5: `.env` values use Hermes's exact quoting (`_quote_env_value` mirror);
      all other lines byte-preserved; CRLF-safe; secrets never returned/logged.
- [x] D-6: `config.yaml` update preserves comments + other keys (yaml Document
      API), atomic temp+rename.
- [x] D-7: tree UI — expandable, tri-state per node, inherited-vs-explicit
      visualization, apply-to-folder + override, add-root, generated-mounts
      preview; browsing confined to configured roots.
- [x] D-8: `bun run build` exit 0; UI bundle keeps the SDK externals contract
      (react/react-dom external, zero `node:*` leakage).
- [x] D-9: `bun run typecheck` exit 0 under `strict`.
- [x] D-10: unit suite (`tests/*.spec.ts`) green — model translation, path
      validation, env/yaml writers.
- [x] D-11: real-Docker integration suite (`tests/integration/`) launches
      containers and verifies Docker enforcement for rw / ro / denied / nested
      spec tree / overrides / config translation / regressions.
- [x] D-12: CI runs build + typecheck + unit + integration on Linux and macOS,
      requires Docker, and reaps leftover test containers.

## Verification

- D-1/D-8: Bash — build exit 0; `dist/ui/index.js` imports only `react`,
  `react/jsx-runtime`, and the SDK ui external; `rg 'node:(fs|os|path)'` → none.
- D-2/D-3/D-10: Bash — `bun run test`: 32 pass / 0 fail (`tests/model.spec.ts`,
  `tests/docker.spec.ts`, `tests/env-config.spec.ts`).
- D-5/D-6: unit — byte-preservation, CRLF, JSON quote round-trip, and
  comment-preserving YAML asserted in `tests/env-config.spec.ts`.
- D-9: Bash — `bun run typecheck` exit 0 (src + tests).
- D-11: Bash — `bun run test:integration`: 29 pass / 0 fail across 7 scenario
  files against Docker 28.2.2; a clean run leaves 0 labeled containers.
  Full run `bun run test:all`: 61 pass / 0 fail.
- D-4 live-write (A4 placebo check): DEFERRED — exercised end-to-end by the
  integration harness's volume generation; a live save into a real profile +
  `hermes config get terminal.docker_volumes` readback is the follow-up when a
  Paperclip instance_admin key is available (same deferral as v0.2.0 install).
- DEFERRED-VERIFY: live install into the kiddoollama Paperclip host + Interceptor
  check of both UI slots (needs board API key with instance_admin).

---

## Problem — profile mis-targeting + Docker tool-availability (2026-07-19)

Two defects surfaced in testing:

1. **Wrong profile.** The worker resolved its write target from the agent's
   adapter config (`resolveHermesHome`) and **silently fell back to `~/.hermes`**
   when an agent carried no `HERMES_HOME`. Result: Docker config (`TERMINAL_ENV=docker`
   + a one-file `TERMINAL_DOCKER_VOLUMES`) was written into the **main/router
   profile** — confirmed on disk (`~/.hermes/.env:330-332`, `config.yaml:51-53`).
2. **"Missing tools."** After that write, the default profile's agent reported it
   lacked `terminal`/`read_file`/`write_file` and that `execute_code` was blocked
   for writes. Investigated to root cause — see
   `Plans/docker-backend-investigation.md`.

## Decision — pivot from agent-targeting to profile discovery + selection

- **Discover, don't resolve.** `src/profiles.ts` scans `<root>/profiles/*` (plus
  the main profile at the root) at request time; the UI is populated from the
  filesystem and stays in sync with no plugin change.
- **Select, don't infer.** The company page presents profiles as a multi-select
  with the router/default flagged; config is written only to selected profiles.
  The agent detail tab resolves the agent→profile match and edits only that
  profile, reporting "no match" instead of defaulting to the router.
- **Tool availability is a mount-set property, not a Hermes bug.** Docker-backend
  file tools wrap the container `execute()` (`tools/file_operations.py`), so they
  only reach mounted paths. The fix is correct targeting + granting needed paths;
  the UI now warns on a zero-grant save. No Hermes change is warranted.

## Criteria — profiles (2026-07-19)

- [x] ISC-40: `discoverProfiles()` lists main first then specialized profiles
      (dir has `config.yaml` or `.env`), ignoring non-HERMES_HOME dirs and
      traversal names (`tests/profiles.spec.ts`).
- [x] ISC-41: `profileHome()` / `isValidProfileName()` reject `..`, `.`, and
      path separators (no traversal out of `profiles/`).
- [x] ISC-42: Worker registers `hermes-profiles`, `profile-access`,
      `set-profile-access`, `agent-profile`; `set-profile-access` writes ONLY to
      selected profiles and rejects unknown/empty selections.
- [x] ISC-43: The router/default profile and sibling profiles are byte-identical
      after a save that did not select them (`tests/targeting.spec.ts`).
- [x] ISC-44: Stored model round-trips through `profile-access`; re-saving
      upserts (no duplicate `TERMINAL_ENV` lines).
- [x] ISC-45: `agent-profile` maps by `HERMES_HOME`; an unmatched agent returns
      `profile: null` (never main).
- [x] ISC-46: Docker-backed profiles retain terminal/read/write/execute over
      granted mounts while `:ro` + denied-masking isolation holds
      (`tests/integration/capabilities.test.ts`).
- [x] ISC-47: UI warns when a save grants zero paths; README + investigation doc
      explain the Docker tool-availability model.

## Verification — profiles (2026-07-19)

- ISC-40/41/42/43/44/45: `bun test tests/*.spec.ts` — 55 pass / 0 fail
  (adds `profiles.spec.ts`, `targeting.spec.ts`; targeting drives the real
  `set-profile-access` action through the SDK test harness).
- ISC-46: `bun test tests/integration/capabilities.test.ts` — 8 pass / 0 fail
  against Docker 28.2.2. Full `bun run test:integration` — 37 pass / 0 fail.
- ISC-42/45: `bunx tsc --noEmit` exit 0; `bun run build` emits all three bundles.
- DEFERRED-VERIFY (unchanged): live install + Interceptor check of both UI slots
  (needs instance_admin key).

---

## Decision — auto-apply at save (2026-07-19)

Writing config is not enough: a running gateway holds the old `TERMINAL_ENV`, and
the Docker backend reuses its container by label WITHOUT comparing mounts
(`tools/environments/docker.py:892`). So `set-profile-access` now also, per target
profile: (2) `docker rm -f` the `hermes-profile=<label>` container (label =
`default` for main, else the profile name — mirrors hermes `_get_active_profile_name`
+ `_sanitize_label_value`), and (3) restarts the systemd `--user` gateway unit
whose `HERMES_HOME` matches, polling to `active`. Steps degrade to `skipped` when
`docker`/`systemctl` are absent; config is always written. The action returns an
ordered step list + `state` ("ready" | "needs-attention") which the UI renders
live. `FAM_SKIP_RUNTIME_APPLY=1` disables steps 2–3 (tests set it).

- [x] ISC-48: `sanitizeLabelValue`/`profileLabelValue` mirror hermes label rules
      (main→"default"); `apply.ts` steps computed via an injected `RunCommand`.
- [x] ISC-49: container recreation targets the correct `hermes-profile` label and
      reports skipped/ok/failed; gateway restart matches the unit by `HERMES_HOME`,
      skips inactive units, and fails if the unit never returns to `active`
      (`tests/apply.spec.ts`, injected runner — no real docker/systemctl touched).
- [x] ISC-50: `set-profile-access` returns per-profile `steps` + `state`; the UI
      shows live progress then the step report (`targeting.spec.ts` asserts shape
      with runtime apply disabled).

## Verification — auto-apply (2026-07-19)

- ISC-48/49/50: `bun test` — 110 pass / 0 fail across 14 files (adds
  `apply.spec.ts`; targeting/apply use injected or disabled runners).
- Regression guard: `FAM_SKIP_RUNTIME_APPLY=1` is set in `targeting.spec.ts`
  beforeEach so the SDK-harness action never shells out to the host.
- INCIDENT (logged): an earlier unguarded suite run (before the guard existed)
  removed the live `hermes-profile=coder` container via the real `docker rm -f`
  path. Recoverable — `container_persistent` bind-mounts survived; Hermes
  recreates on next use. The guard now prevents recurrence.
