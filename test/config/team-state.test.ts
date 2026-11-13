import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/config/credentials.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore, type TeamState } from "../../src/config/team-state.js";

async function fixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "synloq-state-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-state-home-"));
  return { root, home };
}

function state(root: string): TeamState {
  return {
    version: 1,
    project: "example",
    projectRoot: root,
    conversations: {},
  };
}

describe("TeamStateStore", () => {
  it("atomically persists exact arbitrary-role conversation bindings without secrets", async () => {
    const { root, home } = await fixture();
    const paths = await projectPaths(root, home);
    const store = new TeamStateStore(paths.bindings);
    const conversationKey = "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138";

    await store.update((current) => ({
      ...(current ?? state(root)),
      pluginSourcePath: join(home, "plugin-source"),
      conversations: {
        ...current?.conversations,
        reviewer: {
          agentId: "reviewer",
          workAgentId: "main",
          sessionKey: "agent:main:main",
          conversationKey,
          conversationId: "d7be2b2c-edfc-4fc7-a010-1e7af6465138",
          workspacePath: root,
        },
      },
    }));

    const persisted = await readFile(paths.bindings, "utf8");
    const reviewer = (await store.read())?.conversations.reviewer;
    expect(reviewer?.kind).not.toBe("opencode");
    expect(reviewer && "conversationKey" in reviewer ? reviewer.conversationKey : undefined).toBe(
      conversationKey,
    );
    expect(persisted).not.toContain("token");
    expect(persisted).not.toContain("clientInstructions");
  });

  it("returns undefined before initialization and rejects malformed state", async () => {
    const { root, home } = await fixture();
    const paths = await projectPaths(root, home);
    const store = new TeamStateStore(paths.bindings);

    await expect(store.read()).resolves.toBeUndefined();
    await mkdir(dirname(paths.bindings), { recursive: true });
    await writeFile(paths.bindings, JSON.stringify({ version: 1, project: "example" }));
    await expect(store.read()).rejects.toMatchObject({
      name: "SynloqError",
      code: "INVALID_INPUT",
    });
  });

  it("round-trips opencode sessions and legacy kimi entries in one union state", async () => {
    const { root, home } = await fixture();
    const paths = await projectPaths(root, home);
    const store = new TeamStateStore(paths.bindings);

    await store.update((current) => ({
      ...(current ?? state(root)),
      conversations: {
        legacy: {
          agentId: "legacy",
          workAgentId: "main",
          sessionKey: "agent:main:main",
          conversationKey: "agent:main:main:conversation:legacy",
          conversationId: "legacy",
          workspacePath: root,
        },
        cto: {
          kind: "opencode",
          agentId: "cto",
          sessionId: "ses_abc",
          directory: root,
        },
      },
    }));

    const read = await store.read();
    expect(read?.conversations.legacy).toMatchObject({ conversationId: "legacy" });
    expect(read?.conversations.legacy?.kind).not.toBe("opencode");
    expect(read?.conversations.cto).toEqual({
      kind: "opencode",
      agentId: "cto",
      sessionId: "ses_abc",
      directory: root,
    });
  });

  it("rejects opencode entries with extra keys and unknown kinds", async () => {
    const { root, home } = await fixture();
    const paths = await projectPaths(root, home);
    const store = new TeamStateStore(paths.bindings);
    await mkdir(dirname(paths.bindings), { recursive: true });

    await writeFile(
      paths.bindings,
      JSON.stringify({
        ...state(root),
        conversations: {
          cto: { kind: "opencode", agentId: "cto", sessionId: "s", directory: root, extra: 1 },
        },
      }),
    );
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await writeFile(
      paths.bindings,
      JSON.stringify({
        ...state(root),
        conversations: { cto: { kind: "other", agentId: "cto", sessionId: "s", directory: root } },
      }),
    );
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("CredentialStore.ensureCredential", () => {
  it("reuses a valid per-role token file and keeps plaintext outside plugin source", async () => {
    const { root, home } = await fixture();
    const paths = await projectPaths(root, home);
    const store = new CredentialStore(root, home);

    const first = await store.ensureCredential("example", "reviewer");
    const second = await store.ensureCredential("example", "reviewer");
    const other = await store.ensureCredential("example", "product");

    expect(second).toEqual({ ...first, reused: true });
    expect(first.reused).toBe(false);
    expect(other.token).not.toBe(first.token);
    expect(other.tokenPath).not.toBe(first.tokenPath);
    expect(first.tokenPath).toBe(join(paths.tokens, "reviewer.token"));
    expect(first.tokenPath).not.toContain("plugin-sources");
    await expect(store.authenticate("example", first.token)).resolves.toMatchObject({
      agentId: "reviewer",
    });
    const persisted = JSON.parse(await readFile(paths.credentials, "utf8")) as {
      entries: unknown[];
    };
    expect(persisted.entries).toHaveLength(2);
  });
});
