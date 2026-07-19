import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  isWritableLocation,
  quoteEnvValue,
  readEnvVar,
  unquoteEnvValue,
  updateTerminalConfigYaml,
  upsertEnvVars,
  writeEnvVars,
} from "../src/env-config.ts";

describe("quoteEnvValue (mirrors hermes _quote_env_value)", () => {
  test("plain value is not quoted", () => {
    expect(quoteEnvValue("docker")).toBe("docker");
    expect(quoteEnvValue("true")).toBe("true");
  });
  test("values with special chars are double-quoted and escaped", () => {
    expect(quoteEnvValue('a"b')).toBe('"a\\"b"');
    expect(quoteEnvValue("has #hash")).toBe('"has #hash"');
    expect(quoteEnvValue(" spaced ")).toBe('" spaced "');
  });
  test("JSON array round-trips through quote/unquote and JSON.parse", () => {
    const vols = ["/a:/a", "/b/c:/b/c:ro", "/mask:/b/c/secret:ro"];
    const json = JSON.stringify(vols);
    const quoted = quoteEnvValue(json);
    expect(quoted.startsWith('"')).toBe(true); // JSON contains ", so it is quoted
    expect(JSON.parse(unquoteEnvValue(quoted))).toEqual(vols);
  });
});

describe("upsertEnvVars", () => {
  test("preserves unrelated (secret) lines byte-for-byte and appends new keys", () => {
    const src = "API_KEY=hunter2\nBOT_TOKEN=abc#notacomment-quoted\n";
    const out = upsertEnvVars(src, { TERMINAL_ENV: "docker" });
    expect(out).toContain("API_KEY=hunter2");
    expect(out).toContain("BOT_TOKEN=abc#notacomment-quoted");
    expect(out).toContain("TERMINAL_ENV=docker");
    // the original two lines are untouched
    expect(out.startsWith("API_KEY=hunter2\nBOT_TOKEN=abc#notacomment-quoted\n")).toBe(true);
  });

  test("replaces an existing key in place without duplicating", () => {
    const src = "TERMINAL_ENV=local\nX=1\n";
    const out = upsertEnvVars(src, { TERMINAL_ENV: "docker" });
    expect(out.match(/TERMINAL_ENV=/g)?.length).toBe(1);
    expect(out).toContain("TERMINAL_ENV=docker");
    expect(out).toContain("X=1");
  });

  test("null removes a key entirely", () => {
    const src = "TERMINAL_ENV=docker\nKEEP=1\n";
    const out = upsertEnvVars(src, { TERMINAL_ENV: null });
    expect(out).not.toContain("TERMINAL_ENV");
    expect(out).toContain("KEEP=1");
  });

  test("CRLF files stay CRLF", () => {
    const src = "A=1\r\nB=2\r\n";
    const out = upsertEnvVars(src, { TERMINAL_ENV: "docker" });
    expect(out.includes("\r\n")).toBe(true);
    expect(out.includes("\n\n")).toBe(false);
    expect(out).toContain("A=1\r\n");
  });

  test("handles a file with no trailing newline", () => {
    const out = upsertEnvVars("A=1", { TERMINAL_ENV: "docker" });
    expect(out).toContain("A=1");
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("updateTerminalConfigYaml", () => {
  const src = `# top comment
model:
  api_key: secret-value  # inline comment
terminal:
  backend: local
  docker_image: nikolaik/python-nodejs:python3.11-nodejs20  # keep me
  persistent_shell: true
`;

  test("sets terminal.* keys, preserves comments and unrelated keys", () => {
    const out = updateTerminalConfigYaml(src, {
      backend: "docker",
      docker_volumes: ["/a:/a", "/b:/b:ro"],
      docker_run_as_host_user: true,
    });
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline comment");
    expect(out).toContain("# keep me");
    const parsed = parseYaml(out);
    expect(parsed.terminal.backend).toBe("docker");
    expect(parsed.terminal.docker_volumes).toEqual(["/a:/a", "/b:/b:ro"]);
    expect(parsed.terminal.docker_run_as_host_user).toBe(true);
    // unrelated keys survive
    expect(parsed.model.api_key).toBe("secret-value");
    expect(parsed.terminal.docker_image).toBe("nikolaik/python-nodejs:python3.11-nodejs20");
    expect(parsed.terminal.persistent_shell).toBe(true);
  });

  test("creates the terminal block when absent", () => {
    const out = updateTerminalConfigYaml("model:\n  x: 1\n", {
      backend: "docker",
      docker_volumes: [],
      docker_run_as_host_user: true,
    });
    const parsed = parseYaml(out);
    expect(parsed.terminal.backend).toBe("docker");
    expect(parsed.model.x).toBe(1);
  });
});

describe("isWritableLocation (Hermes root need not live under $HOME)", () => {
  test("permits a Hermes root outside $HOME/$TMPDIR when vouched for via extraRoots", () => {
    // A system-wide install or FAM_HERMES_ROOT override — must be writable.
    expect(isWritableLocation("/opt/hermes", ["/opt/hermes"])).toBe(true);
    expect(isWritableLocation("/opt/hermes/.env", ["/opt/hermes"])).toBe(true);
    expect(isWritableLocation("/srv/agents/hermes/config.yaml", ["/srv/agents/hermes"])).toBe(true);
  });

  test("still blocks a target under no allowed root (defense-in-depth holds)", () => {
    expect(isWritableLocation("/etc/passwd", ["/opt/hermes"])).toBe(false);
    expect(isWritableLocation("/opt/hermes", [])).toBe(false);
    // Prefix-but-not-descendant must not slip through (/opt/hermes-evil vs /opt/hermes).
    expect(isWritableLocation("/opt/hermes-evil/.env", ["/opt/hermes"])).toBe(false);
  });

  test("always permits $HOME and $TMPDIR (baseline)", () => {
    expect(isWritableLocation(path.join(os.homedir(), ".hermes", ".env"))).toBe(true);
    expect(isWritableLocation(path.join(os.tmpdir(), "x", ".env"))).toBe(true);
  });
});

describe("writeEnvVars (atomic, temp-dir)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  test("creates .env and later preserves other lines", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fam-env-"));
    dirs.push(home);
    await fs.writeFile(path.join(home, ".env"), "SECRET=keepme\n");
    await writeEnvVars(home, {
      TERMINAL_ENV: "docker",
      TERMINAL_DOCKER_VOLUMES: JSON.stringify(["/a:/a"]),
    });
    const txt = await fs.readFile(path.join(home, ".env"), "utf8");
    expect(txt).toContain("SECRET=keepme");
    expect(txt).toContain("TERMINAL_ENV=docker");
    // JSON value is quoted+escaped and round-trips
    const line = txt.split("\n").find((l) => l.startsWith("TERMINAL_DOCKER_VOLUMES="))!;
    const raw = line.slice("TERMINAL_DOCKER_VOLUMES=".length);
    expect(JSON.parse(unquoteEnvValue(raw))).toEqual(["/a:/a"]);
  });
});

describe("readEnvVar", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  test("reads an unquoted key, returns null for missing key/file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fam-read-"));
    dirs.push(home);
    expect(await readEnvVar(home, "HERMES_DOCKER_BINARY")).toBeNull(); // no .env yet
    await fs.writeFile(
      path.join(home, ".env"),
      'API_KEY=secret\nexport HERMES_DOCKER_BINARY=podman\nQUOTED="has space"\n',
    );
    expect(await readEnvVar(home, "HERMES_DOCKER_BINARY")).toBe("podman"); // handles `export `
    expect(await readEnvVar(home, "QUOTED")).toBe("has space"); // unquotes
    expect(await readEnvVar(home, "MISSING")).toBeNull();
  });
});
