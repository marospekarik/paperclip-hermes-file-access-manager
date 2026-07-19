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
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping translation.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

// Configuration translation: the SAME permissions must survive every hop —
// UI selections → plugin assignments → docker_volumes → running container —
// with no loss or ambiguity.
d("Configuration translation (no loss end-to-end)", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;
  let assignments: Assignment[];
  let volumes: string[];

  beforeAll(async () => {
    ws = await makeWorkspace();
    await fs.mkdir(ws.at("rw"), { recursive: true });
    await fs.mkdir(ws.at("ro"), { recursive: true });
    await fs.mkdir(ws.at("rw/denied"), { recursive: true });
    await fs.writeFile(ws.at("rw/f.txt"), "rw\n");
    await fs.writeFile(ws.at("ro/f.txt"), "ro\n");
    await fs.writeFile(ws.at("rw/denied/f.txt"), "hidden\n");
    mask = await makeMaskDir();

    // The exact assignments a UI save would produce (normalized abs paths).
    assignments = [
      { path: ws.at("rw"), mode: "rw" },
      { path: ws.at("ro"), mode: "ro" },
      { path: ws.at("rw/denied"), mode: "denied" },
    ];
    volumes = volumesFor(assignments, mask.dir);
    c = await runContainer(volumes);
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("the generated docker_volumes are exactly the expected specs (no loss)", () => {
    expect(volumes).toEqual([
      `${ws.at("ro")}:${ws.at("ro")}:ro`,
      `${ws.at("rw")}:${ws.at("rw")}`,
      `${mask.dir}:${ws.at("rw/denied")}:ro`,
    ]);
  });

  test("the running container reflects exactly those permissions", async () => {
    // rw → writable
    expect((await c.exec(`echo x > ${ws.at("rw")}/new`)).code).toBe(0);
    expect(await c.mountIsRW(ws.at("rw"))).toBe(true);
    // ro → read but not write
    expect((await c.exec(`cat ${ws.at("ro")}/f.txt`)).stdout).toContain("ro");
    expect((await c.exec(`echo x > ${ws.at("ro")}/new`)).code).not.toBe(0);
    expect(await c.mountIsRW(ws.at("ro"))).toBe(false);
    // denied child → masked/hidden
    expect((await c.exec(`cat ${ws.at("rw/denied")}/f.txt`)).code).not.toBe(0);
    expect((await c.exec(`ls -A ${ws.at("rw/denied")}`)).stdout.trim()).toBe("");
  });
});
