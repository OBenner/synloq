import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexNudgerPaths, loadCodexNudgerConfig } from "../../src/config/codex-nudger.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore, type TeamState } from "../../src/config/team-state.js";
import type { QueueNudgeOptions, QueueResult } from "../../src/host/codex/queue.js";
import { startCodexNudger } from "../../src/relay/codex-nudger-lifecycle.js";
import { StaticParticipantDirectory } from "../../src/relay/participant-directory.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { serveCommand } from "../../src/cli/commands.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "synloq-codex-life-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = await projectPaths(root, join(root, "home"));
  const local = codexNudgerPaths(paths);
  const messages = new SQLiteMessageStore(paths.database);
  const sessions = new SessionStore(paths.database);
  cleanups.push(() => {
    sessions.close();
    messages.close();
  });
  const team = new TeamStateStore(paths.bindings);
  const state: TeamState = {
    version: 1,
    project: "fixture",
    projectRoot: root,
    conversations: {},
    placements: { staff1: { host: "codex-desktop", state: "configured" } },
  };
  await team.write(state);
  const config = {
    version: 1,
    enabled: true,
    executable: process.execPath,
    cliVersion: "0.169.0",
    bindings: [{ agentId: "staff1", threadId: "11111111-1111-4111-8111-111111111111" }],
  };
  const configure = async (value: unknown = config) => {
    await mkdir(dirname(local.config), { recursive: true });
    await writeFile(local.config, JSON.stringify(value));
  };
  const directory = new StaticParticipantDirectory([
    { project: "fixture", agentId: "staff1", title: "Staff", role: "implementation" },
  ]);
  const queue = vi
    .fn<(options: QueueNudgeOptions) => Promise<QueueResult>>()
    .mockResolvedValue({ kind: "accepted", queueId: "22222222-2222-4222-8222-222222222222" });
  const diagnostic = vi.fn();
  function add() {
    return messages.create(
      {
        project: "fixture",
        from: "dev",
        to: "staff1",
        text: "never queue this",
        expectsReply: true,
        idempotencyKey: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      new Date().toISOString(),
      crypto.randomUUID(),
    ).message;
  }
  async function start() {
    const stop = await startCodexNudger({
      project: "fixture",
      paths,
      messages,
      sessions,
      directory,
      now: Date.now,
      queue,
      diagnostic,
    });
    cleanups.push(stop);
    return stop;
  }
  return {
    root,
    paths,
    local,
    messages,
    sessions,
    team,
    state,
    config,
    configure,
    queue,
    diagnostic,
    add,
    start,
  };
}

describe("Codex nudger opt-in and relay ownership", () => {
  it("does nothing by default, including no journal creation", async () => {
    const f = await fixture();
    f.add();
    await f.start();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.diagnostic).not.toHaveBeenCalled();
    await expect(access(f.local.ledger)).rejects.toThrow();
  });

  it.each(["opencode", "kimi-work", "generic"] as const)(
    "excludes %s and its #45 watcher",
    async (host) => {
      const f = await fixture();
      f.state.placements!.staff1!.host = host;
      await f.team.write(f.state);
      await f.configure();
      f.add();
      await f.start();
      expect(f.queue).not.toHaveBeenCalled();
      expect(f.diagnostic).toHaveBeenCalledOnce();
      await expect(access(f.local.ledger)).rejects.toThrow();
    },
  );

  it("fails closed when an active-delivery owner exists", async () => {
    const f = await fixture();
    await f.configure();
    f.add();
    f.sessions.register(
      {
        project: "fixture",
        agentId: "staff1",
        sessionId: "other-owner",
        protocolVersion: 1,
        capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
      },
      false,
    );
    await f.start();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.diagnostic).toHaveBeenCalledOnce();
  });

  it("aborts and waits for the owned in-flight queue process before closing", async () => {
    const f = await fixture();
    await f.configure();
    f.add();
    let reaped = false;
    f.queue.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          options.signal!.addEventListener("abort", () => {
            reaped = true;
            resolve({ kind: "uncertain", code: "QUEUE_INTERRUPTED" });
          });
        }),
    );
    const stop = await f.start();
    await vi.waitFor(() => expect(f.queue).toHaveBeenCalledOnce());
    await stop();
    expect(reaped).toBe(true);
    // A restart does not send again after shutdown interrupted an enqueue.
    await f.start();
    expect(f.queue).toHaveBeenCalledOnce();
  });

  it("rechecks placement before queueing after a role moves hosts", async () => {
    const f = await fixture();
    await f.configure();
    f.add();
    f.queue.mockImplementation(async (options) => {
      f.state.placements!.staff1!.host = "opencode";
      await f.team.write(f.state);
      expect(await options.beforeQueue!()).toBe(false);
      return { kind: "cancelled", code: "NO_LONGER_ELIGIBLE" };
    });
    await f.start();
    await vi.waitFor(() => expect(f.queue).toHaveBeenCalledOnce());
  });

  it.each([
    { version: 99 },
    { cliVersion: "999.0.0" },
    { executable: "codex" },
    { extra: "unexpected" },
    { bindings: [{ agentId: "staff1", threadId: "session name" }] },
    {
      bindings: [
        { agentId: "staff1", threadId: "11111111-1111-4111-8111-111111111111" },
        { agentId: "staff1", threadId: "22222222-2222-4222-8222-222222222222" },
      ],
    },
    {
      bindings: [
        { agentId: "staff1", threadId: "11111111-1111-4111-8111-111111111111" },
        { agentId: "dev", threadId: "11111111-1111-4111-8111-111111111111" },
      ],
    },
  ])("rejects unknown schema/version, inexact targets and duplicate owners", async (override) => {
    const f = await fixture();
    await f.configure({ ...f.config, ...override });
    await expect(loadCodexNudgerConfig(f.local.config)).rejects.toThrow("config is invalid");
    f.add();
    await f.start();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.diagnostic.mock.calls.flat().join("\n")).not.toContain("unexpected");
  });

  it("does not reinterpret an unknown ledger schema", async () => {
    const f = await fixture();
    await f.configure();
    f.add();
    const db = new DatabaseSync(f.local.ledger);
    db.exec("PRAGMA user_version = 99");
    db.close();
    await f.start();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.diagnostic).toHaveBeenCalledOnce();
  });

  it("serve attaches the optional service and closes it; invalid config leaves inbox available", async () => {
    const f = await fixture();
    await f.configure({ ...f.config, version: 99 });
    await writeFile(
      join(f.root, "synloq.yaml"),
      "project: fixture\nagents:\n  staff1:\n    title: Staff\n    role: Implementation\n",
    );
    const handle = await serveCommand({ projectRoot: f.root, synloqHome: f.paths.home });
    cleanups.push(() => handle.close());
    expect(handle.baseUrl).toContain("127.0.0.1");
    expect(handle.messages.nudgeCandidate("fixture", "staff1")).toBeUndefined();
    await handle.close();
    await handle.close();
  });
});
