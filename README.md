# File Access Manager

A [Paperclip](https://paperclip.ing) plugin that gives
[Hermes](https://hermes-agent.nousresearch.com)-backed agents **real, OS-level
filesystem isolation**. You pick the Hermes **profile(s)** to configure, then
mark host paths **Read/Write**, **Read Only**, or **Denied** in a tree UI; the
plugin translates those choices into Docker bind mounts and switches each
selected profile's Hermes terminal backend to Docker so the container — not the
application — enforces them.

## Why Docker instead of path checks

Hermes's older path controls (`HERMES_WRITE_SAFE_ROOT`, protected paths) only
restrict the `write_file`/`patch` **tools**. On the local terminal backend the
agent's shell runs with your full user permissions and bypasses them entirely
(`tools/terminal_tool.py` never consults `agent/file_safety.py`), and reads are
unrestricted. That is a tool-level guardrail, not a sandbox.

Docker bind mounts are enforced by the kernel: a path that isn't mounted does
not exist in the container, and a `:ro` mount cannot be written through by any
process — even one running as the file's owner. This plugin makes that the
enforcement mechanism.

## Permission model

Secure by default: **every path is Denied until you grant it.** Each explicit
selection becomes a Docker volume spec (identity-mapped: the container sees the
same absolute path as the host).

| Selection    | Docker mount                          | Effect in the container                    |
|--------------|---------------------------------------|--------------------------------------------|
| Read/Write   | `-v <path>:<path>`                    | Full read/write; changes land on the host  |
| Read Only    | `-v <path>:<path>:ro`                 | Readable; writes fail (`Read-only file system`) |
| Denied       | *(not mounted)*                       | Absent from the container                  |
| Denied *under a mounted parent* | `-v <emptyRoDir>:<path>:ro` | Masked — the parent mount cannot expose it |

Set a folder once to apply it to everything inside (inheritance); set a child
differently to override it. Deeper (more specific) mounts win, so
parent `rw` / child `ro` / grandchild `denied` all hold at the same time.

**Broad grants are allowed but flagged.** You *can* grant your whole home
directory `rw` — useful when you want a Dockerized profile whose tools behave
like the local backend (terminal / read_file / write_file / execute_code work on
any `~/path`, files land on the host). The container is still isolated from the
rest of the host (`/`, other users, system dirs). The UI warns when you do this,
because the container then also sees your secrets (`.ssh`, `.gnupg`, tokens,
`.env` files); set those subfolders to **Denied** to mask them. Only the
filesystem root `/` is hard-refused.

The model is stored in **plugin state** (per profile) and is the single source of
truth. `generateDockerVolumes()` (in `src/model.ts`) is the one place that turns
it into mounts — the UI preview, the worker, and the integration tests all call it.

## Profiles, not agents — and never the router by accident

Hermes config is **per profile**, not per agent: the main/router profile lives
at `$HERMES_HOME` (default `~/.hermes`) and every specialized profile is an
independent Hermes home under `~/.hermes/profiles/<name>`. Multiple agents can
share one profile, so file-access config is a property of the *profile*.

The plugin **discovers profiles at request time** by scanning that layout
(`src/profiles.ts`), so profiles added or removed on disk appear/disappear with
no plugin change. The UI lists them with the router/default profile clearly
flagged, and you select **one or more** to configure. Configuration is written
**only** to the profiles you select — the router/default profile is never
touched unless you explicitly check it. (An earlier version resolved the target
from the agent's adapter config and silently fell back to `~/.hermes`, which
wrote Docker config into the main profile; that is the bug this release fixes.)

## What "Save & apply" writes

For **each selected profile**, saving writes both surfaces Hermes reads for the
Docker backend, atomically, preserving every other line and comment:

- `<profile home>/.env` — `TERMINAL_ENV=docker`, `TERMINAL_DOCKER_VOLUMES=<JSON>`,
  `TERMINAL_DOCKER_RUN_AS_HOST_USER=true` (the runtime-authoritative surface;
  `tools/terminal_tool.py` reads these from the environment).
- `<profile home>/config.yaml` `terminal.*` (the human-facing surface that
  `hermes status`/`hermes config` show and launchers bridge into env at start).

This mirrors exactly what `hermes config set terminal.*` does. Secrets in `.env`
are never read back into the UI or logged.

### Making the change take effect (auto-apply)

Writing the config is necessary but **not sufficient**, for two reasons:

1. A running Hermes gateway loads `TERMINAL_ENV` into its process environment at
   startup, so it keeps the old value until it restarts.
2. The Docker backend reuses its persistent container **by label only** — it
   never compares mounts (`hermes-agent tools/environments/docker.py:892`). So
   even after a restart, an existing container keeps its original `-v` mounts.

So on save the plugin **applies the change at runtime** for each target profile
and reports each step (rendered live in the UI, ending in a `ready` badge):

1. **Write profile config** — `.env` + `config.yaml` (above).
2. **Recreate Docker container** — `docker rm -f` the profile's labeled
   container (`hermes-profile=<name>`, `default` for the router) so the next tool
   call starts a fresh one with the new mounts. No container yet = nothing to do.
3. **Restart Hermes gateway** — finds the systemd `--user` unit whose
   `HERMES_HOME` matches the profile and restarts it, polling until it reports
   `active`. A stopped gateway is left stopped; a profile with no unit is skipped.

Each step degrades gracefully (missing `docker`/`systemctl` → `skipped`, not a
hard failure) and the config is always written regardless. Set
**`FAM_SKIP_RUNTIME_APPLY=1`** in the worker's environment to disable steps 2–3
(config-only; you then restart/​recreate manually) — tests set this so they never
touch real containers or services.

## Docker backend and tool availability (important)

When a profile switches to the Docker backend, Hermes routes **`terminal`,
`read_file`, `write_file`, and `execute_code` through the sandbox container** —
the file tools are thin wrappers over the terminal backend's `execute()`
(`tools/file_operations.py`). The container only sees what you mount (plus
Hermes' auto-mounted read-only skills dir, an ephemeral `/workspace`, and a
persistent `/root`). **A profile with nothing granted therefore leaves those
tools unable to reach the host filesystem** — this is the isolation working as
designed, not a missing feature. The UI warns when a save would grant zero
paths. Grant the paths the agent actually needs (its workspace, project dirs,
reference material) and the tools keep working over exactly those paths — see
`tests/integration/capabilities.test.ts`. Full analysis:
[`Plans/docker-backend-investigation.md`](./Plans/docker-backend-investigation.md).

## UI surfaces

- **Company settings → File Access** — discover Hermes profiles, tick one or
  more to configure (router/default flagged), browse the host filesystem as an
  expandable tree, assign permissions, preview the generated mounts, and save to
  all selected profiles at once.
- **Agent detail → File Access tab** — resolves which profile the agent runs on
  and edits **only that profile**. An agent whose `HERMES_HOME` matches no
  discovered profile is reported (not silently defaulted to the router).

The tree defaults to your home directory; use **Add root** to pin other
top-level paths (e.g. `/data`). There is no host-wide directory-listing surface —
browsing is confined to the configured roots.

## Build & test

```bash
bun install
bun run build         # dist/worker.js, dist/manifest.js, dist/ui/index.js
bun run typecheck
bun run test          # fast unit tests (translation + writers)
bun run test:integration   # real-Docker end-to-end (needs a running Docker)
```

### The integration suite is a required deliverable

`tests/integration/` launches **real containers** and verifies Docker — not the
app — enforces every permission mode: Read/Write, Read Only, Denied, the nested
spec tree, permission overrides, full config translation, a growing set of
regression tests (`:ro` write-block, denied-child masking, symlink
normalization, spaces-in-paths, empty config), and **tool-capability retention**
(`capabilities.test.ts`: terminal / read_file / write_file / execute_code all
work over granted mounts while isolation still holds). It runs in CI on **Linux
and macOS** (`.github/workflows/integration.yml`) and fails the build on any
mount/permission mismatch. When a new Docker-mount bug is found, add a case to
`tests/integration/regression.test.ts` so it can't reappear.

Fast unit specs additionally cover **profile discovery** (`profiles.spec.ts`)
and **profile targeting + config persistence** (`targeting.spec.ts`, which drives
the real worker action through the SDK test harness and asserts the router
profile is never written unless selected).

## Architecture

```
src/
├── model.ts       # pure permission model + generateDockerVolumes (browser+node)
├── docker.ts      # node path helpers: normalize / realpath / validate
├── env-config.ts  # atomic .env + comment-preserving config.yaml writers
├── fs-tree.ts     # lazy, root-confined directory listing for the tree
├── hermes.ts      # Hermes home / adapter resolution + agent→profile matching
├── profiles.ts    # runtime profile discovery (scan ~/.hermes/profiles)
├── apply.ts       # post-save runtime apply: container recreate + gateway restart
├── worker.ts      # definePlugin bridge: hermes-profiles, profile-access,
│                  #   set-profile-access, agent-profile, list-dir
└── ui/index.tsx   # profile multi-select + tree UI (tri-state, inherited-vs-explicit)
tests/             # unit specs (*.spec.ts) + integration/ (real Docker)
```

Built on the official
[`@paperclipai/plugin-sdk`](https://www.npmjs.com/package/@paperclipai/plugin-sdk).
The SDK exposes no filesystem-browse capability, so the worker enumerates
directories over the `ctx.data` bridge and the UI renders the tree.

## Install into Paperclip

The canonical install path is the `paperclipai` CLI — an agent runs it, no
human touches the Paperclip UI. The CLI registers the plugin with the instance
and activates the worker. Verified working on 2026-07-18 (plugin reached
status `ready` via this path).

### Prerequisites

- **`paperclipai` CLI** on the host that runs the Paperclip server. A local
  Paperclip install typically exposes it at
  `~/.paperclip/node_modules/.bin/paperclipai`; if that's not on your `PATH`,
  invoke it by absolute path.
- **`PAPERCLIP_API_KEY`** — a board API key with `instance_admin` role,
  exported in the shell before any install command. The CLI reads it from the
  environment; it is never a CLI argument. Never paste the key into a command
  line or file — the shell must already have it (env indirection, not inline
  assignment).
- **Bun** — for building the plugin from source.
- **Docker or Podman** — only for the plugin's enforcement feature (the Docker
  bind mounts). Install does not require Docker; don't block on it.

### Build the plugin from source

```bash
cd file-access-manager
bun install
bun run build          # produces dist/worker.js, dist/manifest.js, dist/ui/index.js
bun run typecheck      # optional sanity check
```

### Install via the paperclipai CLI (agent path — no UI)

```bash
paperclipai plugin install --local /absolute/path/to/file-access-manager
```

- `--local` installs from a local directory (not an npm package). Use the
  absolute path to the built plugin.
- This is the command an agent runs. No human opens the Paperclip UI; the CLI
  registers the plugin with the instance and activates the worker.
- If `paperclipai` is not on `PATH`, invoke it directly:
  `~/.paperclip/node_modules/.bin/paperclipai plugin install --local <path>`.
- `PAPERCLIP_API_KEY` must be set in the shell before running this — the CLI
  reads it from the environment, never from argv.

### Scope to a company

Install is instance-wide. The plugin's manifest declares a
`companySettingsPage` slot, so once installed at the instance level it surfaces
under each company's settings sidebar automatically (route
`/company/settings/file-access`). There is no per-company scoping flag on the
install command. If the operator needs finer control, check
`paperclipai plugin --help` and `paperclipai company --help` for any
instance-level configuration options.

### Verify the install (agent-runnable, no UI)

```bash
paperclipai plugin inspect ordillect.file-access-manager    # status should be "ready"
paperclipai plugin list                                    # confirms it's registered
```

The plugin id is `ordillect.file-access-manager` (from `package.json` name
`@ordillect/file-access-manager`). Status `ready` means the worker started
successfully. If status is `error`, tail
`~/.paperclip/instances/default/logs/server.log` and look for
`worker process crashed` or `failed to activate plugin` lines — the usual
cause is a stale `dist/` (rerun `bun run build`, then
`paperclipai plugin enable ordillect.file-access-manager`).

### Disable and re-enable (agent-runnable)

```bash
paperclipai plugin disable ordillect.file-access-manager    # soft disable
paperclipai plugin enable  ordillect.file-access-manager    # re-enable after a rebuild
```

To remove the plugin entirely:

```bash
paperclipai plugin uninstall ordillect.file-access-manager
```

### The install-plugin.sh script — fallback, not canonical

The repo ships `install-plugin.sh`, which wraps the REST API install for
environments without the CLI. Notes if you use it:

- It defaults to `PAPERCLIP_API_BASE=http://localhost:3000/api` (the standard
  local Paperclip server). If your instance runs elsewhere — a remote host, a
  non-default port — set `PAPERCLIP_API_BASE=http://host.example:PORT/api`.
- It **rebuilds unconditionally** (`bun install` + `bun run build`) so `dist/`
  always matches the source. Pass `--no-build` to skip that and install the
  existing `dist/`.
- It needs a JS runtime for one JSON parse step — `bun` (already required to
  build) or `node`. No `python3` dependency.

Prefer the CLI path above. The script exists as a fallback.

## Requirements

- Bun (build/test); the worker runs under the host's node runtime
- Docker (or Podman) available to the host running the Hermes agents
- Hermes profiles under a Hermes root (default `~/.hermes`;
  override with `FAM_HERMES_ROOT` for non-standard installs)

## Portability & limitations

The plugin auto-discovers as much as it can and degrades gracefully where it
can't. What it adapts to on its own, and what it can't:

- **Container runtime (Docker vs Podman).** The permission→mount translation is
  runtime-agnostic. The auto-apply step (recreate the profile's container so new
  mounts take effect) uses the **same runtime Hermes uses**, read from the
  profile's own `HERMES_DOCKER_BINARY` (`.env`), falling back to the worker
  environment, then `docker`. So Podman hosts (`HERMES_DOCKER_BINARY=podman`)
  recreate the right containers instead of silently no-op'ing on a missing
  `docker` CLI. Rootless Docker/Podman work as long as that CLI can `ps`/`rm`
  the containers.

- **Hermes root location.** The default is `~/.hermes`, but the root need not
  live under `$HOME`: a system-wide install (`/opt/hermes`, `/srv/...`) or a
  `FAM_HERMES_ROOT` override is written correctly. (The write guard blocks
  *escaping* the target root, not living outside `$HOME`.) Profiles are
  discovered by scanning `<root>/profiles/<name>` at request time, so profiles
  added or removed on disk appear/disappear with no plugin change.

- **Operating systems.** Linux and macOS are first-class and both run the
  real-Docker integration suite in CI. macOS symlink aliasing (`/var` →
  `/private/var`) is normalized so bind-mount sources match the kernel path.
  **Windows is supported via WSL2**, not native Windows: bind-mount specs and
  the `:`-rejecting path validation assume POSIX paths, and Docker/Podman inside
  WSL sees WSL paths. Run the plugin, Paperclip, and Hermes inside the WSL
  distro.

- **Gateway restart (making a live change take effect).** Writing config is not
  enough — a running gateway holds the old `TERMINAL_ENV`, and the Docker
  backend reuses its container by label without comparing mounts. Auto-apply
  recreates the container and restarts the gateway. Gateway restart currently
  recognizes **systemd `--user` units** named `hermes-gateway*.service` (the
  documented per-profile layout). On macOS/launchd, non-systemd init, differently
  named units, or system-scope units, that step reports `skipped` (never a
  hard failure) with a note to restart the gateway manually. The config is
  always written and the container always recreated regardless. Set
  `FAM_SKIP_RUNTIME_APPLY=1` to disable container-recreate + gateway-restart
  entirely (config-only; you then apply manually).

- **What still needs a human.** A board API key with `instance_admin` role for
  install (never passed on a command line — env only); an existing mount source
  on disk for any `rw`/`ro` grant (the worker refuses to grant a missing path,
  so Docker never auto-creates a root-owned source); and the judgment call of
  *which* paths an agent actually needs (a zero-grant save is flagged, not
  blocked).

## License

MIT
