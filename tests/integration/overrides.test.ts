import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
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
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping overrides.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

// Child permissions override inherited parent permissions:
//   parent (rw) / child (ro) / grandchild (denied) — all three hold at once.
d("Permission overrides (parent rw / child ro / grandchild denied)", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;
  let parent: string, child: string, grand: string;

  beforeAll(async () => {
    ws = await makeWorkspace();
    parent = ws.at("parent");
    child = ws.at("parent/child");
    grand = ws.at("parent/child/grand");
    await fs.mkdir(grand, { recursive: true });
    await fs.writeFile(`${parent}/p.txt`, "p\n");
    await fs.writeFile(`${child}/c.txt`, "c\n");
    await fs.writeFile(`${grand}/g.txt`, "g\n");
    mask = await makeMaskDir();

    const assignments: Assignment[] = [
      { path: parent, mode: "rw" },
      { path: child, mode: "ro" },
      { path: grand, mode: "denied" },
    ];
    c = await runContainer(volumesFor(assignments, mask.dir));
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("parent is writable", async () => {
    expect((await c.exec(`echo w > ${parent}/w.txt`)).code).toBe(0);
    expect(await c.mountIsRW(parent)).toBe(true);
  });

  test("child overrides to read-only", async () => {
    expect((await c.exec(`cat ${child}/c.txt`)).stdout).toContain("c");
    expect((await c.exec(`echo x > ${child}/x.txt`)).code).not.toBe(0);
    expect(await c.mountIsRW(child)).toBe(false);
  });

  test("grandchild overrides to denied (masked, empty, unreadable)", async () => {
    expect((await c.exec(`cat ${grand}/g.txt`)).code).not.toBe(0);
    expect((await c.exec(`ls -A ${grand}`)).stdout.trim()).toBe("");
  });
});
