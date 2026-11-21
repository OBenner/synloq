import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  relayStartArgv,
  runRelaySupervisor,
  type RelayStartOptions,
  type RelaySupervisorOptions,
} from "../../src/cli/relay-supervisor.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(overrides: Partial<RelaySupervisorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "synloq-supervisor-"));
  dirs.push(root);
  const home = join(root, ".synloq");
  const started: RelayStartOptions[] = [];
  const options: RelaySupervisorOptions = {
    projectRoot: root,
    synloqHome: home,
    startRelay: (input) => started.push(input),
    ...overrides,
  };
  return { root, home, started, options };
}

describe("relay supervisor (#166)", () => {
  it("does nothing when the relay answers health", async () => {
    const { started, options } = fixture({ probeHealth: async () => true });
    expect(await runRelaySupervisor(options)).toBe("healthy");
    expect(started).toHaveLength(0);
  });

  it("starts the relay once when health fails, then cools down", async () => {
    const { started, options } = fixture({ probeHealth: async () => false });

    expect(await runRelaySupervisor(options)).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ port: 4100 });

    // The next tick within the cooldown window starts nothing.
    expect(await runRelaySupervisor(options)).toBe("cooldown");
    expect(started).toHaveLength(1);
  });

  it("two concurrent runs start the relay exactly once", async () => {
    const { started, options } = fixture({ probeHealth: async () => false });
    const outcomes = await Promise.all([runRelaySupervisor(options), runRelaySupervisor(options)]);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it("cleans up a stale supervisor lock owned by a dead pid", async () => {
    const { options, started } = fixture({ probeHealth: async () => false });
    const { projectPaths } = await import("../../src/config/paths.js");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const lockPath = `${paths.database}.relay-supervisor.lock`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(paths.home, "data"), { recursive: true });
    // A lock owned by a process that no longer exists.
    writeFileSync(lockPath, `${JSON.stringify({ pid: 4_000_000_001 })}\n`, { flag: "wx" });

    const outcome = await runRelaySupervisor({
      ...options,
      probePid: () => "dead",
    });
    expect(outcome).toBe("started");
    expect(started).toHaveLength(1);
  });

  it("never touches the serve lock", async () => {
    const { options } = fixture({ probeHealth: async () => false });
    const { projectPaths } = await import("../../src/config/paths.js");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const serveLock = `${paths.database}.serve.lock`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(paths.home, "data"), { recursive: true });
    writeFileSync(serveLock, "do-not-touch", "utf8");

    await runRelaySupervisor(options);

    expect(existsSync(serveLock)).toBe(true);
    expect(readFileSync(serveLock, "utf8")).toBe("do-not-touch");
  });

  it("bounds its own log to the last 200 lines", async () => {
    const { options } = fixture({ probeHealth: async () => false });
    const { projectPaths } = await import("../../src/config/paths.js");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const logPath = `${paths.database}.relay-supervisor.log`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(paths.home, "data"), { recursive: true });
    writeFileSync(logPath, `${"old line\n".repeat(250)}`, "utf8");

    await runRelaySupervisor(options);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.at(-1)).toContain("started detached serve");
  });

  it("a stale cooldown marker expires and a new attempt proceeds", async () => {
    let now = Date.parse("2026-11-21T10:00:00.000Z");
    const { started, options } = fixture({ probeHealth: async () => false, now: () => now });

    expect(await runRelaySupervisor(options)).toBe("started");
    now += 10 * 60_000 + 1; // past the cooldown window
    expect(await runRelaySupervisor(options)).toBe("started");
    expect(started).toHaveLength(2);
  });

  it("treats a dead-PID probe failure conservatively when liveness is unknown", async () => {
    const { options, started } = fixture({ probeHealth: async () => false });
    const { projectPaths } = await import("../../src/config/paths.js");
    const paths = await projectPaths(options.projectRoot, options.synloqHome);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(paths.home, "data"), { recursive: true });
    writeFileSync(`${paths.database}.relay-supervisor.lock`, `${JSON.stringify({ pid: 1234 })}\n`, {
      flag: "wx",
    });

    const outcome = await runRelaySupervisor({ ...options, probePid: () => "unknown" });
    expect(outcome).toBe("already-starting");
    expect(started).toHaveLength(0);
  });

  it("passes a custom synloq-home through to the spawned serve (CTO merge blocker)", async () => {
    const { started, options } = fixture({ probeHealth: async () => false });
    await runRelaySupervisor(options);

    // Plumbing: the supervisor's home reaches the start options.
    expect(started[0]?.synloqHome).toBe(options.synloqHome);
    // …and the default starter puts it on argv.
    const home = options.synloqHome;
    expect(home).toBeDefined();
    const argv = relayStartArgv({
      projectRoot: options.projectRoot,
      port: 4100,
      synloqHome: home!,
    });
    const flagAt = argv.indexOf("--synloq-home");
    expect(flagAt).toBeGreaterThan(-1);
    expect(argv[flagAt + 1]).toBe(options.synloqHome);
  });
});
