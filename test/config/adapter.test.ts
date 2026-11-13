import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAdapterConfiguration } from "../../src/config/adapter.js";
import { issueTestCredentials } from "../helpers/credentials.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Architecture
  arch:
    title: Architect
    role: Review
`;

let root: string;
let home: string;
let configPath: string;
let credentialPath: string;
let token: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-adapter-config-project-"));
  home = await mkdtemp(join(tmpdir(), "synloq-adapter-config-home-"));
  vi.stubEnv("SYNLOQ_HOME", home);
  await writeFile(join(root, "synloq.yaml"), manifest);
  const tokens = await issueTestCredentials(root);
  const ctoToken = tokens.get("cto");
  if (!ctoToken) throw new Error("missing test credential");
  token = ctoToken;
  credentialPath = join(home, "cto.token");
  configPath = join(home, "claude-adapter.json");
  await writeFile(credentialPath, `${token}\n`, { mode: 0o600 });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]);
});

function validConfiguration() {
  return {
    version: 1,
    kind: "claude",
    project: "verdicta",
    projectRoot: root,
    agentId: "cto",
    sessionId: "claude-visible-cto",
    relayUrl: "http://127.0.0.1:4100",
    credentialPath,
    protocolVersion: PROTOCOL_VERSION,
  };
}

async function writeConfiguration(value: unknown): Promise<void> {
  await writeFile(configPath, JSON.stringify(value));
}

describe("standalone adapter configuration", () => {
  it("loads strict JSON, resolves the external credential, and verifies its role", async () => {
    await writeConfiguration(validConfiguration());

    const loaded = await loadAdapterConfiguration(configPath);
    expect(loaded.token).toBe(token);
    expect(loaded.configuration).toMatchObject({
      kind: "claude",
      project: "verdicta",
      agentId: "cto",
      sessionId: "claude-visible-cto",
      protocolVersion: 1,
    });
  });

  it.each([
    ["an inline token", { token: "must-not-be-accepted" }],
    ["an unknown field", { unexpected: true }],
    ["a different protocol", { protocolVersion: 2 }],
    ["a remote relay", { relayUrl: "https://example.com" }],
    [
      "both acceptance and production activation",
      {
        acceptanceMessageId: "69d2065f-46a4-4b2f-9482-f9a64f349e26",
        activationVerifiedAt: "2026-11-10T00:00:00.000Z",
      },
    ],
  ])("rejects %s", async (_name, override) => {
    await writeConfiguration({ ...validConfiguration(), ...override });

    await expect(loadAdapterConfiguration(configPath)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects a credential issued to another role before startup", async () => {
    await writeConfiguration({ ...validConfiguration(), agentId: "arch" });

    await expect(loadAdapterConfiguration(configPath)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects malformed JSON without exposing the credential", async () => {
    await writeFile(configPath, "{not-json");

    await expect(loadAdapterConfiguration(configPath)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("loads a strict Codex hook configuration without activation fields", async () => {
    await writeConfiguration({ ...validConfiguration(), kind: "codex" });

    const loaded = await loadAdapterConfiguration(configPath);
    expect(loaded.configuration).toMatchObject({
      kind: "codex",
      project: "verdicta",
      agentId: "cto",
      sessionId: "claude-visible-cto",
      protocolVersion: 1,
    });
    expect(loaded.configuration).not.toHaveProperty("activationVerifiedAt");
    expect(loaded.configuration).not.toHaveProperty("acceptanceMessageId");
  });

  it("rejects Codex in the generic active adapter runner", async () => {
    const { startStandaloneAdapter } = await import("../../src/cli/adapter.js");
    await writeConfiguration({ ...validConfiguration(), kind: "codex" });

    await expect(startStandaloneAdapter(configPath)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Codex active delivery is unsupported; use codex-hook and MCP inbox",
    });
  });

  it.each(["activationVerifiedAt", "acceptanceMessageId"])(
    "rejects a Codex %s field",
    async (field) => {
      await writeConfiguration({
        ...validConfiguration(),
        kind: "codex",
        [field]:
          field === "acceptanceMessageId"
            ? "69d2065f-46a4-4b2f-9482-f9a64f349e26"
            : "2026-11-11T00:00:00.000Z",
      });
      await expect(loadAdapterConfiguration(configPath)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    },
  );

  it("accepts an OpenCode config with an optional service password", async () => {
    await writeConfiguration({
      ...validConfiguration(),
      kind: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      servicePassword: "desktop-service-password",
    });

    const loaded = await loadAdapterConfiguration(configPath);
    expect(loaded.configuration).toMatchObject({
      kind: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      servicePassword: "desktop-service-password",
    });
  });

  it("accepts an OpenCode config without the password (resolved from the service file)", async () => {
    await writeConfiguration({
      ...validConfiguration(),
      kind: "opencode",
      baseUrl: "http://127.0.0.1:4096",
    });

    const loaded = await loadAdapterConfiguration(configPath);
    expect(loaded.configuration).toMatchObject({ kind: "opencode" });
    expect(loaded.configuration).not.toHaveProperty("servicePassword");
  });
});
