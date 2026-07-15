import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ENV_KEY,
  parseRoots,
  readRoots,
  resolveHermesHome,
  upsertRootsLine,
  validateRoot,
  writeRoots,
} from "../src/hermes.ts";

async function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fam-test-"));
}

describe("validateRoot", () => {
  test("accepts absolute and ~/ paths", () => {
    expect(validateRoot("/home/kiddo/project")).toBeNull();
    expect(validateRoot("~/vault")).toBeNull();
  });

  test("rejects relative, colon, newline, empty", () => {
    expect(validateRoot("relative/path")).not.toBeNull();
    expect(validateRoot("/a:/b")).not.toBeNull();
    expect(validateRoot("/a\nb")).not.toBeNull();
    expect(validateRoot("   ")).not.toBeNull();
  });

  test("rejects characters that break unquoted .env parsing", () => {
    expect(validateRoot("/path with space")).not.toBeNull();
    expect(validateRoot("/path#comment")).not.toBeNull();
    expect(validateRoot('/path"quoted')).not.toBeNull();
    expect(validateRoot("/path'quoted")).not.toBeNull();
    expect(validateRoot("/path\\escaped")).not.toBeNull();
  });
});

describe("parseRoots / upsertRootsLine", () => {
  test("parses colon-separated roots, with or without export prefix", () => {
    expect(parseRoots(`${ENV_KEY}=/a:/b/c\n`)).toEqual(["/a", "/b/c"]);
    expect(parseRoots(`export ${ENV_KEY}=/x\n`)).toEqual(["/x"]);
    expect(parseRoots("OTHER=1\n")).toEqual([]);
  });

  test("preserves unrelated lines byte-identically", () => {
    const env = `# comment\nDISCORD_BOT_TOKEN=abc==def\n\n${ENV_KEY}=/old\nZAI_API_KEY=xyz:123\n`;
    const next = upsertRootsLine(env, ["/new1", "/new2"]);
    expect(next).toBe(
      `# comment\nDISCORD_BOT_TOKEN=abc==def\n\n${ENV_KEY}=/new1:/new2\nZAI_API_KEY=xyz:123\n`,
    );
  });

  test("appends when key absent, keeping trailing newline", () => {
    const next = upsertRootsLine("A=1\n", ["/r"]);
    expect(next).toBe(`A=1\n${ENV_KEY}=/r\n`);
  });

  test("removes the line when roots are empty", () => {
    const next = upsertRootsLine(`A=1\n${ENV_KEY}=/r\nB=2\n`, []);
    expect(next).toBe("A=1\nB=2\n");
  });

  test("collapses duplicate key lines into one", () => {
    const next = upsertRootsLine(`${ENV_KEY}=/a\n${ENV_KEY}=/b\n`, ["/c"]);
    expect(next.split("\n").filter((l) => l.startsWith(ENV_KEY))).toHaveLength(1);
  });

  test("CRLF files: parse works and replace keeps CRLF with no duplicate line", () => {
    const crlf = `A=1\r\n${ENV_KEY}=/old\r\nB=2\r\n`;
    expect(parseRoots(crlf)).toEqual(["/old"]);
    const next = upsertRootsLine(crlf, ["/new"]);
    expect(next).toBe(`A=1\r\n${ENV_KEY}=/new\r\nB=2\r\n`);
    expect(next.split(/\r?\n/).filter((l) => l.startsWith(ENV_KEY))).toHaveLength(1);
  });

  test("quoted values unwrap on parse", () => {
    expect(parseRoots(`${ENV_KEY}="/a:/b"\n`)).toEqual(["/a", "/b"]);
    expect(parseRoots(`${ENV_KEY}='/x'\n`)).toEqual(["/x"]);
  });

  test("duplicate roots dedupe on parse", () => {
    expect(parseRoots(`${ENV_KEY}=/a:/a:/b\n`)).toEqual(["/a", "/b"]);
  });

  test("file without trailing newline gains one on replace", () => {
    const next = upsertRootsLine(`A=1\n${ENV_KEY}=/old`, ["/new"]);
    expect(next).toBe(`A=1\n${ENV_KEY}=/new\n`);
  });
});

describe("readRoots / writeRoots (filesystem)", () => {
  test("missing .env reads as no roots; write creates it", async () => {
    const home = await tmpHome();
    expect(await readRoots(home)).toEqual([]);
    await writeRoots(home, ["/data", "~/vault"]);
    const written = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(written).toBe(`${ENV_KEY}=/data:~/vault\n`);
    expect(await readRoots(home)).toEqual(["/data", "~/vault"]);
  });

  test("write preserves existing secrets and replaces in place", async () => {
    const home = await tmpHome();
    const original = `TOKEN=se=cr:et\n${ENV_KEY}=/old\n# tail comment\n`;
    await fs.writeFile(path.join(home, ".env"), original);
    await writeRoots(home, ["/new"]);
    const written = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(written).toBe(`TOKEN=se=cr:et\n${ENV_KEY}=/new\n# tail comment\n`);
  });

  test("empty roots removes the line", async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, ".env"), `A=1\n${ENV_KEY}=/x\n`);
    await writeRoots(home, []);
    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe("A=1\n");
  });

  test("invalid root rejects before touching the file", async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, ".env"), "A=1\n");
    await expect(writeRoots(home, ["bad/relative"])).rejects.toThrow(
      "Invalid write root",
    );
    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe("A=1\n");
  });

  test("no temp files left behind", async () => {
    const home = await tmpHome();
    await writeRoots(home, ["/data"]);
    const entries = await fs.readdir(home);
    expect(entries).toEqual([".env"]);
  });

  test("refuses to write outside home and tmp directories", async () => {
    await expect(writeRoots("/etc/fake-hermes", ["/data"])).rejects.toThrow(
      "Refusing to write",
    );
  });
});

describe("resolveHermesHome", () => {
  test("reads adapterConfig.env.HERMES_HOME", () => {
    expect(
      resolveHermesHome({ env: { HERMES_HOME: "/home/kiddo/.hermes/profiles/ord-engineer" } }),
    ).toBe("/home/kiddo/.hermes/profiles/ord-engineer");
  });

  test("falls back to ~/.hermes", () => {
    expect(resolveHermesHome({})).toBe(path.join(os.homedir(), ".hermes"));
    expect(resolveHermesHome(undefined)).toBe(path.join(os.homedir(), ".hermes"));
  });
});
