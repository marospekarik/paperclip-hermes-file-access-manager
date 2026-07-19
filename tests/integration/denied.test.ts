import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping denied.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

d("Denied path — not mounted, no mounted ancestor", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;

  beforeAll(async () => {
    ws = await makeWorkspace();
    await fs.writeFile(ws.at("private.txt"), "top secret\n");
    mask = await makeMaskDir();
    // Denied with nothing else mounted → generateDockerVolumes emits nothing.
    const vols = volumesFor([{ path: ws.root, mode: "denied" }], mask.dir);
    expect(vols).toEqual([]);
    c = await runContainer(vols);
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("the directory is not present in the container at all", async () => {
    const r = await c.exec(`test -e ${ws.root}`);
    expect(r.code).not.toBe(0);
  });

  test("the denied file cannot be read from inside", async () => {
    const r = await c.exec(`cat ${ws.root}/private.txt`);
    expect(r.code).not.toBe(0);
  });
});

d("Denied child under a mounted parent — actively masked", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;
  let secretDir: string;

  beforeAll(async () => {
    ws = await makeWorkspace();
    secretDir = ws.at("secret");
    await fs.mkdir(secretDir, { recursive: true });
    await fs.writeFile(path.join(secretDir, "leak.txt"), "should not leak\n");
    await fs.writeFile(ws.at("ok.txt"), "public\n");
    mask = await makeMaskDir();
    const vols = volumesFor(
      [
        { path: ws.root, mode: "rw" },
        { path: secretDir, mode: "denied" },
      ],
      mask.dir,
    );
    // parent mount + a mask mount over the denied child
    expect(vols).toContain(`${ws.root}:${ws.root}`);
    expect(vols).toContain(`${mask.dir}:${secretDir}:ro`);
    c = await runContainer(vols);
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("the parent is accessible", async () => {
    expect((await c.exec(`cat ${ws.root}/ok.txt`)).stdout).toContain("public");
  });

  test("the parent mount does NOT expose the denied child's contents", async () => {
    const cat = await c.exec(`cat ${secretDir}/leak.txt`);
    expect(cat.code).not.toBe(0); // masked — the real file is hidden
    const ls = await c.exec(`ls -A ${secretDir}`);
    expect(ls.stdout.trim()).toBe(""); // masked dir is empty
  });

  test("the masked child is read-only (cannot be written through)", async () => {
    const r = await c.exec(`echo x > ${secretDir}/x.txt`);
    expect(r.code).not.toBe(0);
    // and nothing leaked back to the host secret dir
    await expect(fs.access(path.join(secretDir, "x.txt"))).rejects.toThrow();
  });
});
