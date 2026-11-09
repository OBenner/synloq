import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceAdapter } from "../../src/adapters/reference.js";
import type { Clock, DeliveryAdapter } from "../../src/adapters/types.js";
import { doctorCommand } from "../../src/cli/commands.js";
import { createDoctorReport, formatDoctorReport, type DoctorReport } from "../../src/cli/doctor.js";
import { initCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const PROJECT = "verdicta";
const secretMessageBody = "secret-message-body-do-not-print";
const secretToken = "secret-operator-token-do-not-print";
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

interface Fixture {
  root: string;
  home: string;
  databasePath: string;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  adapters: Map<string, DeliveryAdapter>;
  clock: Clock;
  advance: (milliseconds: number) => void;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-doctor-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-doctor-home-"));
  temporaryDirectories.push(root, home);
  await writeFile(join(root, "synloq.yaml"), manifest, "utf8");
  vi.stubEnv("SYNLOQ_HOME", home);
  let now = Date.parse("2026-11-10T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  const paths = await projectPaths(root);
  fixture = {
    root,
    home,
    databasePath: paths.database,
    messages: new SQLiteMessageStore(paths.database),
    sessions: new SessionStore(paths.database, clock),
    adapters: new Map(),
    clock,
    advance: (milliseconds) => {
      now += milliseconds;
    },
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

function report(): DoctorReport {
  return createDoctorReport({
    project: PROJECT,
    participants,
    databasePath: fixture.databasePath,
    messages: fixture.messages,
    sessions: fixture.sessions,
    adapters: fixture.adapters,
  });
}

async function captureDoctor(): Promise<string> {
  return formatDoctorReport(
    await doctorCommand({ projectRoot: fixture.root, adapters: fixture.adapters }),
  );
}

describe("DoctorReport", () => {
  it("reports storage, session negotiation, heartbeat, queue usage, and exact inactivity", async () => {
    const capabilities = {
      activeDelivery: false,
      stateReporting: true,
      clientIdempotency: true,
    };
    const registered = fixture.sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "arch-visible-session",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      },
      false,
    );
    fixture.adapters.set("verdicta/arch", new ReferenceAdapter(capabilities));
    fixture.messages.create(
      {
        project: PROJECT,
        from: "operator",
        to: "arch",
        text: secretMessageBody,
        expectsReply: false,
        idempotencyKey: "doctor-secret-1",
      },
      crypto.randomUUID(),
      "2026-11-10T00:00:00.000Z",
      crypto.randomUUID(),
    );

    const result = report();
    expect(result).toEqual({
      storage: { ok: true, path: fixture.databasePath },
      participants: [
        {
          agentId: "cto",
          state: "unknown",
          adapterConnected: false,
          pendingCount: 0,
          pendingBytes: 0,
          inactiveReason: "session-not-registered",
        },
        {
          agentId: "arch",
          sessionId: "arch-visible-session",
          state: "idle",
          adapterConnected: true,
          protocolVersion: PROTOCOL_VERSION,
          capabilities,
          lastHeartbeatAt: registered.lastHeartbeatAt,
          pendingCount: 1,
          pendingBytes: Buffer.byteLength(secretMessageBody),
          inactiveReason: "active-delivery-unsupported",
        },
      ],
    });
  });

  it("uses effective state while deriving connectivity independently from lease freshness", () => {
    fixture.sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "expired-arch-session",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          activeDelivery: true,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
      false,
    );
    fixture.adapters.set("verdicta/arch", new ReferenceAdapter());
    fixture.advance(16_000);

    expect(report().participants[1]).toMatchObject({
      agentId: "arch",
      state: "unknown",
      adapterConnected: true,
      inactiveReason: "session-unknown",
    });
  });

  it("prioritizes applicable persisted pause gates over session reasons", () => {
    fixture.sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "paused-arch-session",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          activeDelivery: false,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
      false,
    );
    fixture.messages.pause(PROJECT, "participant", "arch", "2026-11-10T00:00:00.000Z");
    expect(report().participants[1]?.inactiveReason).toBe("delivery-paused:participant");

    fixture.messages.pause(PROJECT, "project", "", "2026-11-10T00:00:00.000Z");
    expect(report().participants[1]?.inactiveReason).toBe("delivery-paused:project");
  });

  it("reports a paused thread when it blocks the next pending delivery", () => {
    fixture.sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "thread-arch-session",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          activeDelivery: true,
          stateReporting: true,
          clientIdempotency: true,
        },
      },
      false,
    );
    const threadId = crypto.randomUUID();
    fixture.messages.create(
      {
        project: PROJECT,
        from: "operator",
        to: "arch",
        text: "queued",
        expectsReply: false,
        idempotencyKey: "doctor-thread-1",
      },
      crypto.randomUUID(),
      "2026-11-10T00:00:00.000Z",
      threadId,
    );
    fixture.messages.pause(PROJECT, "thread", threadId, "2026-11-10T00:00:00.000Z");

    expect(report().participants[1]?.inactiveReason).toBe("delivery-paused:thread");
  });

  it("fails closed with an explicit storage diagnostic", async () => {
    const blockedHome = join(fixture.home, "not-a-directory");
    await writeFile(blockedHome, "blocks SQLite parent creation", "utf8");
    vi.stubEnv("SYNLOQ_HOME", blockedHome);

    fixture.adapters.set("verdicta/cto", new ReferenceAdapter());
    const result = await doctorCommand({ projectRoot: fixture.root, adapters: fixture.adapters });

    expect(result.storage).toMatchObject({ ok: false });
    expect(result.storage.error).toBe("failed to open or migrate SQLite storage");
    expect(result.participants).toHaveLength(2);
    expect(result.participants[0]).toMatchObject({
      state: "unknown",
      adapterConnected: true,
      inactiveReason: "session-not-registered",
    });
  });

  it("never prints credentials or message bodies", async () => {
    const initialized = await initCommand({ projectRoot: fixture.root });
    initialized.credentials.push({ agentId: "test-secret", token: secretToken });
    const capabilities = {
      activeDelivery: false,
      stateReporting: true,
      clientIdempotency: true,
    };
    fixture.sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "redacted-arch-session",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      },
      false,
    );
    fixture.adapters.set("verdicta/arch", new ReferenceAdapter(capabilities));
    fixture.messages.create(
      {
        project: PROJECT,
        from: "operator",
        to: "arch",
        text: secretMessageBody,
        expectsReply: false,
        idempotencyKey: "doctor-redaction-1",
      },
      crypto.randomUUID(),
      "2026-11-10T00:00:00.000Z",
      crypto.randomUUID(),
    );

    const output = await captureDoctor();
    expect(output).toContain("active-delivery-unsupported");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretMessageBody);
    expect(output).not.toContain(initialized.credentials[0]?.token ?? "missing-token");
  });
});
