// Tool-capability retention test for Docker-backed profiles.
//
// Hermes routes terminal, read_file, write_file, and execute_code through the
// SAME container `execute()` path (tools/file_operations.py ShellFileOperations
// wraps the terminal backend). So a container started with the exact volume set
// the plugin generates faithfully reproduces the tool surface an agent sees.
//
// This asserts the fix's core claim: a profile switched to the Docker backend
// WITH the granted mounts still has working terminal / read / write / execute
// capabilities over the granted paths — the "missing tools" symptom only occurs
// when nothing is granted, which is now surfaced and warned about in the UI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  type Container,
  type Workspace,
  dockerAvailable,
  makeMaskDir,
  makeWorkspace,
  runContainer,
  volumesFor,
} from "./harness.ts";

const HAS_DOCKER = await dockerAvailable();
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping capabilities.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

d("Docker-backed profile retains tool capabilities over granted paths", () => {
  let work: Workspace; // granted R/W (agent's writable workspace)
  let ref: Workspace; // granted read-only (reference material)
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;

  beforeAll(async () => {
    work = await makeWorkspace();
    ref = await makeWorkspace();
    await fs.writeFile(ref.at("reference.md"), "read me\n");
    mask = await makeMaskDir();
    // Simulate a realistic grant set: rw workspace + ro reference + a denied
    // secret nested under the rw workspace (must stay masked).
    await fs.mkdir(work.at("secret"), { recursive: true });
    await fs.writeFile(work.at("secret/creds.txt"), "TOP SECRET\n");
    c = await runContainer(
      volumesFor(
        [
          { path: work.root, mode: "rw" },
          { path: ref.root, mode: "ro" },
          { path: work.at("secret"), mode: "denied" },
        ],
        mask.dir,
      ),
    );
  });
  afterAll(async () => {
    await c?.remove();
    await work?.cleanup();
    await ref?.cleanup();
    await mask?.cleanup();
  });

  test("terminal: arbitrary shell commands execute inside the container", async () => {
    const r = await c.exec("echo hermes-terminal-ok && uname -s");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hermes-terminal-ok");
  });

  test("write_file: writing into the rw grant lands on the host", async () => {
    const r = await c.exec(`printf 'agent wrote this' > ${work.root}/note.txt`);
    expect(r.code).toBe(0);
    expect(await fs.readFile(work.at("note.txt"), "utf8")).toBe("agent wrote this");
  });

  test("read_file: reading a file from the container returns its contents", async () => {
    const r = await c.exec(`cat ${work.root}/note.txt`);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("agent wrote this");
  });

  test("read_file: read-only grant is readable", async () => {
    const r = await c.exec(`cat ${ref.root}/reference.md`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("read me");
  });

  test("execute_code: a script run in-container writes output to the rw grant", async () => {
    // execute_code routes through the same container exec; a shell script is a
    // faithful stand-in that exercises the identical filesystem surface.
    const script = `for i in 1 2 3; do echo "line $i"; done > ${work.root}/out.log`;
    const r = await c.exec(script);
    expect(r.code).toBe(0);
    const out = await fs.readFile(work.at("out.log"), "utf8");
    expect(out).toBe("line 1\nline 2\nline 3\n");
  });

  test("run_as_host_user: files created in the container are host-owned", async () => {
    await c.exec(`printf x > ${work.root}/owned.txt`);
    const st = await fs.stat(work.at("owned.txt"));
    expect(st.uid).toBe(process.getuid?.() ?? 0);
  });

  test("isolation still holds: the read-only grant rejects writes", async () => {
    const r = await c.exec(`printf nope > ${ref.root}/reference.md`);
    expect(r.code).not.toBe(0);
    expect(await fs.readFile(ref.at("reference.md"), "utf8")).toContain("read me");
  });

  test("isolation still holds: the denied nested path is masked (empty)", async () => {
    const r = await c.exec(`cat ${work.root}/secret/creds.txt 2>&1 || true`);
    expect(r.stdout).not.toContain("TOP SECRET");
    // Host content is untouched — the mask only shadows the container view.
    expect(await fs.readFile(work.at("secret/creds.txt"), "utf8")).toContain("TOP SECRET");
  });
});
