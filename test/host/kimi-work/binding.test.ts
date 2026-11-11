import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveKimiWorkBinding,
  type KimiWorkConfiguration,
} from "../../../src/host/kimi-work/binding.js";

const roots: string[] = [];
const conversationKey = "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "synloq-kimi-binding-"));
  roots.push(value);
  return value;
}

function configuration(projectRoot: string): KimiWorkConfiguration {
  return { projectRoot, agentId: "arch", conversationKey, workAgentId: "main" };
}

describe("resolveKimiWorkBinding", () => {
  it("binds the declared Synloq role to the visible conversation", async () => {
    const directory = await root();

    await expect(
      resolveKimiWorkBinding(join(directory, "role.json"), configuration(directory)),
    ).resolves.toMatchObject({ agentId: "arch", conversationKey });
  });

  it("resolves a relative project root and derives the stable session key", async () => {
    const directory = await root();
    const configPath = join(directory, "mcp", "role.json");

    await expect(
      resolveKimiWorkBinding(configPath, { projectRoot: "..", agentId: "arch", conversationKey }),
    ).resolves.toEqual({
      agentId: "arch",
      workAgentId: "main",
      conversationKey,
      sessionKey: "agent:main:main",
      workspacePath: directory,
    });
  });

  it("preserves the exact arbitrary Work agent and conversation identity", async () => {
    const directory = await root();
    const key = "agent:reviewer:project-1:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb";

    await expect(
      resolveKimiWorkBinding(join(directory, "role.json"), {
        projectRoot: ".",
        agentId: "reviewer",
        conversationKey: key,
        workAgentId: "reviewer",
      }),
    ).resolves.toMatchObject({
      agentId: "reviewer",
      workAgentId: "reviewer",
      conversationKey: key,
      sessionKey: "agent:reviewer:project-1",
      workspacePath: directory,
    });
  });

  it.each([
    ["missing separator", "agent:main:main"],
    ["non-UUID suffix", "agent:main:main:conversation:not-a-uuid"],
    ["non-client-shaped prefix", "sdk:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138"],
    ["extra separator", `${conversationKey}:extra`],
    ["uppercase agent", "agent:Main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138"],
  ])("rejects a malformed conversation key: %s", async (_name, value) => {
    const directory = await root();
    await expect(
      resolveKimiWorkBinding(join(directory, "role.json"), {
        ...configuration(directory),
        conversationKey: value,
      }),
    ).rejects.toMatchObject({ name: "SynloqError", code: "INVALID_INPUT" });
  });

  it("rejects unknown fields without reflecting secrets into the error", async () => {
    const directory = await root();
    const secret = "stdio-secret-token";
    const result = await resolveKimiWorkBinding(join(directory, "role.json"), {
      ...configuration(directory),
      token: secret,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({ name: "SynloqError", code: "INVALID_INPUT" });
    expect((result as Error).message).not.toContain(secret);
  });
});
