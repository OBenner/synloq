import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import { ensureRelay } from "../../src/relay/supervisor.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Participant } from "../../src/domain/message.js";

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
`;

const participants: Participant[] = [
  { project: "verdicta", agentId: "cto", title: "CTO", role: "Technical strategy" },
];

describe("serve advisory lock (#110)", () => {
  const dirs: string[] = [];
  const handles: ServeHandle[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (handles.length) await handles.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function projectDir(): { root: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), "synloq-serve-lock-"));
    dirs.push(root);
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    return { root, home: join(root, ".synloq") };
  }

  it("refuses a second serve on the same database with the owning PID and lock path", async () => {
    const { root, home } = projectDir();
    handles.push(await serveCommand({ projectRoot: root, port: 0, synloqHome: home }));

    const paths = await projectPaths(root, home);
    const error = await serveCommand({ projectRoot: root, port: 0, synloqHome: home }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SynloqError);
    expect((error as SynloqError).code).toBe("ALREADY_RUNNING");
    expect((error as SynloqError).message).toContain(`${paths.database}.serve.lock`);
    expect((error as SynloqError).message).toContain(`"pid":${process.pid}`);
  });

  it("releases the lock on close: a fresh serve succeeds afterwards", async () => {
    const { root, home } = projectDir();
    const first = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    await first.close();

    const second = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    handles.push(second);
    expect(second.baseUrl).toContain("127.0.0.1");
  });

  it("does not steal when the OS cannot determine whether the owner is alive", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const { root, home } = projectDir();
    const paths = await projectPaths(root, home);
    const lockPath = `${paths.database}.serve.lock`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 4_000_000_000, startedAt: "2026-11-17T00:00:00.000Z" })}\n`,
      "utf8",
    );

    const error = await serveCommand({ projectRoot: root, port: 0, synloqHome: home }).catch(
      (failure: unknown) => failure,
    );
    expect((error as SynloqError).code).toBe("ALREADY_RUNNING");
    expect((error as SynloqError).message).toContain("4000000000");
    expect((error as SynloqError).message).toContain("liveness unknown");
    // The stale file stays untouched — no auto-steal, no content rewrite.
    expect(readFileSync(lockPath, "utf8")).toContain("4000000000");
  });

  it("ensureRelay re-probes instead of failing when a racing channel holds the lock", async () => {
    const { root, home } = projectDir();
    // A live relay already owns the project (port 0 → ephemeral).
    handles.push(await serveCommand({ projectRoot: root, port: 0, synloqHome: home }));
    const owner = handles[0]!;
    const credential = await new CredentialStore(root, home).ensureCredential("verdicta", "cto");

    const outcome = await ensureRelay({
      projectRoot: root,
      project: "verdicta",
      relayUrl: owner.baseUrl,
      token: credential.token,
      synloqHome: home,
    });
    expect(outcome.owned).toBe(false);
    expect(outcome.baseUrl).toBe(owner.baseUrl);
    await outcome.close();
  });

  it("ensureRelay treats ALREADY_RUNNING from serve like a busy port", async () => {
    const { root, home } = projectDir();
    // auth-v2: ensureRelay authenticates the credential locally first.
    const credential = await new CredentialStore(root, home).ensureCredential("verdicta", "cto");
    const probed: string[] = [];
    const outcome = await ensureRelay({
      projectRoot: root,
      project: "verdicta",
      relayUrl: "http://127.0.0.1:4100",
      token: credential.token,
      synloqHome: home,
      // First probe misses (connection refused), serve reports the lock race,
      // the second probe sees the winner's relay.
      probe: async (relayUrl) => {
        probed.push(relayUrl);
        if (probed.length === 1) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
        return participants;
      },
      serve: async () => {
        throw new SynloqError("ALREADY_RUNNING", "another synloq serve already owns this project");
      },
    });
    expect(outcome.owned).toBe(false);
    expect(probed).toHaveLength(2);
  });
});
