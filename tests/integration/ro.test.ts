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
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping ro.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

d("Read-Only mount", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;

  beforeAll(async () => {
    ws = await makeWorkspace();
    await fs.writeFile(ws.at("readme.txt"), "readme\n");
    mask = await makeMaskDir();
    c = await runContainer(volumesFor([{ path: ws.root, mode: "ro" }], mask.dir));
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("existing files can be read", async () => {
    const r = await c.exec(`cat ${ws.root}/readme.txt`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("readme");
  });

  test("creating a new file fails (read-only filesystem)", async () => {
    const r = await c.exec(`echo x > ${ws.root}/new.txt`);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("read-only");
    await expect(fs.access(ws.at("new.txt"))).rejects.toThrow(); // nothing on host
  });

  test("modifying an existing file fails", async () => {
    const r = await c.exec(`echo mutated > ${ws.root}/readme.txt`);
    expect(r.code).not.toBe(0);
    expect(await fs.readFile(ws.at("readme.txt"), "utf8")).toBe("readme\n"); // unchanged
  });

  test("deleting a file fails", async () => {
    const r = await c.exec(`rm ${ws.root}/readme.txt`);
    expect(r.code).not.toBe(0);
    // still present and unchanged on the host
    expect(await fs.readFile(ws.at("readme.txt"), "utf8")).toBe("readme\n");
  });

  test("docker reports the mount as read-only (Docker enforces, not the app)", async () => {
    expect(await c.mountIsRW(ws.root)).toBe(false);
  });
});
