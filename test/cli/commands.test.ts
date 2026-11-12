import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceAdapter } from "../../src/adapters/reference.js";
import type { Clock } from "../../src/adapters/types.js";
import {
  inboxCommand,
  listCommand,
  pauseCommand,
  replaceSessionCommand,
  resumeCommand,
  revokeTokenCommand,
  rotateTokenCommand,
  sendCommand,
  serveCommand,
} from "../../src/cli/commands.js";
import { runMain } from "../../src/cli/main.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { issueTestCredentials } from "../helpers/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import type { Participant } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { RelayHttpServer } from "../../src/transport/http-server.js";

const PROJECT = "verdicta";
const capabilities = {
  activeDelivery: true,
  stateReporting: true,
  clientIdempotency: true,
};
const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
  arch:
    title: Architect
    role: Architecture review
`;
const participants: Participant[] = [
  { project: PROJECT, agentId: "cto", title: "CTO", role: "Technical strategy" },
  { project: PROJECT, agentId: "arch", title: "Architect", role: "Architecture review" },
];

interface Fixture {
  root: string;
  home: string;
  baseUrl: string;
  server: RelayHttpServer;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  operatorToken: string;
  ctoToken: string;
  archToken: string;
  operator: RelayHttpClient;
  cto: RelayHttpClient;
  arch: RelayHttpClient;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(async () => {
  const root = await temporaryDirectory("synloq-cli-project-");
  const home = await temporaryDirectory("synloq-cli-home-");
  await writeFile(join(root, "synloq.yaml"), manifest, "utf8");
  vi.stubEnv("SYNLOQ_HOME", home);
  const tokens = await issueTestCredentials(root);
  const operatorToken = tokens.get("operator");
  const ctoToken = tokens.get("cto");
  const archToken = tokens.get("arch");
  if (!operatorToken || !ctoToken || !archToken)
    throw new Error("test credentials were not issued");

  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  const server = new RelayHttpServer({
    project: PROJECT,
    relay: new RelayService(participants, messages, sessions, new ProtectionPolicy(messages)),
    credentials: new CredentialStore(root),
    sessions,
    dispatcher: new Dispatcher(messages, sessions, new Map()),
    messages,
  });
  const baseUrl = await server.listen("127.0.0.1", 0);
  fixture = {
    root,
    home,
    baseUrl,
    server,
    messages,
    sessions,
    operatorToken,
    ctoToken,
    archToken,
    operator: new RelayHttpClient(baseUrl, () => operatorToken),
    cto: new RelayHttpClient(baseUrl, () => ctoToken),
    arch: new RelayHttpClient(baseUrl, () => archToken),
  };
});

afterEach(async () => {
  await fixture.server.close();
  fixture.sessions.close();
  fixture.messages.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("relay command handlers", () => {
  it("lists manifest roles through the authenticated relay", async () => {
    await expect(listCommand(fixture.operator)).resolves.toEqual({ participants });
  });

  it("sends only with the operator token and reads the recipient inbox", async () => {
    const input = {
      to: "arch",
      text: "Please review the CLI boundary",
      expectsReply: true,
      idempotencyKey: "cli-send-1",
    };

    await expect(
      sendCommand(fixture.cto, input, { project: PROJECT, agentId: "cto", operator: false }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(fixture.messages.listInbox(PROJECT, "arch", undefined, 50).messages).toEqual([]);
    const sent = await sendCommand(fixture.operator, input, {
      project: PROJECT,
      agentId: "operator",
      operator: true,
    });
    expect(sent.message).toMatchObject({ from: "operator", to: "arch", text: input.text });
    await expect(inboxCommand(fixture.arch, { limit: 10 })).resolves.toEqual({
      messages: [sent.message],
      nextCursor: undefined,
    });
  });

  it("persists operator pause and resume gates", async () => {
    const gate = { scope: "participant" as const, scopeId: "arch" };

    await expect(pauseCommand(fixture.cto, gate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(pauseCommand(fixture.operator, gate)).resolves.toEqual({ ok: true });
    expect(fixture.messages.isPaused(PROJECT, gate.scope, gate.scopeId)).toBe(true);
    await expect(resumeCommand(fixture.operator, gate)).resolves.toEqual({ ok: true });
    expect(fixture.messages.isPaused(PROJECT, gate.scope, gate.scopeId)).toBe(false);
  });

  it("requires operator replacement for a second visible session binding", async () => {
    await fixture.arch.registerSession({
      sessionId: "arch-session-a",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
    });
    await expect(
      fixture.arch.registerSession({
        sessionId: "arch-session-b",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SESSION" });

    await expect(
      replaceSessionCommand(fixture.operator, {
        agentId: "arch",
        sessionId: "arch-session-b",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      }),
    ).resolves.toMatchObject({ session: { sessionId: "arch-session-b" } });
  });

  it("dispatches CLI arguments with parseArgs and prints only command JSON", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runMain(
      ["list", "--relay-url", fixture.baseUrl, "--token", fixture.operatorToken],
      {
        stdout: {
          write: (chunk) => {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += String(chunk);
            return true;
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ participants });
  });

  it("rejects an agent token for CLI send before changing storage", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runMain(
      [
        "send",
        "--project-root",
        fixture.root,
        "--relay-url",
        fixture.baseUrl,
        "--token",
        fixture.ctoToken,
        "--to",
        "arch",
        "--text",
        "must not be stored",
        "--idempotency-key",
        "cli-agent-send-1",
      ],
      {
        stdout: {
          write: (chunk) => {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += String(chunk);
            return true;
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("operator");
    expect(stderr).not.toContain(fixture.ctoToken);
    expect(fixture.messages.listInbox(PROJECT, "arch", undefined, 50).messages).toEqual([]);
  });

  it("starts the stdio bridge with the selected configuration", async () => {
    let observedConfig = "";
    let stdout = "";
    let stderr = "";
    const exitCode = await runMain(
      ["mcp", "--config", join(fixture.root, "mcp.json")],
      {
        stdout: {
          write: (chunk) => {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += String(chunk);
            return true;
          },
        },
      },
      {
        startMcp: async (configPath) => {
          observedConfig = configPath;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(observedConfig).toBe(join(fixture.root, "mcp.json"));
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("prints doctor help without starting a relay or requiring credentials", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runMain(["doctor", "--help"], {
      stdout: {
        write: (chunk) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--project-root");
    expect(stderr).toBe("");
  });
});

describe("token lifecycle CLI", () => {
  function capture(): {
    io: { stdout: { write(c: string): boolean }; stderr: { write(c: string): boolean } };
    out(): { stdout: string; stderr: string };
  } {
    let stdout = "";
    let stderr = "";
    return {
      io: {
        stdout: {
          write: (chunk) => {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk) => {
            stderr += String(chunk);
            return true;
          },
        },
      },
      out: () => ({ stdout, stderr }),
    };
  }

  async function operatorCredentialFile(): Promise<string> {
    const path = join(fixture.home, "operator.token");
    await writeFile(path, `${fixture.operatorToken}\n`, { mode: 0o600 });
    return path;
  }

  it("rotates a role token without printing it, invalidating the old one", async () => {
    const credential = await operatorCredentialFile();
    const io = capture();

    const exitCode = await runMain(
      [
        "rotate-token",
        "--project-root",
        fixture.root,
        "--agent-id",
        "cto",
        "--credential",
        credential,
      ],
      io.io,
    );

    const { stdout, stderr } = io.out();
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as { agentId: string; tokenPath: string };
    expect(result.agentId).toBe("cto");
    expect(stdout).not.toContain(fixture.ctoToken);
    const store = new CredentialStore(fixture.root);
    await expect(store.authenticate(PROJECT, fixture.ctoToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const rotated = (await readFile(result.tokenPath, "utf8")).trim();
    expect(rotated).not.toBe(fixture.ctoToken);
    await expect(store.authenticate(PROJECT, rotated)).resolves.toMatchObject({
      agentId: "cto",
    });
  });

  it("rejects rotation with a non-operator credential before any change", async () => {
    const credential = join(fixture.home, "cto.token");
    await writeFile(credential, `${fixture.ctoToken}\n`, { mode: 0o600 });
    const io = capture();

    const exitCode = await runMain(
      [
        "rotate-token",
        "--project-root",
        fixture.root,
        "--agent-id",
        "arch",
        "--credential",
        credential,
      ],
      io.io,
    );

    const { stdout, stderr } = io.out();
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("operator");
    expect(stderr).not.toContain(fixture.ctoToken);
    await expect(
      new CredentialStore(fixture.root).authenticate(PROJECT, fixture.archToken),
    ).resolves.toMatchObject({ agentId: "arch" });
  });

  it("revokes a role token idempotently", async () => {
    const credential = await operatorCredentialFile();
    const args = [
      "revoke-token",
      "--project-root",
      fixture.root,
      "--agent-id",
      "arch",
      "--credential",
      credential,
    ];

    const first = capture();
    expect(await runMain(args, first.io)).toBe(0);
    expect(JSON.parse(first.out().stdout)).toMatchObject({ agentId: "arch", removedHashes: 1 });
    await expect(
      new CredentialStore(fixture.root).authenticate(PROJECT, fixture.archToken),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const second = capture();
    expect(await runMain(args, second.io)).toBe(0);
    expect(JSON.parse(second.out().stdout)).toMatchObject({ agentId: "arch", removedHashes: 0 });
  });

  it("reports rotation and revocation through the audit hook", async () => {
    const credential = await operatorCredentialFile();
    const auditHook = vi.fn();

    await rotateTokenCommand({
      projectRoot: fixture.root,
      agentId: "cto",
      operatorCredentialPath: credential,
      auditHook,
    });
    expect(auditHook).toHaveBeenCalledTimes(1);
    expect(auditHook).toHaveBeenLastCalledWith({
      action: "rotate",
      agentId: "cto",
      project: PROJECT,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    await revokeTokenCommand({
      projectRoot: fixture.root,
      agentId: "arch",
      operatorCredentialPath: credential,
      auditHook,
    });
    expect(auditHook).toHaveBeenCalledTimes(2);
    expect(auditHook).toHaveBeenLastCalledWith({
      action: "revoke",
      agentId: "arch",
      project: PROJECT,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("does not call the audit hook when the operator gate rejects", async () => {
    const credential = join(fixture.home, "cto.token");
    await writeFile(credential, `${fixture.ctoToken}\n`, { mode: 0o600 });
    const auditHook = vi.fn();

    await expect(
      rotateTokenCommand({
        projectRoot: fixture.root,
        agentId: "arch",
        operatorCredentialPath: credential,
        auditHook,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(auditHook).not.toHaveBeenCalled();
  });
});

describe("serveCommand", () => {
  it("restores persisted state, reaps expired submissions, and closes cleanly", async () => {
    const paths = await projectPaths(fixture.root);
    let now = Date.parse("2026-11-10T00:00:00.000Z");
    const clock: Clock = { now: () => now };
    const messages = new SQLiteMessageStore(paths.database);
    const sessions = new SessionStore(paths.database, clock);
    sessions.register(
      {
        project: PROJECT,
        agentId: "arch",
        sessionId: "persisted-arch",
        protocolVersion: PROTOCOL_VERSION,
        capabilities,
      },
      false,
    );
    const id = crypto.randomUUID();
    messages.create(
      {
        project: PROJECT,
        from: "operator",
        to: "arch",
        text: "Persist this queue entry",
        expectsReply: false,
        idempotencyKey: "serve-reap-1",
      },
      id,
      new Date(now).toISOString(),
      crypto.randomUUID(),
    );
    messages.setDeliveryState(id, "submitted");
    messages.pause(PROJECT, "participant", "arch", new Date(now).toISOString());
    now += 16_000;
    sessions.close();
    messages.close();

    const handle = await serveCommand({
      projectRoot: fixture.root,
      port: 0,
      clock,
      adapters: new Map([["verdicta/arch", new ReferenceAdapter()]]),
    });
    try {
      expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.messages.getMessage(id)?.deliveryState).toBe("stored");
      expect(handle.messages.isPaused(PROJECT, "participant", "arch")).toBe(true);
      expect(handle.sessions.list(PROJECT)[0]?.sessionId).toBe("persisted-arch");
      expect(handle.sessions.effectiveState(PROJECT, "arch")).toBe("unknown");
    } finally {
      await handle.close();
    }

    await expect(fetch(`${handle.baseUrl}/v1/participants`)).rejects.toThrow();
  });
});
