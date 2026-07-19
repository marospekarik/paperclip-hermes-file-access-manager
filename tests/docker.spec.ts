import { describe, expect, test } from "bun:test";
import { expandHome, isHomeDir, normalizeHostPath, validatePath } from "../src/docker.ts";

const HOME = "/home/u";

describe("expandHome", () => {
  test("expands ~ and ~/", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/proj", HOME)).toBe("/home/u/proj");
    expect(expandHome("/abs", HOME)).toBe("/abs");
  });
});

describe("normalizeHostPath", () => {
  test("resolves . / .. and strips trailing slash", () => {
    expect(normalizeHostPath("/a/b/../c/", HOME)).toBe("/a/c");
    expect(normalizeHostPath("~/x/", HOME)).toBe("/home/u/x");
  });
  test("root stays root", () => {
    expect(normalizeHostPath("/", HOME)).toBe("/");
  });
});

describe("validatePath", () => {
  test("accepts an absolute subdirectory", () => {
    expect(validatePath("/home/u/proj", HOME)).toBeNull();
    expect(validatePath("~/proj", HOME)).toBeNull();
  });
  test("rejects relative paths", () => {
    expect(validatePath("proj", HOME)).toMatch(/absolute/);
  });
  test("rejects the filesystem root", () => {
    expect(validatePath("/", HOME)).toMatch(/root/);
  });
  test("allows the whole home directory (broad-access grant)", () => {
    expect(validatePath("/home/u", HOME)).toBeNull();
    expect(validatePath("~", HOME)).toBeNull();
  });
  test("isHomeDir detects the home directory (broad-access grant)", () => {
    expect(isHomeDir("/home/u", HOME)).toBe(true);
    expect(isHomeDir("~", HOME)).toBe(true);
    expect(isHomeDir("/home/u/proj", HOME)).toBe(false);
  });
  test("rejects embedded colon, newline, NUL, empty", () => {
    expect(validatePath("/a:b", HOME)).toMatch(/':'/);
    expect(validatePath("/a\nb", HOME)).toMatch(/newline/);
    expect(validatePath("/a\0b", HOME)).toMatch(/NUL/);
    expect(validatePath("   ", HOME)).toMatch(/empty/);
  });
});
