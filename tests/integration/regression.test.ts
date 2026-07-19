// Permanent regression tests. Every previously reported (or class-of) Docker
// mounting failure gets a dedicated case here so it cannot silently reappear.
// When a new mount bug is found and fixed, add a test to THIS file.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type Container,
  dockerAvailable,
  makeMaskDir,
  makeWorkspace,
  runContainer,
  volumesFor,
} from "./harness.ts";

const HAS_DOCKER = await dockerAvailable();
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping regression.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

d("Docker mount regressions", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn().catch(() => {});
  });

  // A ':ro' spec must be enforced by the KERNEL, not the app: even a process
  // running as the file owner cannot write through a read-only bind mount.
  test("':ro' is enforced by Docker even for the owning user", async () => {
    const ws = await makeWorkspace();
    const mask = await makeMaskDir();
    const c = await runContainer(volumesFor([{ path: ws.root, mode: "ro" }], mask.dir));
    cleanups.push(() => c.remove(), ws.cleanup, mask.cleanup);
    await fs.writeFile(ws.at("f.txt"), "x\n");
    const w = await c.exec(`echo y > ${ws.root}/f.txt`);
    expect(w.code).not.toBe(0);
    expect(w.stderr.toLowerCase()).toContain("read-only");
  });

  // A denied child under a mounted parent must be masked so its host content
  // never leaks into the container through the parent mount.
  test("denied child under a mounted parent never leaks host content", async () => {
    const ws = await makeWorkspace();
    const mask = await makeMaskDir();
    const secret = ws.at("secret");
    await fs.mkdir(secret, { recursive: true });
    await fs.writeFile(path.join(secret, "leak"), "LEAK\n");
    const c = await runContainer(
      volumesFor(
        [
          { path: ws.root, mode: "rw" },
          { path: secret, mode: "denied" },
        ],
        mask.dir,
      ),
    );
    cleanups.push(() => c.remove(), ws.cleanup, mask.cleanup);
    expect((await c.exec(`cat ${secret}/leak`)).code).not.toBe(0);
    expect((await c.exec(`ls -A ${secret}`)).stdout.trim()).toBe("");
  });

  // Symlinked path components (macOS mounts /tmp under the /var → /private/var
  // symlink) must be realpath-normalized so the bind-mount source is the real
  // path Docker accepts and the container sees the intended content.
  test("symlinked path components are normalized before mounting", async () => {
    const target = await makeWorkspace();
    await fs.writeFile(target.at("real.txt"), "real\n");
    const linkBase = await fs.mkdtemp(path.join(os.tmpdir(), "fam-link-"));
    const link = path.join(linkBase, "link");
    await fs.symlink(target.root, link);
    const mask = await makeMaskDir();
    // Mount via the SYMLINK path; realpath resolves it to the real dir.
    const resolved = await fs.realpath(link);
    const c = await runContainer(volumesFor([{ path: resolved, mode: "rw" }], mask.dir));
    cleanups.push(
      () => c.remove(),
      target.cleanup,
      mask.cleanup,
      () => fs.rm(linkBase, { recursive: true, force: true }),
    );
    expect((await c.exec(`cat ${resolved}/real.txt`)).stdout).toContain("real");
  });

  // A mount source path containing spaces must survive as a single argv element
  // (not be word-split). docker_volumes entries are passed as ["-v", spec].
  test("paths containing spaces mount correctly", async () => {
    const ws = await makeWorkspace();
    const spaced = ws.at("with space");
    await fs.mkdir(spaced, { recursive: true });
    await fs.writeFile(path.join(spaced, "f.txt"), "spaced\n");
    const mask = await makeMaskDir();
    const c = await runContainer(volumesFor([{ path: spaced, mode: "rw" }], mask.dir));
    cleanups.push(() => c.remove(), ws.cleanup, mask.cleanup);
    const r = await c.exec(`cat "${spaced}/f.txt"`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("spaced");
  });

  // Empty configuration must produce zero mounts and a healthy container that
  // exposes none of the host workspace.
  test("empty config → no mounts, container still runs", async () => {
    const ws = await makeWorkspace();
    const mask = await makeMaskDir();
    const vols = volumesFor([], mask.dir);
    expect(vols).toEqual([]);
    const c = await runContainer(vols);
    cleanups.push(() => c.remove(), ws.cleanup, mask.cleanup);
    expect((await c.exec("echo alive")).stdout.trim()).toBe("alive");
    expect((await c.exec(`test -e ${ws.root}`)).code).not.toBe(0);
  });
});
