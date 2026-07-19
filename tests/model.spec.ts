import { describe, expect, test } from "bun:test";
import {
  type Assignment,
  DEFAULT_MODE,
  generateDockerVolumes,
  isAncestor,
  resolveEffectiveMode,
} from "../src/model.ts";

const MASK = "/home/u/.hermes/.file-access-deny-mask";
const gen = (a: Assignment[]) => generateDockerVolumes(a, { maskDir: MASK });

describe("resolveEffectiveMode", () => {
  test("default is denied when nothing assigned", () => {
    const r = resolveEffectiveMode("/x/y", []);
    expect(r.mode).toBe(DEFAULT_MODE);
    expect(r.mode).toBe("denied");
    expect(r.inherited).toBe(false);
  });

  test("explicit assignment on the exact path is not inherited", () => {
    const r = resolveEffectiveMode("/a", [{ path: "/a", mode: "rw" }]);
    expect(r).toEqual({ mode: "rw", inherited: false, source: null });
  });

  test("nearest ancestor wins and is marked inherited", () => {
    const a: Assignment[] = [
      { path: "/a", mode: "rw" },
      { path: "/a/b", mode: "ro" },
    ];
    const r = resolveEffectiveMode("/a/b/c", a);
    expect(r.mode).toBe("ro");
    expect(r.inherited).toBe(true);
    expect(r.source).toBe("/a/b");
  });

  test("sibling assignments do not leak across branches", () => {
    const a: Assignment[] = [{ path: "/a/x", mode: "rw" }];
    expect(resolveEffectiveMode("/a/y/z", a).mode).toBe("denied");
  });
});

describe("isAncestor", () => {
  test("prefix that is not a path boundary is not an ancestor", () => {
    expect(isAncestor("/a/foo", "/a/foobar")).toBe(false);
    expect(isAncestor("/a", "/a/b")).toBe(true);
    expect(isAncestor("/a", "/a")).toBe(false);
  });
});

describe("generateDockerVolumes", () => {
  test("rw → writable bind mount (identity)", () => {
    expect(gen([{ path: "/w", mode: "rw" }])).toEqual(["/w:/w"]);
  });

  test("ro → read-only bind mount", () => {
    expect(gen([{ path: "/d", mode: "ro" }])).toEqual(["/d:/d:ro"]);
  });

  test("denied with no mounted ancestor → not mounted at all", () => {
    expect(gen([{ path: "/secret", mode: "denied" }])).toEqual([]);
  });

  test("denied under a mounted ancestor → masked with empty ro dir", () => {
    const v = gen([
      { path: "/work", mode: "rw" },
      { path: "/work/secret", mode: "denied" },
    ]);
    expect(v).toContain("/work:/work");
    expect(v).toContain(`${MASK}:/work/secret:ro`);
  });

  test("nested spec: docs(ro)/source(rw)/source/secrets(denied)/temp(denied)", () => {
    const v = gen([
      { path: "/ws", mode: "rw" },
      { path: "/ws/docs", mode: "ro" },
      { path: "/ws/source", mode: "rw" },
      { path: "/ws/source/secrets", mode: "denied" },
      { path: "/ws/temp", mode: "denied" },
    ]);
    expect(v).toContain("/ws:/ws");
    expect(v).toContain("/ws/docs:/ws/docs:ro");
    expect(v).toContain("/ws/source:/ws/source");
    // both denied children sit under mounted ancestors → both masked
    expect(v).toContain(`${MASK}:/ws/source/secrets:ro`);
    expect(v).toContain(`${MASK}:/ws/temp:ro`);
  });

  test("override chain: parent rw / child ro / grandchild denied all emitted", () => {
    const v = gen([
      { path: "/p", mode: "rw" },
      { path: "/p/c", mode: "ro" },
      { path: "/p/c/g", mode: "denied" },
    ]);
    expect(v).toEqual([
      "/p:/p",
      "/p/c:/p/c:ro",
      `${MASK}:/p/c/g:ro`,
    ]);
  });

  test("output is deterministic (sorted by destination)", () => {
    const a: Assignment[] = [
      { path: "/z", mode: "rw" },
      { path: "/a", mode: "ro" },
      { path: "/m", mode: "rw" },
    ];
    const shuffled: Assignment[] = [a[2], a[0], a[1]];
    expect(gen(a)).toEqual(gen(shuffled));
    expect(gen(a)).toEqual(["/a:/a:ro", "/m:/m", "/z:/z"]);
  });

  test("empty assignments → empty volume list", () => {
    expect(gen([])).toEqual([]);
  });
});
