import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAIN_PROFILE_NAME,
  discoverProfiles,
  isValidProfileName,
  profileHome,
} from "../src/profiles.ts";

const temps: string[] = [];

afterEach(async () => {
  for (const t of temps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

/** Build a fake Hermes root with a main profile + named specialized profiles. */
async function makeHermesRoot(opts: {
  main?: boolean;
  profiles?: { name: string; marker?: "config.yaml" | ".env" | "none" }[];
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fam-hermes-"));
  temps.push(root);
  if (opts.main !== false) {
    await fs.writeFile(path.join(root, "config.yaml"), "terminal:\n  backend: local\n");
  }
  for (const p of opts.profiles ?? []) {
    const dir = path.join(root, "profiles", p.name);
    await fs.mkdir(dir, { recursive: true });
    if (p.marker === "config.yaml" || p.marker === undefined) {
      await fs.writeFile(path.join(dir, "config.yaml"), "terminal:\n  backend: local\n");
    } else if (p.marker === ".env") {
      await fs.writeFile(path.join(dir, ".env"), "FOO=bar\n");
    }
    // marker === "none" → directory with no HERMES_HOME markers
  }
  return root;
}

describe("isValidProfileName", () => {
  test("accepts main and normal names", () => {
    expect(isValidProfileName(MAIN_PROFILE_NAME)).toBe(true);
    expect(isValidProfileName("coder")).toBe(true);
    expect(isValidProfileName("ord-analyst")).toBe(true);
    expect(isValidProfileName("a_b.c")).toBe(true);
  });
  test("rejects traversal and separators", () => {
    expect(isValidProfileName("..")).toBe(false);
    expect(isValidProfileName(".")).toBe(false);
    expect(isValidProfileName("a/b")).toBe(false);
    expect(isValidProfileName("../evil")).toBe(false);
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName(".hidden")).toBe(false);
  });
});

describe("profileHome", () => {
  test("main maps to the root itself", () => {
    expect(profileHome(MAIN_PROFILE_NAME, "/h/.hermes")).toBe("/h/.hermes");
  });
  test("specialized maps under profiles/", () => {
    expect(profileHome("coder", "/h/.hermes")).toBe("/h/.hermes/profiles/coder");
  });
  test("rejects traversal names", () => {
    expect(() => profileHome("..", "/h/.hermes")).toThrow(/Invalid profile/);
    expect(() => profileHome("a/b", "/h/.hermes")).toThrow(/Invalid profile/);
  });
});

describe("discoverProfiles", () => {
  test("lists main first, then specialized profiles alphabetically", async () => {
    const root = await makeHermesRoot({
      profiles: [{ name: "writer" }, { name: "coder" }, { name: "ord-analyst" }],
    });
    const found = await discoverProfiles(root);
    expect(found.map((p) => p.name)).toEqual(["main", "coder", "ord-analyst", "writer"]);
    expect(found[0]).toEqual({ name: "main", hermesHome: root, isMain: true });
    expect(found.find((p) => p.name === "coder")).toEqual({
      name: "coder",
      hermesHome: path.join(root, "profiles", "coder"),
      isMain: false,
    });
  });

  test("accepts a profile marked only by .env", async () => {
    const root = await makeHermesRoot({ profiles: [{ name: "life", marker: ".env" }] });
    const found = await discoverProfiles(root);
    expect(found.map((p) => p.name)).toContain("life");
  });

  test("skips directories that are not HERMES_HOMEs", async () => {
    const root = await makeHermesRoot({
      profiles: [{ name: "real" }, { name: "empty", marker: "none" }],
    });
    const found = await discoverProfiles(root);
    expect(found.map((p) => p.name)).toEqual(["main", "real"]);
  });

  test("main-only install (no profiles/ dir) returns just main", async () => {
    const root = await makeHermesRoot({});
    const found = await discoverProfiles(root);
    expect(found.map((p) => p.name)).toEqual(["main"]);
  });

  test("no main markers → main omitted", async () => {
    const root = await makeHermesRoot({ main: false, profiles: [{ name: "coder" }] });
    const found = await discoverProfiles(root);
    expect(found.map((p) => p.name)).toEqual(["coder"]);
  });
});
