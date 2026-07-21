import { afterEach, describe, expect, test } from "bun:test";
import {
  type CommandResult,
  type RunCommand,
  applyRuntime,
  dockerPermissionHint,
  dockerReachableStep,
  findGatewayUnit,
  overallState,
  profileLabelValue,
  recreateContainerStep,
  resolveDockerBinary,
  restartGatewayStep,
  sanitizeLabelValue,
} from "../src/apply.ts";

const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const fail = (stderr = "boom", code = 1): CommandResult => ({ ok: false, code, stdout: "", stderr });
const enoent = (): CommandResult => ({ ok: false, code: null, stdout: "", stderr: "", errno: "ENOENT" });

/** Build a RunCommand from a matcher over the joined "cmd arg arg" string. */
function runner(fn: (line: string, cmd: string, args: string[]) => CommandResult): {
  run: RunCommand;
  calls: string[];
} {
  const calls: string[] = [];
  const run: RunCommand = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return fn(line, cmd, args);
  };
  return { run, calls };
}

describe("sanitizeLabelValue", () => {
  test("keeps alnum + ._-, replaces others, caps 63, empty→unknown", () => {
    expect(sanitizeLabelValue("coder")).toBe("coder");
    expect(sanitizeLabelValue("ord/analyst:1")).toBe("ord_analyst_1");
    expect(sanitizeLabelValue("")).toBe("unknown");
    expect(sanitizeLabelValue("x".repeat(80)).length).toBe(63);
  });
});

describe("profileLabelValue", () => {
  test("main → default, specialized → name", () => {
    expect(profileLabelValue({ name: "main", isMain: true })).toBe("default");
    expect(profileLabelValue({ name: "coder", isMain: false })).toBe("coder");
  });
});

describe("resolveDockerBinary", () => {
  const saved = process.env.HERMES_DOCKER_BINARY;
  afterEach(() => {
    if (saved === undefined) delete process.env.HERMES_DOCKER_BINARY;
    else process.env.HERMES_DOCKER_BINARY = saved;
  });

  test("profile .env value wins over process env and default", () => {
    process.env.HERMES_DOCKER_BINARY = "docker";
    expect(resolveDockerBinary("podman")).toBe("podman");
    expect(resolveDockerBinary("  podman  ")).toBe("podman");
  });

  test("falls back to process env, then to docker", () => {
    process.env.HERMES_DOCKER_BINARY = "podman";
    expect(resolveDockerBinary(null)).toBe("podman");
    expect(resolveDockerBinary("")).toBe("podman");
    delete process.env.HERMES_DOCKER_BINARY;
    expect(resolveDockerBinary(null)).toBe("docker");
    expect(resolveDockerBinary(undefined)).toBe("docker");
  });
});

describe("dockerPermissionHint", () => {
  test("classifies the docker-group socket denial into actionable guidance", () => {
    const hint = dockerPermissionHint(
      "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get ...",
    );
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/usermod -aG docker/);
    expect(hint).toMatch(/restart your LOGIN SESSION/i);
    expect(hint).toMatch(/gateway alone does NOT/);
    expect(hint).toMatch(/rootless|podman/i);
  });

  test("returns null for unrelated failures (daemon down, generic errors)", () => {
    expect(dockerPermissionHint("Cannot connect to the Docker daemon. Is the daemon running?")).toBeNull();
    expect(dockerPermissionHint("no such container")).toBeNull();
    expect(dockerPermissionHint("")).toBeNull();
  });

  test("does not fire on a permission error unrelated to the socket", () => {
    expect(dockerPermissionHint("permission denied: /some/file")).toBeNull();
  });
});

describe("dockerReachableStep", () => {
  test("ok when the daemon answers", async () => {
    const { run } = runner((line) => (line.startsWith("docker info") ? ok("27.1.1") : ok()));
    const s = await dockerReachableStep(run);
    expect(s.status).toBe("ok");
    expect(s.detail).toMatch(/reachable/);
  });

  test("skipped (not failed) when the runtime is not installed", async () => {
    const { run } = runner(() => enoent());
    const s = await dockerReachableStep(run, "podman");
    expect(s.status).toBe("skipped");
    expect(s.detail).toMatch(/Podman CLI \(podman\) not installed/);
  });

  test("failed with actionable guidance on the socket-permission denial", async () => {
    const denied = "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock";
    const { run } = runner((line) => (line.startsWith("docker info") ? fail(denied) : ok()));
    const s = await dockerReachableStep(run);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/restart your LOGIN SESSION/i);
  });

  test("failed with raw stderr on an unclassified error", async () => {
    const { run } = runner((line) => (line.startsWith("docker info") ? fail("daemon not running") : ok()));
    const s = await dockerReachableStep(run);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/daemon not running/);
  });
});

describe("recreateContainerStep", () => {
  test("skips when docker is absent", async () => {
    const { run } = runner(() => enoent());
    const s = await recreateContainerStep("default", run);
    expect(s.status).toBe("skipped");
    expect(s.detail).toMatch(/not available/);
  });

  test("uses the configured runtime binary (podman) for ps and rm", async () => {
    const { run, calls } = runner((line) => (line.startsWith("podman ps") ? ok("c1\n") : ok("")));
    const s = await recreateContainerStep("coder", run, "podman");
    expect(s.status).toBe("ok");
    expect(s.label).toBe("Recreate Podman container");
    expect(calls[0].startsWith("podman ps -aq")).toBe(true);
    expect(calls.some((c) => c === "podman rm -f c1")).toBe(true);
    expect(calls.some((c) => c.startsWith("docker "))).toBe(false);
  });

  test("names the missing runtime binary when it is absent", async () => {
    const { run } = runner(() => enoent());
    const s = await recreateContainerStep("default", run, "podman");
    expect(s.status).toBe("skipped");
    expect(s.detail).toMatch(/Podman CLI \(podman\) not available/);
  });

  test("ok with no existing container", async () => {
    const { run } = runner(() => ok(""));
    const s = await recreateContainerStep("default", run);
    expect(s.status).toBe("ok");
    expect(s.detail).toMatch(/fresh one/);
  });

  test("removes existing containers", async () => {
    const { run, calls } = runner((line) => (line.startsWith("docker ps") ? ok("abc\ndef\n") : ok("")));
    const s = await recreateContainerStep("default", run);
    expect(s.status).toBe("ok");
    expect(s.detail).toMatch(/Removed 2/);
    expect(calls.some((c) => c === "docker rm -f abc def")).toBe(true);
  });

  test("fails when docker ps errors", async () => {
    const { run } = runner((line) => (line.startsWith("docker ps") ? fail("daemon down") : ok()));
    const s = await recreateContainerStep("default", run);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/daemon down/);
  });

  test("surfaces the docker-group guidance when ps is denied on the socket", async () => {
    const denied = "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock";
    const { run } = runner((line) => (line.startsWith("docker ps") ? fail(denied) : ok()));
    const s = await recreateContainerStep("default", run);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/restart your LOGIN SESSION/i);
  });

  test("targets the right profile label", async () => {
    const { run, calls } = runner(() => ok(""));
    await recreateContainerStep("coder", run);
    expect(calls[0]).toContain("label=hermes-profile=coder");
  });
});

describe("findGatewayUnit", () => {
  const listUnits = "hermes-gateway.service enabled\nhermes-gateway-coder.service enabled";
  function fakeSystemctl(homes: Record<string, string>): RunCommand {
    return runner((line, _c, args) => {
      if (line.includes("list-unit-files")) return ok(listUnits);
      if (args.includes("show")) {
        const unit = args[2];
        return ok(`Environment=HERMES_HOME=${homes[unit] ?? ""} FOO=bar`);
      }
      return ok();
    }).run;
  }

  test("matches the unit whose HERMES_HOME resolves to the profile home", async () => {
    const run = fakeSystemctl({
      "hermes-gateway.service": "/home/u/.hermes",
      "hermes-gateway-coder.service": "/home/u/.hermes/profiles/coder",
    });
    expect(await findGatewayUnit("/home/u/.hermes/profiles/coder", run)).toBe(
      "hermes-gateway-coder.service",
    );
    expect(await findGatewayUnit("/home/u/.hermes", run)).toBe("hermes-gateway.service");
  });

  test("returns null when nothing matches", async () => {
    const run = fakeSystemctl({ "hermes-gateway.service": "/home/u/.hermes" });
    expect(await findGatewayUnit("/home/u/.hermes/profiles/ghost", run)).toBeNull();
  });

  test("returns null when systemctl is absent", async () => {
    const { run } = runner(() => enoent());
    expect(await findGatewayUnit("/home/u/.hermes", run)).toBeNull();
  });
});

describe("restartGatewayStep", () => {
  const fast = { pollMs: 1, attempts: 3 };

  test("skips when no unit is found", async () => {
    const { run } = runner((line) => (line.includes("list-unit-files") ? ok("") : ok()));
    const s = await restartGatewayStep("/home/u/.hermes", run, fast);
    expect(s.status).toBe("skipped");
  });

  test("skips a gateway that is not running", async () => {
    const run = runner((line, _c, args) => {
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok("inactive");
      return ok();
    }).run;
    const s = await restartGatewayStep("/home/u/.hermes", run, fast);
    expect(s.status).toBe("skipped");
    expect(s.detail).toMatch(/left stopped/);
  });

  test("restarts an active gateway and confirms it comes back active", async () => {
    const run = runner((line, _c, args) => {
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok("active");
      if (args.includes("restart")) return ok();
      return ok();
    }).run;
    const s = await restartGatewayStep("/home/u/.hermes", run, fast);
    expect(s.status).toBe("ok");
    expect(s.detail).toMatch(/restarted and active/);
  });

  test("fails when restart errors", async () => {
    const run = runner((line, _c, args) => {
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok("active");
      if (args.includes("restart")) return fail("job failed");
      return ok();
    }).run;
    const s = await restartGatewayStep("/home/u/.hermes", run, fast);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/job failed/);
  });

  test("fails when the unit never returns to active", async () => {
    let phase = 0;
    const run = runner((line, _c, args) => {
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok(phase++ === 0 ? "active" : "activating");
      if (args.includes("restart")) return ok();
      return ok();
    }).run;
    const s = await restartGatewayStep("/home/u/.hermes", run, fast);
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/did not report active/);
  });
});

describe("applyRuntime + overallState", () => {
  test("assembles docker + gateway steps and rolls up state", async () => {
    const run = runner((line, _c, args) => {
      if (line.startsWith("docker ps")) return ok(""); // no container
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok("active");
      if (args.includes("restart")) return ok();
      return ok();
    }).run;
    const steps = await applyRuntime(
      { name: "main", isMain: true, hermesHome: "/home/u/.hermes" },
      run,
      { pollMs: 1, attempts: 2 },
    );
    expect(steps.map((s) => s.key)).toEqual(["preflight", "docker", "gateway"]);
    expect(overallState(steps)).toBe("ready");
    expect(overallState([{ key: "x", label: "x", status: "failed", detail: "" }])).toBe(
      "needs-attention",
    );
  });

  test("threads the runtime binary through to the recreate step", async () => {
    const { run, calls } = runner((line, _c, args) => {
      if (line.startsWith("podman ps")) return ok("");
      if (line.includes("list-unit-files")) return ok("");
      return ok();
    });
    const steps = await applyRuntime(
      { name: "coder", isMain: false, hermesHome: "/home/u/.hermes/profiles/coder" },
      run,
      { pollMs: 1, attempts: 1 },
      "podman",
    );
    expect(steps[0].label).toBe("Check Podman access");
    expect(steps[1].label).toBe("Recreate Podman container");
    expect(calls[0].startsWith("podman info")).toBe(true);
    expect(calls.some((c) => c.startsWith("podman ps"))).toBe(true);
    expect(calls.some((c) => c.startsWith("docker "))).toBe(false);
  });

  test("permission-denied preflight skips the recreate but still restarts the gateway", async () => {
    const denied = "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock";
    let recreateAttempted = false;
    const run = runner((line, _c, args) => {
      if (line.startsWith("docker info")) return fail(denied, 1);
      if (line.startsWith("docker ps")) { recreateAttempted = true; return ok(""); }
      if (line.includes("list-unit-files")) return ok("hermes-gateway.service enabled");
      if (args.includes("show")) return ok("Environment=HERMES_HOME=/home/u/.hermes");
      if (args.includes("is-active")) return ok("active");
      if (args.includes("restart")) return ok();
      return ok();
    }).run;
    const steps = await applyRuntime(
      { name: "main", isMain: true, hermesHome: "/home/u/.hermes" },
      run,
      { pollMs: 1, attempts: 2 },
    );
    expect(steps.map((s) => s.key)).toEqual(["preflight", "docker", "gateway"]);
    expect(steps[0].status).toBe("failed");
    expect(steps[0].detail).toMatch(/restart your LOGIN SESSION/i);
    expect(steps[1].status).toBe("skipped"); // recreate skipped, not re-failed
    expect(recreateAttempted).toBe(false); // never touched the socket again
    expect(steps[2].status).toBe("ok"); // gateway restart is independent
    expect(overallState(steps)).toBe("needs-attention");
  });
});
