# Plan — Docker-backed File Access Manager

## Context

Today the plugin manages `HERMES_WRITE_SAFE_ROOT` in a profile's `.env`. As its own
ISA (`ISA.md`, decision 2026-07-17) admits, that is a **tool-level** restriction on
Hermes's `write_file`/`patch` tools only — the local-backend terminal bypasses it
entirely (`tools/terminal_tool.py` never imports `agent/file_safety.py`), and reads are
unrestricted. It is not real isolation.

The task: replace application-level path checks with **OS-level isolation enforced by
Docker**. Filesystem access becomes exactly the set of bind mounts Hermes's Docker
terminal backend is given: **Read/Write → `-v host:host`**, **Read Only → `-v host:host:ro`**,
**Denied → not mounted** (and actively masked when it sits under a mounted ancestor).
Secure-by-default: every path is Denied until explicitly granted.

This deliberately **reverses** the prior ISA's "no config.yaml writes" decision (ISC-25).
That decision was correct *then* because the `file_access:` block it wrote was fiction.
It is wrong *now*: `terminal.docker_volumes` is real, verified config that Hermes's Docker
backend consumes.

### Verified ground truth (source anchors)

- **Docker backend translation is literally `-v <spec>` per entry.**
  `tools/environments/docker.py:653-666`: each `docker_volumes` string is passed as
  `["-v", vol]`; a `:ro` suffix makes it read-only; `:/workspace` is special-cased only
  for cwd. Nested mounts resolve by destination-path depth (Docker sorts them), so a
  deeper `-v` overrides a shallower one for its subtree — this is how overrides work.
- **Runtime reads env vars, not config.yaml directly.** `tools/terminal_tool.py:1349-1382`
  `_get_env_config()` reads `TERMINAL_ENV` and parses `TERMINAL_DOCKER_VOLUMES` as **JSON**
  (`json.loads`, default `"[]"`). Config.yaml `terminal.*` is bridged into env at agent
  start by launchers/gateway (`_ensure_terminal_env_bridged`, `terminal_tool.py:1315`);
  explicit `.env` values win over the bridge. → **Write both** (matches what
  `hermes config set` does at `hermes_cli/config.py:8442`+`8448`).
- **SDK has no filesystem-tree API or UI component.** Capabilities cover
  agents/projects/issues/db/workspace-metadata only. We build the tree ourselves: the
  worker (host node runtime, has `fs` access) enumerates directories lazily over
  `ctx.data`; the UI renders it.
- **Plugin state exists** (`plugin.state.read`/`plugin.state.write`, `ctx.state`) — the
  durable home for the permission model.

### Decisions locked with the user
- Tree root default: **home (`~`) + an "Add root" control** for other top-level paths.
- On save: **auto-switch the profile to `backend: docker`** (mounts are inert otherwise),
  with a clear "changes how the agent runs, applies next start" notice in the UI.

---

## Permission model (the single source of truth)

Stored in **plugin state**, keyed by agent id:

```ts
type Mode = "rw" | "ro" | "denied";
interface Assignment { path: string; mode: Mode }   // absolute, normalized host path
interface AgentAccess { roots: string[]; assignments: Assignment[] }
```

- Only **explicit** assignments are stored. A node's **effective** mode = nearest
  ancestor's explicit mode, else `denied` (secure default). This drives inherited-vs-explicit
  visualization and "apply recursively" (set the ancestor) vs "override" (set the child).
- Deterministic translation `generateDockerVolumes(assignments, { maskDir }) → string[]`:
  - `rw`   → `"<path>:<path>"`
  - `ro`   → `"<path>:<path>:ro"`
  - `denied` **with a mounted (rw/ro) ancestor** → `"<maskDir>:<path>:ro"` (empty ro dir
    masks the host content Docker would otherwise expose through the ancestor mount)
  - `denied` with **no** mounted ancestor → omitted (not in the container at all)
  - Identity mapping (host path == container path): deterministic, and makes the
    config-translation test a pure equality check.

---

## Implementation

### Plugin core (new, pure, unit-tested)
- **`src/docker.ts`** — model types; `resolveEffectiveMode()`; `generateDockerVolumes()`;
  `normalizeHostPath()` (expand `~`, absolutize, `realpath` to defeat symlink aliasing —
  e.g. macOS `/var`→`/private/var`); `validatePath()` (reject relative, `:` in path, NUL,
  refuse a mount source of `/` or a bare home-root that would defeat isolation).
- **`src/config-write.ts`** — generalize the proven atomic `.env` line editor from
  `src/hermes.ts` (`upsertRootsLine`, CRLF-safe temp+rename) into `upsertEnvVars(env, {…})`
  writing `TERMINAL_ENV=docker`, `TERMINAL_DOCKER_VOLUMES=<JSON>`,
  `TERMINAL_DOCKER_RUN_AS_HOST_USER=true`; plus `updateTerminalConfigYaml()` using the
  `yaml` package **Document API** to set only `terminal.backend/docker_volumes/
  docker_run_as_host_user`, preserving every other key **and comments**, atomic write,
  mode `0o600`. Never returns `.env`/yaml contents to UI or logs (keeps ISC-23/24).
- **`src/fs-tree.ts`** — `listDir(path)`: one level, sorted, dirs first; entry-count cap;
  refuses to descend outside the allowed roots; returns `{name, path, isDir}` only.

### Worker (`src/worker.ts` — rewrite handlers)
- `hermes-agents` (list configurable agents) — keep.
- `list-dir` (data) — lazy tree level via `fs-tree`.
- `agent-access` (data) — read stored `AgentAccess` from `ctx.state`, return it plus a
  generated-volumes **preview** and the "applies next start / switches backend" note.
- `set-agent-access` (action) — validate assignments; persist to `ctx.state`; ensure the
  per-profile empty mask dir (`$HERMES_HOME/.file-access-deny-mask/`, `0555`); write `.env`
  vars + config.yaml `terminal.*` atomically; log paths/counts only.
- Uses `resolveHermesHome`/`isHermesAdapter` (kept from `src/hermes.ts`).

### UI (`src/ui/index.tsx` — rewrite)
- Expandable/collapsible tree; each node a **tri-state** selector (R/W · RO · **Denied**
  default). Inherited state shown muted with its source; explicit state shown solid.
  "Apply to folder" sets the node (recursive by inheritance); child selectors override.
  "Add root" appends a top-level path. Save → `set-agent-access`; errors render inline.
  Company-settings page (agent picker) + agent detail tab both mount this editor.

### Manifest (`src/manifest.ts`)
- Add `plugin.state.read`, `plugin.state.write`; bump version; keep the two UI slots.

---

## Mandatory Docker integration test suite

`tests/integration/` — bun test, **launches real containers**, gated on Docker presence
(skip with a loud message when absent locally; **required** in CI).

- **`harness.ts`** — `runContainer(volumes, { runAsHostUser })`: builds `docker run -d`
  from the generated `docker_volumes` using the **same `-v <spec>` mapping production uses**
  (`docker.py:661`) plus Hermes's hardening flags (`--cap-drop ALL` + DAC_OVERRIDE/CHOWN/
  FOWNER, `--security-opt no-new-privileges`, `--user uid:gid` when run-as-host-user),
  image `alpine`; `exec()`, host-path helpers, label + `docker rm -f` cleanup, unique temp
  workspaces under the OS tmpdir.
- Scenario files, each independent:
  - `rw.test.ts` — read existing, create, modify, delete; **assert changes on the host**.
  - `ro.test.ts` — read ok; create/modify/delete all fail; `docker inspect` shows the
    mount `RW:false` (Docker, not the app, enforces).
  - `denied.test.ts` — path not mounted / not present; parent mount does **not** expose a
    denied child (masked).
  - `nested.test.ts` — the `docs(ro)/source(rw)/source/secrets(denied)/temp(denied)` tree
    from the spec; assert each behaves.
  - `overrides.test.ts` — parent rw / child ro / grandchild denied all hold simultaneously.
  - `translation.test.ts` — UI-shaped config → `generateDockerVolumes` → `docker run` →
    container reflects **exactly** those permissions (round-trip equality, no loss).
  - `regression.test.ts` — seeded permanent regressions: denied-child masking, `:ro`
    write-block, macOS `/private/var` symlink normalization, empty-config no-op,
    space/odd-char path handling. New Docker-mount bugs get a case added here.
- **`tests/docker.spec.ts` / `tests/config-write.spec.ts`** — fast unit tests for the pure
  translation + writers (byte-identical passthrough, CRLF, comment preservation).

### CI — `.github/workflows/integration.yml`
- Matrix: **ubuntu-latest** (native Docker) + **macos-latest** (Docker via `colima`).
- Steps: `bun install` → `bun run build` → `bun run typecheck` → `bun test` (unit) →
  `bun test tests/integration` (real Docker). No manual setup; fails the build on any
  permission/mount mismatch.

### Docs
- Rewrite `README.md` (Docker isolation model, permission→mount table, backend-switch
  caveat, test/CI instructions). Update `ISA.md` (new ISCs; record the reversal of the
  no-config.yaml decision with the source evidence above).

---

## Verification (end-to-end)

1. `bun install && bun run build && bun run typecheck` → exit 0; UI bundle keeps the SDK
   externals contract.
2. `bun test` → unit suites green (translation + writers).
3. `bun test tests/integration` on this Linux host with Docker → all scenarios pass;
   spot-check by hand: `docker inspect` an RO container shows `RW:false`; write a file in
   an RW mount and see it appear on the host; confirm a denied child is absent/empty.
4. Confirm the config is **live, not placebo** (A4): after a save, read back the profile
   `.env` (`TERMINAL_ENV=docker`, JSON `TERMINAL_DOCKER_VOLUMES`) and config.yaml
   `terminal.*`; assert `_get_env_config()`-shaped JSON parses to the same volume list.
5. CI: push a branch; both matrix legs run Docker and pass.

## Out of scope
- Non-Docker backends (ssh/modal/daytona/singularity) — model is extensible to them later.
- Restarting live agents (UI states the next-start requirement; we don't bounce processes).
- Publishing to npm; local-path install into the kiddoollama host stays the deploy target.
