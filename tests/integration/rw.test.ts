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
if (!HAS_DOCKER) console.warn("[integration] Docker unavailable — skipping rw.test.ts");
const d = HAS_DOCKER ? describe : describe.skip;

d("Read/Write mount", () => {
  let ws: Workspace;
  let mask: { dir: string; cleanup(): Promise<void> };
  let c: Container;

  beforeAll(async () => {
    ws = await makeWorkspace();
    await fs.writeFile(ws.at("existing.txt"), "hello\n");
    mask = await makeMaskDir();
    c = await runContainer(volumesFor([{ path: ws.root, mode: "rw" }], mask.dir));
  });
  afterAll(async () => {
    await c?.remove();
    await ws?.cleanup();
    await mask?.cleanup();
  });

  test("existing files can be read", async () => {
    const r = await c.exec(`cat ${ws.root}/existing.txt`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  test("new files can be created and appear on the host", async () => {
    const r = await c.exec(`echo created > ${ws.root}/new.txt`);
    expect(r.code).toBe(0);
    expect(await fs.readFile(ws.at("new.txt"), "utf8")).toContain("created");
  });

  test("existing files can be modified", async () => {
    const r = await c.exec(`echo modified > ${ws.root}/existing.txt`);
    expect(r.code).toBe(0);
    expect(await fs.readFile(ws.at("existing.txt"), "utf8")).toContain("modified");
  });

  test("files can be deleted (and the deletion shows on the host)", async () => {
    await c.exec(`echo x > ${ws.root}/del.txt`);
    const r = await c.exec(`rm ${ws.root}/del.txt`);
    expect(r.code).toBe(0);
    expect(fs.access(ws.at("del.txt"))).rejects.toThrow();
  });

  test("docker reports the mount as read-write", async () => {
    expect(await c.mountIsRW(ws.root)).toBe(true);
  });
});
