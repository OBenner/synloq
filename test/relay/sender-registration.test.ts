import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveCommand, type ServeHandle } from "../../src/cli/commands.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Strategy
  arch:
    title: Architect
    role: Review
`;

describe("v1.1 §2.5 sender registration (#10)", () => {
  const dirs: string[] = [];
  const handles: ServeHandle[] = [];
  afterEach(async () => {
    while (handles.length) await handles.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function stand() {
    const root = mkdtempSync(join(tmpdir(), "synloq-sender-"));
    dirs.push(root);
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    const home = join(root, ".synloq");
    const handle = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    handles.push(handle);
    const store = new CredentialStore(root, home);
    const ctoToken = await store.issue("verdicta", "cto");
    // The incident 2026-11-12 shape: a VALID credential for a role that is
    // NOT in the team registry.
    const ghostToken = await store.issue("verdicta", "ghost");
    const cto = new RelayHttpClient(handle.baseUrl, () => ctoToken, {
      project: "verdicta",
      agentId: "cto",
    });
    const ghost = new RelayHttpClient(handle.baseUrl, () => ghostToken, {
      project: "verdicta",
      agentId: "ghost",
    });
    const paths = await projectPaths(root, home);
    return { handle, home, cto, ghost, paths, store };
  }

  it("rejects a registered-credential sender with no registry entry, synchronously and unstored", async () => {
    const { ghost, paths } = await stand();
    await expect(
      ghost.send({
        to: "cto",
        text: "incident replay: no registry entry",
        expectsReply: false,
        idempotencyKey: "incident-2026-11-12-1",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SENDER" });

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(join(paths.home, "data", `${paths.key}-audit.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const deny = lines.find((entry) => entry.action === "send" && entry.decision === "deny");
    expect(deny).toMatchObject({ agentId: "ghost", reasonCode: "UNKNOWN_SENDER" });
  });

  it("checks the sender BEFORE replay: an unregistered sender never gets another participant's ledger entry", async () => {
    const { cto, ghost } = await stand();
    // A legitimate participant stores a message under a key...
    await cto.send({
      to: "arch",
      text: "legitimate",
      expectsReply: false,
      idempotencyKey: "shared-key-1",
    });
    // ...and a replay of the same key from the unregistered sender is REJECTED
    // with unknown_sender, not answered with the stored message.
    await expect(
      ghost.send({
        to: "arch",
        text: "different body",
        expectsReply: false,
        idempotencyKey: "shared-key-1",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SENDER" });
  });

  it("keeps unknown_recipient semantics for `to` unchanged", async () => {
    const { cto } = await stand();
    await expect(
      cto.send({
        to: "ghost",
        text: "to an outsider",
        expectsReply: false,
        idempotencyKey: "to-outsider-1",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
  });

  it("returns SENDER_RESERVED for operator sends and registration, while preserving operator reads", async () => {
    const { handle, store } = await stand();
    const operatorToken = (await store.ensureOperatorCredential("verdicta")).token;
    const operator = new RelayHttpClient(handle.baseUrl, () => operatorToken, {
      project: "verdicta",
      agentId: "operator",
    });
    await expect(
      operator.send({
        to: "cto",
        text: "operator notice",
        expectsReply: false,
        idempotencyKey: "operator-1",
      }),
    ).rejects.toMatchObject({ code: "SENDER_RESERVED" });
    await expect(
      operator.registerSession({
        sessionId: "operator-writer",
        protocolVersion: 1,
        capabilities: { activeDelivery: false, stateReporting: false, clientIdempotency: false },
      }),
    ).rejects.toMatchObject({ code: "SENDER_RESERVED" });
    await expect(operator.listParticipants()).resolves.toMatchObject({
      participants: expect.arrayContaining([expect.objectContaining({ agentId: "cto" })]),
    });
    for (const agentId of ["relay", "operator"]) {
      await expect(
        operator.replaceSession({
          agentId,
          sessionId: "reserved-writer",
          protocolVersion: 1,
          capabilities: { activeDelivery: false, stateReporting: false, clientIdempotency: false },
        }),
      ).rejects.toMatchObject({ code: "SENDER_RESERVED" });
    }
    expect(handle.messages.listInbox("verdicta", "cto", undefined, 50).messages).toEqual([]);
    expect(handle.sessions.list("verdicta")).toEqual([]);
  });

  it.each(["relay", "operator"])("refuses channel issuance for reserved id %s", async (agentId) => {
    const { store } = await stand();
    await expect(store.issue("verdicta", agentId)).rejects.toMatchObject({
      code: "SENDER_RESERVED",
    });
    await expect(store.ensureCredential("verdicta", agentId)).rejects.toMatchObject({
      code: "SENDER_RESERVED",
    });
  });

  it.each([
    ["synloq.yaml", "relay"],
    ["synloq.yaml", "operator"],
    ["synloq.local.yaml", "relay"],
    ["synloq.local.yaml", "operator"],
  ])("refuses to start with reserved participant in %s (%s)", async (file, agentId) => {
    const root = mkdtempSync(join(tmpdir(), "synloq-reserved-manifest-"));
    dirs.push(root);
    const home = join(root, ".synloq");
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    const reserved = `  ${agentId}:\n    title: Reserved\n    role: Unassignable\n`;
    writeFileSync(
      join(root, file),
      file === "synloq.yaml" ? manifest + reserved : "agents:\n" + reserved,
      "utf8",
    );
    await expect(
      serveCommand({ projectRoot: root, port: 0, synloqHome: home }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: `${file} contains reserved agent id '${agentId}'`,
    });
  });
});
