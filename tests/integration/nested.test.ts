import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type Assignment,
  type Container,
  type Workspace,
  dockerAvailable,
  makeMaskDir,
  makeWorkspace,
  runContainer,
  volumesFor,
} from "./harness.ts";

const HAS_DOCKER = await dockerAvailable();
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping nested.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

// The exact tree from the task spec:
//   workspace/
//   ├── docs/           (Read Only)
//   ├── source/         (Read/Write)
//   │   └── secrets/    (Denied)
//   └── temp/           (Denied)
d("Nested permissions (spec tree)", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;

  beforeAll(async () => {
    ws = await makeWorkspace();
    await fs.mkdir(ws.at("docs"), { recursive: true });
    await fs.mkdir(ws.at("source/secrets"), { recursive: true });
    await fs.mkdir(ws.at("temp"), { recursive: true });
    await fs.writeFile(ws.at("docs/readme.md"), "docs\n");
    await fs.writeFile(ws.at("source/main.py"), "print(1)\n");
    await fs.writeFile(ws.at("source/secrets/key.txt"), "SECRET\n");
    await fs.writeFile(ws.at("temp/scratch.txt"), "temp\n");
    mask = await makeMaskDir();

    const assignments: Assignment[] = [
      { path: ws.at("docs"), mode: "ro" },
      { path: ws.at("source"), mode: "rw" },
      { path: ws.at("source/secrets"), mode: "denied" },
      { path: ws.at("temp"), mode: "denied" },
    ];
    c = await runContainer(volumesFor(assignments, mask.dir));
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("/docs is readable but immutable", async () => {
    expect((await c.exec(`cat ${ws.at("docs")}/readme.md`)).stdout).toContain("docs");
    const w = await c.exec(`echo x > ${ws.at("docs")}/new.md`);
    expect(w.code).not.toBe(0);
    expect(await c.mountIsRW(ws.at("docs"))).toBe(false);
  });

  test("/source is fully writable and changes reach the host", async () => {
    const r = await c.exec(`echo added > ${ws.at("source")}/added.py`);
    expect(r.code).toBe(0);
    expect(await fs.readFile(ws.at("source/added.py"), "utf8")).toContain("added");
    expect(await c.mountIsRW(ws.at("source"))).toBe(true);
  });

  test("/source/secrets is inaccessible (masked under the rw parent)", async () => {
    expect((await c.exec(`cat ${ws.at("source/secrets")}/key.txt`)).code).not.toBe(0);
    expect((await c.exec(`ls -A ${ws.at("source/secrets")}`)).stdout.trim()).toBe("");
  });

  test("/temp is inaccessible (no mounted ancestor → never mounted)", async () => {
    expect((await c.exec(`test -e ${ws.at("temp")}`)).code).not.toBe(0);
  });
});
