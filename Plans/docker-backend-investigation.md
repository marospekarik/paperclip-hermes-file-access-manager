# Hermes Docker backend: tool availability — investigation

**Question raised:** after switching a profile to the Docker backend, the agent
reported *"my toolset in this Docker session lacks terminal, read_file, and
write_file. execute_code is blocked for file writes in this profile's current
config."* Is that expected, a config problem, or a bug?

**Verdict:** expected behavior of the Docker terminal backend given a near-empty
mount set, catastrophically amplified by a profile-targeting bug (Issue 1) that
wrote the Docker config into the **main/router profile** with only a single file
mounted. Not a Hermes bug. The fix is correct targeting + granting the paths the
agent needs; there is nothing to "restore" inside Hermes.

Sources: official docs
`website/docs/user-guide/docker.md` and `configuration.md#docker-backend`; Hermes
source at `~/hermes-agent` (`tools/terminal_tool.py`, `tools/file_operations.py`,
`tools/file_tools.py`, `tools/environments/docker.py`, `hermes_cli/config.py`).

---

## 1. How the Docker backend works

Two distinct things share the word "Docker" (`docker.md`):

1. **Running Hermes *in* Docker** — the whole agent runs in a container. Not what
   this plugin does.
2. **Docker as a *terminal backend*** — Hermes runs on the host but executes
   every command inside **one long-lived sandbox container** that persists across
   tool calls, `/new`, `/reset`, and `delegate_task` subagents for the life of
   the Hermes process. This is what `terminal.backend: docker` selects, and what
   the plugin configures.

The container is started with heavy hardening (`configuration.md`):
`--cap-drop ALL` (only `DAC_OVERRIDE`, `CHOWN`, `FOWNER` re-added),
`--security-opt no-new-privileges`, `--pids-limit 256`, size-limited tmpfs for
`/tmp`, `/var/tmp`, `/run`. It is labeled `hermes-agent=1`,
`hermes-task-id=<id>`, `hermes-profile=<profile>` — **container reuse and the
orphan reaper are profile-scoped**, so containers from different profiles are
invisible to each other.

## 2. How tool availability is determined under Docker

This is the crux. The file tools are **not independent capabilities** — they are
wrappers over the terminal backend's `execute()`:

- `tools/file_operations.py:797` — `ShellFileOperations` "Works with ANY terminal
  backend that has `execute(command, cwd)` … local, docker, singularity, ssh,
  modal, and daytona."
- `tools/file_tools.py:167` — `docker` is in `_CONTAINER_PATH_BACKENDS_FALLBACK`;
  `:170` `_terminal_env_type_for_task()` resolves the active backend and, at
  `:201`, falls back to `os.getenv("TERMINAL_ENV")`.
- `hermes_cli/config.py:7056` — the config→env bridge maps `terminal.backend` to
  the env var **`TERMINAL_ENV`** (not `TERMINAL_BACKEND`). `run_agent.py:82` and
  `tools/terminal_tool.py` read `TERMINAL_ENV`; a value in `.env`/shell overrides
  `config.yaml` (`hermes_cli/dump.py:312-324`).

**Consequence:** with `backend: docker`, `terminal`, `read_file`, `write_file`,
and `execute_code` all run **inside the container via `docker exec`**. They still
exist — but they operate on the *container's* filesystem, which is only whatever
is mounted.

## 3. What the container can see by default

From `tools/environments/docker.py`:

- **User `docker_volumes`** (`:650-666`) — the host paths you mount. Each becomes
  `-v <spec>`. This is the plugin's entire output.
- **`/workspace`** — either the launch dir (`docker_mount_cwd_to_workspace`,
  default **false**, `:668-707`), a persistent bind-mount, or an ephemeral tmpfs
  (`:687-696`). Fresh and empty unless configured.
- **`/root`** — a persistent container home (`:685`), **not** the host `~`.
- **Skills dir** — `~/.hermes/skills/` auto-mounted **read-only** (`:747-762`),
  plus credential files declared by skills (`:709-736`).

Crucially, **the host's `~` and project directories are *not* present** unless
you explicitly mount them via `docker_volumes`. Identity mapping (`<path>:<path>`)
makes a granted host path reachable at the same absolute path in the container,
but nothing else on the host exists there.

## 4. Root cause of the reported "missing tools"

Reconstructing the incident from disk (`~/.hermes/.env` lines 330-332,
`~/.hermes/config.yaml` line 51-53):

```
TERMINAL_ENV=docker
TERMINAL_DOCKER_VOLUMES="[\"/home/kiddo/vault/projects/hermes/architecture-decisions.md:/home/kiddo/vault/projects/hermes/architecture-decisions.md\"]"
TERMINAL_DOCKER_RUN_AS_HOST_USER=true
```

So the **main/router profile** was switched to the Docker backend with **exactly
one file** mounted. From the agent's perspective inside that container:

- `terminal` — runs, but the shell is in a bare container; none of its usual
  host working files exist → "I have no terminal access to my files."
- `read_file` / `write_file` — execute in-container; every path it knew
  (`~/…`, project dirs) is absent → "read_file / write_file are gone."
- `execute_code` — runs, but can only write into `/workspace`/`/tmp` (tmpfs) or
  the one mounted file's dir; it cannot write the host paths the agent expected
  → "execute_code is blocked for file writes."

That is the isolation contract working exactly as designed. The failure was not
Hermes dropping tools — it was **(a)** writing Docker config to the wrong profile
(the router the agent actually runs on) and **(b)** granting almost nothing.

## 5. Which capabilities *should* be available, and how to keep them

There is no separate "enable the tools" switch. Tool availability under Docker is
**exactly the union of the mounted paths** (plus the auto-mounted read-only
skills dir, `/workspace`, `/root`). To preserve the functionality an agent needs
while keeping isolation:

- Grant the agent's **workspace / project directories `rw`** so `write_file`,
  `execute_code`, and `terminal` can produce and modify files that land on the
  host (`docker_run_as_host_user: true`, which the plugin always sets, makes them
  host-owned — verified in `capabilities.test.ts`).
- Grant **reference material `ro`** so `read_file` works without write risk.
- Leave everything else **Denied** (unmounted) — that is the point.
- Skills keep working automatically (Hermes read-only-mounts `~/.hermes/skills`).

If an agent genuinely needs broad host access, that profile is a poor fit for
Docker isolation — the honest choice is to not switch it, rather than to mount
`~` (which the plugin refuses anyway, `validatePath`).

## 6. Known limitations / best practices (from the docs)

- **One container per profile, shared across sessions and subagents.** Parallel
  `delegate_task` subagents share it — concurrent `cd`/writes to the same path
  collide (`configuration.md`).
- **Persistence:** filesystem state and installed packages survive process exits
  and `docker start`; **in-container background processes do not** survive a
  restart/OOM.
- **`docker_extra_args`** can silently weaken isolation (overriding cap drops,
  `--user`, the workspace mount) — the plugin does not use it.
- **`docker_network`** defaults to `true`; set `false` for `--network=none`.
- **Podman** is supported via `HERMES_DOCKER_BINARY=podman`.
- **Mount sources must exist** — Docker auto-creates a missing bind source as a
  root-owned dir. The plugin guards this: `rw`/`ro` grants must already exist
  (`worker.ts` `set-profile-access`), and denied-under-mounted paths are masked
  with an empty `0555` dir.

## 7. What this release changes

- **Targeting fixed** — config is written only to the profile(s) the user
  selects; the router/default profile is touched only when explicitly chosen
  (`profiles.ts`, `worker.ts`, `targeting.spec.ts`).
- **Discovery** — profiles are scanned from `~/.hermes/profiles` at request time
  (`profiles.spec.ts`).
- **UI honesty** — the editor warns when a save would grant **zero** paths,
  explaining that Docker-backed tools then can't reach the host filesystem.
- **Capability test** — `capabilities.test.ts` proves the tool surface
  (terminal/read/write/execute) is retained over granted mounts on real Docker,
  while `:ro` and denied-masking isolation still hold.
