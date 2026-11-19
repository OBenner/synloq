import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireClaudeOwnership } from "../src/host/claude/ownership.js";
import { ClaudeNudgeLedger } from "../src/storage/claude-nudge-ledger.js";
import { NUDGE_COOLDOWN_MS } from "../src/storage/nudge-ledger.js";
import { claudeNudgePrompt, verifyClaudeTurn } from "../src/host/claude/proof.js";
import { ClaudeNudger } from "../src/relay/claude-nudger.js";
import {
  classifyClaudeResult,
  claudeNudgeArgs,
  runClaudeProcess,
  noClaudeProcesses,
  type ClaudeRunner,
} from "../src/host/claude/process.js";
import { SQLiteMessageStore } from "../src/storage/message-store.js";
import { SessionStore } from "../src/storage/session-store.js";
import { RelayService } from "../src/relay/relay-service.js";
import { ProtectionPolicy } from "../src/relay/protection.js";
import { DatabaseSync } from "node:sqlite";
import { checkpointTranscript, transcriptDelta } from "../src/host/claude/proof.js";
import { loadClaudeNudgerConfig, validateClaudeBinding } from "../src/config/claude-nudger.js";
import { startClaudeNudger } from "../src/relay/claude-nudger-lifecycle.js";
import { StaticParticipantDirectory } from "../src/relay/participant-directory.js";
import { projectPaths } from "../src/config/paths.js";
import { claudeNudgerPaths } from "../src/config/claude-nudger.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const session = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const marker = "NUDGE-ACK-00000000-0000-4000-8000-000000000003";
const directories: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "claude-nudge-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function transcript() {
  const rows = [
    { type: "user", message: { role: "user", content: claudeNudgePrompt([target], marker) } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "i", name: "mcp__synloq-arch__synloq_inbox", input: {} }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "i",
            content: JSON.stringify({ messages: [{ id: target, deliveryState: "stored" }] }),
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "mcp__synloq-arch__synloq_ack",
            input: { messageId: target },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            content: JSON.stringify({ message: { id: target, deliveryState: "acked" } }),
          },
        ],
      },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: marker }] },
    },
  ];
  return (
    rows
      .map((row, index) =>
        JSON.stringify({
          ...row,
          sessionId: session,
          uuid: String(index),
          parentUuid: index ? String(index - 1) : "prior",
        }),
      )
      .join("\n") + "\n"
  );
}

describe("Claude cooperative ownership", () => {
  it("releases idempotently when the operator has already removed the lock", async () => {
    const path = join(await temp(), `${session}.jsonl`);
    await writeFile(path, "persisted\n");
    const owner = await acquireClaudeOwnership(path, session, "nudger");
    await rm(owner.path);
    await expect(owner.release()).resolves.toBeUndefined();
    await expect(owner.release()).resolves.toBeUndefined();
  });
  it("excludes two nudgers and a cooperating manual launcher until release", async () => {
    const path = join(await temp(), `${session}.jsonl`);
    await writeFile(path, "persisted\n");
    const owner = await acquireClaudeOwnership(path, session, "nudger");
    await expect(acquireClaudeOwnership(path, session, "nudger")).rejects.toThrow();
    await expect(acquireClaudeOwnership(path, session, "manual")).rejects.toThrow();
    const competing = await runClaudeProcess(
      process.execPath,
      [
        "-e",
        "try{require('node:fs').openSync(process.argv[1],'wx');process.exitCode=9}catch(e){process.exitCode=e.code==='EEXIST'?0:8}",
        `${path}.synloq-owner.lock`,
      ],
      {},
    );
    expect(competing.exitCode).toBe(0);
    await owner.release();
    const manual = await acquireClaudeOwnership(path, session, "manual");
    await manual.release();
  });
  it("never steals a stale lock and refuses an unpersisted session", async () => {
    const path = join(await temp(), `${session}.jsonl`);
    await expect(acquireClaudeOwnership(path, session, "nudger")).rejects.toThrow();
    await writeFile(path, "persisted\n");
    await writeFile(`${path}.synloq-owner.lock`, "stale");
    await expect(acquireClaudeOwnership(path, session, "nudger")).rejects.toThrow();
  });
});

describe("persistence and local configuration", () => {
  it("rejects partial/empty persistence and replacement/truncation of the transcript", async () => {
    const dir = await temp(),
      path = join(dir, `${session}.jsonl`);
    await writeFile(path, "");
    await expect(checkpointTranscript(path, session)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify({ type: "assistant", uuid: "prior", sessionId: session }) + "\n",
    );
    const checkpoint = await checkpointTranscript(path, session);
    await writeFile(path, "x\n");
    await expect(transcriptDelta(path, checkpoint)).rejects.toThrow();
  });
  it("is off when absent, rejects secrets/unknown settings in opt-in, and validates the exact MCP role", async () => {
    const f = await serviceFixture();
    const path = join(f.binding.cwd, "config.json");
    try {
      expect(await loadClaudeNudgerConfig(path)).toBeUndefined();
      const config = {
        version: 1,
        enabled: true,
        executable: process.execPath,
        cliVersion: "2.1.326",
        bindings: [f.binding],
      };
      await writeFile(path, JSON.stringify({ ...config, token: "private" }));
      await expect(loadClaudeNudgerConfig(path)).rejects.toThrow();
      await writeFile(path, JSON.stringify({ ...config, enabled: false }));
      expect(await loadClaudeNudgerConfig(path)).toBeUndefined();
      await writeFile(
        f.binding.adapterConfig,
        JSON.stringify({
          kind: "claude",
          project: "p",
          projectRoot: f.binding.cwd,
          agentId: "arch",
          sessionId: session,
          relayUrl: "http://127.0.0.1:62000",
          credentialPath: join(f.binding.cwd, "token"),
        }),
      );
      await writeFile(f.binding.settings, "{}");
      const server = {
        command: process.execPath,
        args: ["main.js", "adapter", "--config", f.binding.adapterConfig],
      };
      await writeFile(
        f.binding.mcpConfig,
        JSON.stringify({ mcpServers: { "synloq-arch": server } }),
      );
      await expect(
        validateClaudeBinding(f.binding, "p", f.binding.cwd, "http://127.0.0.1:62000"),
      ).resolves.toBeUndefined();
      await writeFile(
        f.binding.mcpConfig,
        JSON.stringify({ mcpServers: { "synloq-cto": server } }),
      );
      await expect(
        validateClaudeBinding(f.binding, "p", f.binding.cwd, "http://127.0.0.1:62000"),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});

async function serviceFixture(
  mode: "success" | "denied" | "missing-db" | "external" | "unknown" | "graph" = "success",
) {
  const dir = await temp(),
    path = join(dir, `${session}.jsonl`),
    ledgerPath = join(dir, "ledger.sqlite");
  await writeFile(
    path,
    JSON.stringify({
      type: "assistant",
      sessionId: session,
      uuid: "prior",
      message: { role: "assistant", content: [{ type: "text", text: "READY" }] },
    }) + "\n",
  );
  if (mode === "graph")
    await appendFile(
      path,
      JSON.stringify({
        type: "system",
        subtype: "stop_hook_summary",
        sessionId: session,
        uuid: "summary",
        parentUuid: "prior",
      }) + "\n",
    );
  const ledger = new ClaudeNudgeLedger(ledgerPath),
    messages = new SQLiteMessageStore(join(dir, "relay.sqlite"));
  messages.create(
    {
      project: "p",
      from: "cto",
      to: "arch",
      text: "PRIVATE BODY MUST NOT REACH ARGV",
      expectsReply: true,
      idempotencyKey: "seed",
    },
    target,
    new Date().toISOString(),
    session,
  );
  const binding = {
    agentId: "arch",
    sessionId: session,
    cwd: dir,
    transcript: path,
    mcpConfig: join(dir, "mcp.json"),
    settings: join(dir, "settings.json"),
    adapterConfig: join(dir, "adapter.json"),
  };
  let now = 0;
  const run = vi.fn<ClaudeRunner>(async (_exe: string, args: string[]) => {
    if (args[0] === "--version")
      return { exitCode: 0, stdout: "2.1.326 (Claude Code)\n", interrupted: false };
    const actualMarker = /NUDGE-ACK-[a-f0-9-]+/.exec(args.at(-1)!)![0];
    if (mode === "success" || mode === "missing-db" || mode === "graph") {
      let turn = transcript().replaceAll(marker, actualMarker);
      if (mode === "graph") turn = turn.replace('"parentUuid":"prior"', '"parentUuid":"summary"');
      await appendFile(path, turn);
      if (mode !== "missing-db") messages.acknowledge(target, "p", "arch");
    }
    const result = {
      type: "result",
      subtype: mode === "external" ? "error_during_execution" : "success",
      session_id: session,
      is_error: mode === "external",
      permission_denials: mode === "denied" ? [{ tool_name: "inbox" }] : [],
    };
    return {
      exitCode: 0,
      stdout:
        (mode === "external"
          ? JSON.stringify({ type: "system", subtype: "api_error", error: { status: 402 } }) + "\n"
          : "") +
        JSON.stringify(result) +
        "\n",
      interrupted: mode === "unknown",
    };
  });
  const eligible = vi.fn().mockResolvedValue(true),
    processClear = vi.fn().mockResolvedValue(true);
  const nudger = new ClaudeNudger({
    project: "p",
    config: {
      version: 1,
      enabled: true,
      executable: process.execPath,
      cliVersion: "2.1.326",
      bindings: [binding],
    },
    ledger,
    now: () => now,
    run,
    eligible,
    processClear,
    candidate: () => messages.nudgeCandidate("p", "arch"),
    acknowledged: (id) => messages.isMessageAcknowledged(id, "p"),
  });
  await nudger.start();
  const outcomes = () => {
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      return db.prepare("SELECT outcome,proof FROM attempts ORDER BY rowid").all();
    } finally {
      db.close();
    }
  };
  return {
    nudger,
    run,
    eligible,
    processClear,
    binding,
    messages,
    outcomes,
    advance: () => {
      now += NUDGE_COOLDOWN_MS;
    },
    close: async () => {
      await nudger.stop();
      ledger.close();
      messages.close();
    },
  };
}

describe("event-driven Claude service", () => {
  it("passes checkpoint service ancestry through to a durable success/proof1 ledger", async () => {
    const f = await serviceFixture("graph");
    try {
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.outcomes()).toEqual([{ outcome: "success", proof: 1 }]);
    } finally {
      await f.close();
    }
  });
  it("keeps ownership until an aborted inference child actually exits", async () => {
    const f = await serviceFixture();
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    f.run.mockImplementation(async (_exe, args, options) => {
      if (args[0] === "--version")
        return { exitCode: 0, stdout: "2.1.326 (Claude Code)", interrupted: false };
      const running = runClaudeProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        options,
      );
      started();
      return running;
    });
    try {
      f.nudger.notify("arch");
      await entered;
      await expect(
        acquireClaudeOwnership(f.binding.transcript, session, "manual"),
      ).rejects.toThrow();
      await f.nudger.stop();
      expect(f.outcomes()).toEqual([{ outcome: "uncertain", proof: 0 }]);
      const manual = await acquireClaudeOwnership(f.binding.transcript, session, "manual");
      await manual.release();
    } finally {
      await f.close();
    }
  });
  it("does not backfill; a hint verifies transcript plus real SQLite, with identifiers-only argv", async () => {
    const f = await serviceFixture();
    try {
      expect(f.run).not.toHaveBeenCalled();
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.outcomes()).toEqual([{ outcome: "success", proof: 1 }]);
      expect(f.run.mock.calls[1]![1].join(" ")).not.toContain("PRIVATE BODY");
      expect(f.run.mock.calls[1]![1].slice(-2)[0]).toBe("--");
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.run).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
  it.each(["denied", "missing-db", "unknown"] as const)(
    "does not accept or blindly retry %s even at exit zero",
    async (mode) => {
      const f = await serviceFixture(mode);
      try {
        f.nudger.notify("arch");
        await f.nudger.settled();
        expect(f.outcomes()).toEqual([
          { outcome: mode === "denied" ? "denied" : "uncertain", proof: 0 },
        ]);
        f.advance();
        f.nudger.notify("arch");
        await f.nudger.settled();
        expect(f.run.mock.calls.filter((c) => c[1][0] === "-p")).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
  it("allows one classified external retry only on a new event after cooldown", async () => {
    const f = await serviceFixture("external");
    try {
      f.nudger.notify("arch");
      await f.nudger.settled();
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.outcomes()).toHaveLength(1);
      f.advance();
      expect(f.outcomes()).toHaveLength(1);
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.outcomes()).toHaveLength(2);
      f.advance();
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.outcomes()).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("skips unknown/busy process preflight without inference or reserving an attempt", async () => {
    const f = await serviceFixture();
    try {
      f.eligible.mockResolvedValue(false);
      f.nudger.notify("arch");
      await f.nudger.settled();
      f.eligible.mockResolvedValue(true);
      f.processClear.mockResolvedValue(false);
      f.nudger.notify("arch");
      await f.nudger.settled();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.outcomes()).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});

it("captures metadata-only backlog and refuses >100 instead of truncating proof", () => {
  const messages = new SQLiteMessageStore(":memory:");
  try {
    for (let index = 0; index < 100; index++)
      messages.create(
        {
          project: "p",
          from: "cto",
          to: "arch",
          text: "PRIVATE",
          expectsReply: false,
          idempotencyKey: String(index),
        },
        crypto.randomUUID(),
        new Date(index).toISOString(),
        session,
      );
    const candidates = messages.claudeNudgeCandidates("p", "arch")!;
    expect(candidates.ids).toHaveLength(100);
    expect(JSON.stringify(candidates)).not.toContain("PRIVATE");
    messages.create(
      {
        project: "p",
        from: "cto",
        to: "arch",
        text: "PRIVATE",
        expectsReply: false,
        idempotencyKey: "overflow",
      },
      crypto.randomUUID(),
      new Date(101).toISOString(),
      session,
    );
    expect(messages.claudeNudgeCandidates("p", "arch")).toBeUndefined();
  } finally {
    messages.close();
  }
});

it("keeps paused and submitted backlog out of automatic nudges", () => {
  const messages = new SQLiteMessageStore(":memory:");
  try {
    messages.create(
      {
        project: "p",
        from: "cto",
        to: "arch",
        text: "private",
        expectsReply: false,
        idempotencyKey: "blocked",
      },
      target,
      new Date(0).toISOString(),
      session,
    );
    messages.pause("p", "thread", session, new Date(0).toISOString());
    expect(messages.claudeNudgeCandidates("p", "arch")).toBeUndefined();
    messages.resume("p", "thread", session);
    expect(messages.claudeNudgeCandidates("p", "arch")?.ids).toEqual([target]);
    messages.setDeliveryState(target, "p", "submitted");
    expect(messages.claudeNudgeCandidates("p", "arch")).toBeUndefined();
  } finally {
    messages.close();
  }
});

it("requires proof of every captured target, not only the oldest", () => {
  expect(
    verifyClaudeTurn({
      delta: transcript(),
      sessionId: session,
      agentId: "arch",
      targetId: target,
      targetIds: [target, session],
      marker,
      previousUuid: "prior",
      acknowledged: () => true,
    }),
  ).toBe(false);
});

it("releases handed-off ownership on config removal without running inference", async () => {
  const dir = await temp(),
    paths = await projectPaths(dir, join(dir, "home")),
    configPaths = claudeNudgerPaths(paths);
  const transcriptPath = join(dir, `${session}.jsonl`);
  await writeFile(
    transcriptPath,
    JSON.stringify({ type: "assistant", sessionId: session, uuid: "prior" }) + "\n",
  );
  const binding = {
    agentId: "arch",
    sessionId: session,
    cwd: dir,
    transcript: transcriptPath,
    mcpConfig: join(dir, "mcp"),
    settings: join(dir, "settings"),
    adapterConfig: join(dir, "adapter"),
  };
  await mkdir(dirname(configPaths.config), { recursive: true });
  await writeFile(
    configPaths.config,
    JSON.stringify({
      version: 1,
      enabled: true,
      executable: process.execPath,
      cliVersion: "2.1.326",
      bindings: [binding],
    }),
  );
  const messages = new SQLiteMessageStore(paths.database),
    sessions = new SessionStore(paths.database);
  const handle = await startClaudeNudger({
    project: "p",
    projectRoot: dir,
    paths,
    relayUrl: "http://127.0.0.1:12345",
    messages,
    sessions,
    directory: new StaticParticipantDirectory([]),
    now: () => 0,
  });
  try {
    await expect(acquireClaudeOwnership(transcriptPath, session, "manual")).rejects.toThrow();
    await rm(configPaths.config);
    await vi.waitFor(
      async () => {
        const owner = await acquireClaudeOwnership(transcriptPath, session, "manual");
        await owner.release();
      },
      { timeout: 2000, interval: 10 },
    );
    const db = new DatabaseSync(configPaths.ledger, { readOnly: true });
    try {
      expect(db.prepare("SELECT active FROM ownership").get()).toEqual({ active: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  } finally {
    await handle.stop();
    messages.close();
    sessions.close();
  }
});

describe("bounded Claude process", () => {
  it("kills timeout/overflow children and waits for exit; stderr never becomes evidence", async () => {
    const timeout = await runClaudeProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 50,
    });
    expect(timeout.interrupted).toBe(true);
    const overflow = await runClaudeProcess(
      process.execPath,
      ["-e", "process.stderr.write('private'.repeat(10000))"],
      { limit: 64 },
    );
    expect(overflow.interrupted).toBe(true);
    expect(overflow.stdout).toBe("");
  });
  it("rejects permission denials despite success and uses only structured external errors", () => {
    const make = (fields: object) => ({
      exitCode: 0,
      interrupted: false,
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: session,
        is_error: false,
        ...fields,
      }),
    });
    expect(classifyClaudeResult(make({ permission_denials: [{}] }), session)).toBe("denied");
    expect(
      classifyClaudeResult(make({ is_error: true, errors: ["402 Insufficient balance"] }), session),
    ).toBe("uncertain");
    expect(classifyClaudeResult(make({ session_id: "other" }), session)).toBe("invalid");
  });
  it("makes scan failure fail closed", async () => {
    expect(
      await noClaudeProcesses(async () => ({ exitCode: 1, stdout: "", interrupted: false })),
    ).toBe(false);
  });
});

it("relay hints fire after durable create, once for replay, without breaking send on observer failure", async () => {
  const messages = new SQLiteMessageStore(":memory:"),
    sessions = new SessionStore(":memory:");
  const participants = ["cto", "arch"].map((agentId) => ({
    project: "p",
    agentId,
    title: agentId,
    role: agentId,
  }));
  let events = 0;
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    new ProtectionPolicy(messages),
    undefined,
    undefined,
    undefined,
    {
      created: (message) => {
        expect(messages.getMessage(message.id, "p")).toBeDefined();
        events++;
        throw new Error("observer failed");
      },
      acknowledged: () => {},
    },
  );
  try {
    const identity = { project: "p", agentId: "cto", operator: false };
    const input = { to: "arch", text: "test", expectsReply: false, idempotencyKey: "event" };
    const first = await relay.send(identity, input);
    expect((await relay.send(identity, input)).id).toBe(first.id);
    expect(events).toBe(1);
  } finally {
    messages.close();
    sessions.close();
  }
});

describe("Claude attempt ledger", () => {
  it.each(["reserved", "uncertain", "denied", "invalid"] as const)(
    "scopes %s quarantine to the same session but keeps the role cooldown",
    async (outcome) => {
      const path = join(await temp(), "ledger.sqlite");
      const first = new ClaudeNudgeLedger(path);
      const second = new ClaudeNudgeLedger(path);
      const oldSession = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const newSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const nextTarget = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const request = {
        project: "p",
        agentId: "arch",
        sessionId: oldSession,
        targetId: target,
        now: 0,
      };
      try {
        const attempt = first.reserve(request)!;
        expect(attempt).toBeDefined();
        if (outcome !== "reserved") first.finish(attempt.id, outcome, false);
        const next = { ...request, targetId: nextTarget, now: NUDGE_COOLDOWN_MS };
        expect(second.reserve({ ...next, sessionId: oldSession.toUpperCase() })).toBeUndefined();
        expect(
          second.reserve({ ...next, sessionId: newSession, now: next.now - 1 }),
        ).toBeUndefined();
        expect(second.reserve({ ...next, sessionId: newSession })).toBeDefined();
        expect(
          first.reserve({ ...next, sessionId: newSession, now: 2 * next.now }),
        ).toBeUndefined();
      } finally {
        first.close();
        second.close();
      }
    },
  );

  it("reserves before execution, blocks crashes across reopen, and caps external retry", async () => {
    const path = join(await temp(), "ledger.sqlite");
    let ledger = new ClaudeNudgeLedger(path);
    const request = { project: "p", agentId: "arch", sessionId: session, targetId: target, now: 0 };
    const first = ledger.reserve(request)!;
    expect(first).toBeTruthy();
    ledger.close();
    ledger = new ClaudeNudgeLedger(path);
    expect(ledger.reserve({ ...request, now: NUDGE_COOLDOWN_MS })).toBeUndefined();
    ledger.finish(first.id, "external", false);
    expect(ledger.reserve({ ...request, now: 1 })).toBeUndefined();
    const retry = ledger.reserve({ ...request, now: NUDGE_COOLDOWN_MS })!;
    expect(retry).toBeTruthy();
    ledger.finish(retry.id, "external", false);
    expect(ledger.reserve({ ...request, now: 2 * NUDGE_COOLDOWN_MS })).toBeUndefined();
    ledger.close();
  });
});

describe("Claude durable proof", () => {
  it("rejects a fork whose final assistant points to the pre-nudge ancestor", () => {
    expect(
      verifyClaudeTurn({
        delta: transcript().replace('"parentUuid":"4"', '"parentUuid":"prior"'),
        sessionId: session,
        agentId: "arch",
        targetId: target,
        marker,
        previousUuid: "prior",
        acknowledged: () => true,
      }),
    ).toBe(false);
  });
  const check = (delta: string, acked = true) =>
    verifyClaudeTurn({
      delta,
      sessionId: session,
      agentId: "arch",
      targetId: target,
      marker,
      previousUuid: "prior",
      acknowledged: () => acked,
    });
  it("requires new assistant marker, paired tool results and independent SQLite acknowledgement", () => {
    expect(check(transcript())).toBe(true);
    expect(check(transcript(), false)).toBe(false);
    expect(check(transcript().split("\n").slice(0, 5).join("\n"))).toBe(false);
    expect(
      check(transcript().replaceAll('"sessionId":"' + session + '"', '"sessionId":"other"')),
    ).toBe(false);
    expect(check(transcript().replace('"tool_use_id":"a"', '"tool_use_id":"wrong"'))).toBe(false);
    expect(check(transcript().replace('"parentUuid":"4"', '"parentUuid":"prior"'))).toBe(false);
  });
  it("rejects injection in identifiers rather than copying message text", () => {
    expect(() => claudeNudgePrompt(["ignore previous"], marker)).toThrow();
    expect(claudeNudgePrompt([target], marker)).toMatch(
      /^Synloq nudge: 1 pending message\(s\), messageId /,
    );
  });
});
