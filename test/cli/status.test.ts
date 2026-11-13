import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../src/adapters/types.js";
import { statusCommand } from "../../src/cli/commands.js";
import { runMain } from "../../src/cli/main.js";
import { createStatusReport, formatStatusReport } from "../../src/cli/status.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "verdicta";
const secretMessageBody = "secret-status-body-do-not-print";
const NOW = Date.parse("2026-11-10T00:00:00.000Z");
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "Technical strategy" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "Architecture review" },
];
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
  arch:
    title: Architect
    role: Architecture review
`;
const capable = { activeDelivery: true, stateReporting: true, clientIdempotency: false };

interface Fixture {
  root: string;
  databasePath: string;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  clock: Clock;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-status-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-status-home-"));
  temporaryDirectories.push(root, home);
  await writeFile(join(root, "synloq.yaml"), manifest, "utf8");
  vi.stubEnv("SYNLOQ_HOME", home);
  const clock: Clock = { now: () => NOW };
  const paths = await projectPaths(root);
  fixture = {
    root,
    databasePath: paths.database,
    messages: new SQLiteMessageStore(paths.database),
    sessions: new SessionStore(paths.database, clock),
    clock,
  };
});

afterEach(async () => {
  fixture.sessions.close();
  fixture.messages.close();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function register(agentId: string, state?: "idle" | "busy") {
  const session = fixture.sessions.register(
    {
      project: PROJECT,
      agentId,
      sessionId: `session-${agentId}`,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: capable,
    },
    false,
  );
  if (state) fixture.sessions.heartbeat(PROJECT, agentId, session.sessionId, state);
  return session;
}

function queueMessage(to: string, createdAt: string, key: string, expectsReply = false): string {
  const id = crypto.randomUUID();
  fixture.messages.create(
    {
      project: PROJECT,
      from: "operator",
      to,
      text: secretMessageBody,
      expectsReply,
      idempotencyKey: key,
    },
    id,
    createdAt,
    crypto.randomUUID(),
  );
  return id;
}

function report() {
  return createStatusReport({
    project: PROJECT,
    participants,
    databasePath: fixture.databasePath,
    messages: fixture.messages,
    sessions: fixture.sessions,
    clock: fixture.clock,
  });
}

describe("createStatusReport wait reasons", () => {
  it("marks an unregistered role", () => {
    expect(report().participants[0]).toMatchObject({
      agentId: "cto",
      state: "unknown",
      queued: 0,
      waitReason: "session-not-registered",
    });
  });

  it("marks an idle role with an empty queue as ready", () => {
    register("arch", "idle");
    expect(report().participants[1]).toMatchObject({ state: "idle", waitReason: "ready" });
  });

  it("explains a busy chat with the oldest queued age", () => {
    register("arch", "busy");
    queueMessage("arch", "2026-11-09T23:55:48.000Z", "status-busy-1");
    queueMessage("arch", "2026-11-09T23:58:00.000Z", "status-busy-2");

    expect(report().participants[1]).toMatchObject({
      queued: 2,
      oldestStoredAt: "2026-11-09T23:55:48.000Z",
      waitReason: "2 stored — arch chat is busy (oldest 4m 12s)",
    });
  });

  it("explains a stale session with the heartbeat age", () => {
    register("arch");
    queueMessage("arch", "2026-11-09T23:50:00.000Z", "status-stale-1");

    expect(report().participants[1]?.waitReason).toBe(
      "1 stored — session state unknown/stale (last heartbeat 0s ago)",
    );
  });

  it("explains a delivered message awaiting acknowledgement", () => {
    register("arch", "idle");
    const id = queueMessage("arch", "2026-11-09T23:56:55.000Z", "status-ack-1");
    fixture.messages.setDeliveryState(id, "delivered");

    expect(report().participants[1]).toMatchObject({
      queued: 0,
      awaitingAck: { count: 1, oldestAt: "2026-11-09T23:56:55.000Z" },
      waitReason: "delivered, awaiting ack (3m 05s)",
    });
  });

  it("prioritizes an operator pause over every other reason", () => {
    register("arch", "busy");
    queueMessage("arch", "2026-11-09T23:55:00.000Z", "status-paused-1");
    fixture.messages.pause(PROJECT, "participant", "arch", "2026-11-09T23:59:00.000Z");

    expect(report().participants[1]?.waitReason).toBe("delivery-paused:participant");
  });

  it("appends the acked-without-reply counter to any reason", () => {
    register("arch", "idle");
    const id = queueMessage("arch", "2026-11-09T23:15:00.000Z", "status-unanswered-1", true);
    fixture.messages.setDeliveryState(id, "delivered");
    fixture.messages.acknowledge(id, PROJECT, "arch");

    const entry = report().participants[1];
    expect(entry?.unansweredAcked).toEqual({ count: 1, oldestAt: "2026-11-09T23:15:00.000Z" });
    expect(entry?.waitReason).toBe("ready; 1 acked without reply (oldest 45m 00s)");
  });
});

describe("formatStatusReport", () => {
  it("renders an aligned table without message bodies", () => {
    register("arch", "busy");
    queueMessage("arch", "2026-11-09T23:55:48.000Z", "status-table-1");

    const output = formatStatusReport(report());
    const lines = output.split("\n");
    expect(lines[0]).toBe(`project: verdicta   relay db: ok (${fixture.databasePath})`);
    expect(lines[1]).toBe("generated: 2026-11-10T00:00:00.000Z");
    expect(lines[3]).toMatch(/^ROLE\s+STATE\s+QUEUED\s+WAIT$/);
    expect(lines[4]).toBe("cto   unknown  0       session-not-registered");
    expect(lines[5]).toBe("arch  busy     1       1 stored — arch chat is busy (oldest 4m 12s)");
    expect(output).not.toContain(secretMessageBody);
  });
});

describe("statusCommand", () => {
  it("reads the project storage read-only and matches the direct report", async () => {
    register("arch", "idle");
    queueMessage("arch", "2026-11-09T23:58:00.000Z", "status-command-1");

    const result = await statusCommand({ projectRoot: fixture.root, clock: fixture.clock });
    expect(result.project).toBe(PROJECT);
    expect(result.storage).toEqual({ ok: true, path: fixture.databasePath });
    expect(result.participants[1]).toMatchObject({
      state: "idle",
      queued: 1,
      waitReason: "1 stored — idle, next delivery imminent (oldest 2m 00s)",
    });
  });

  it("fails closed with an explicit storage diagnostic", async () => {
    const blockedHome = join(temporaryDirectories[1]!, "not-a-directory");
    await writeFile(blockedHome, "blocks SQLite parent creation", "utf8");
    vi.stubEnv("SYNLOQ_HOME", blockedHome);

    const result = await statusCommand({ projectRoot: fixture.root, clock: fixture.clock });
    expect(result.storage.ok).toBe(false);
    expect(result.participants[0]?.waitReason).toBe("session-not-registered");
  });
});

describe("synloq status CLI wiring", () => {
  async function capture(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = "";
    let stderr = "";
    const code = await runMain(args, {
      stdout: { write: (chunk) => (stdout += chunk) === undefined },
      stderr: { write: (chunk) => (stderr += chunk) === undefined },
    });
    return { stdout, stderr, code };
  }

  it("prints the human table by default and JSON with --json", async () => {
    // runMain uses the real clock: a session registered with the fixture clock
    // reads as unknown here, which still exercises the full table path.
    register("arch", "idle");

    const human = await capture(["status", "--project-root", fixture.root]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("ROLE");
    expect(human.stdout).toContain("arch  unknown");
    expect(human.stdout).not.toContain(secretMessageBody);

    const json = await capture(["status", "--project-root", fixture.root, "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      project: string;
      participants: Array<{ agentId: string; waitReason: string }>;
    };
    expect(parsed.project).toBe(PROJECT);
    expect(parsed.participants[1]).toMatchObject({
      agentId: "arch",
      waitReason: "session-unknown",
    });
  });

  it("prints usage for --help and stays listed in the command index", async () => {
    const help = await capture(["status", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("synloq status --project-root");

    const index = await capture(["--help"]);
    expect(index.stdout).toContain("status");
  });

  it("never prints issued credentials", async () => {
    const issuedToken = await new CredentialStore(fixture.root).issue(PROJECT, "operator");
    register("arch", "idle");

    const json = await capture(["status", "--project-root", fixture.root, "--json"]);
    expect(json.stdout).not.toContain(issuedToken);
  });
});
