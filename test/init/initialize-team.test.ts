import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import type {
  KimiWorkConversationSummary,
  KimiWorkCreateInput,
  KimiWorkListOptions,
} from "../../src/host/kimi-work/control-client.js";
import {
  initializeTeam,
  type InitializeTeamOptions,
  type KimiWorkInitHost,
} from "../../src/init/initialize-team.js";

class FakeHost implements KimiWorkInitHost {
  readonly created: KimiWorkCreateInput[] = [];
  readonly conversations: KimiWorkConversationSummary[] = [];
  readonly failures = new Set<number>();
  failAfterStore = false;

  async create(input: KimiWorkCreateInput): Promise<KimiWorkConversationSummary> {
    const sequence = this.created.length + 1;
    this.created.push(input);
    if (this.failures.has(sequence)) throw new Error("create failed before admission");
    const conversation: KimiWorkConversationSummary = {
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      conversationKey: `created-${sequence}`,
      conversationId: `conversation-${sequence}`,
      origin: input.origin,
      workspacePath: input.workspacePath,
      clientInstructions: input.clientInstructions,
      title: `Chat ${sequence}`,
    };
    this.conversations.push(conversation);
    if (this.failAfterStore) throw new Error("create result was lost");
    return conversation;
  }

  async list(options: KimiWorkListOptions): Promise<{
    conversations: KimiWorkConversationSummary[];
    page: { limit: number; hasMore: boolean };
  }> {
    return {
      conversations: this.conversations.filter(
        (conversation) =>
          conversation.agentId === options.agentId &&
          conversation.sessionKey === options.sessionKey &&
          conversation.origin === options.origin &&
          conversation.workspacePath === options.workspacePath,
      ),
      page: { limit: options.limit ?? 100, hasMore: false },
    };
  }
}

async function fixture(): Promise<{
  root: string;
  home: string;
  pluginSourcePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "synloq-init-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-init-home-"));
  return { root, home, pluginSourcePath: join(home, "generated-plugin") };
}

function options(
  root: string,
  home: string,
  pluginSourcePath: string,
  host: KimiWorkInitHost,
): InitializeTeamOptions {
  return {
    projectRoot: root,
    project: "example",
    roles: [
      { agentId: "product", title: "Product", role: "Own scope and priorities" },
      { agentId: "reviewer", title: "Reviewer", role: "Review evidence and risks" },
    ],
    pluginSourcePath,
    host,
    synloqHome: home,
    runtimeEntrypoint: join(root, "dist", "mcp", "stdio.js"),
  };
}

describe("initializeTeam", () => {
  it("creates arbitrary visible roles and reuses chats and credentials on rerun", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();

    const first = await initializeTeam(options(root, home, pluginSourcePath, host));
    const firstTokenPath = first.roles[0]?.credentialPath;
    if (!firstTokenPath) throw new Error("missing generated credential path");
    const firstToken = await readFile(firstTokenPath, "utf8");
    const second = await initializeTeam(options(root, home, pluginSourcePath, host));

    expect(host.created).toHaveLength(2);
    expect(host.created.every((input) => input.activate === false)).toBe(true);
    expect(host.created.every((input) => input.origin === "client")).toBe(true);
    expect(first.roles.map((role) => role.conversationKey)).toEqual(["created-1", "created-2"]);
    expect(second.roles).toEqual(first.roles);
    expect(second.registrationRequired).toBe(true);
    // Issue #36 (a): init reports whether the channel set actually changed.
    expect(first.previousPluginVersion).toBeUndefined();
    expect(first.channelsChanged).toBe(false);
    expect(first.nextStep).toContain("Install/Update");
    expect(second.previousPluginVersion).toBe(first.pluginVersion);
    expect(second.channelsChanged).toBe(false);
    expect(second.nextStep).toContain("unchanged");
    expect(JSON.stringify(second)).not.toContain(firstToken.trim());
    expect(await readFile(firstTokenPath, "utf8")).toBe(firstToken);

    const plugin = JSON.parse(
      await readFile(join(pluginSourcePath, "kimi.plugin.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(plugin.mcpServers).sort()).toEqual(["synloq-product", "synloq-reviewer"]);
    expect(Object.values(plugin.mcpServers).every((server) => server.command === "node")).toBe(
      true,
    );
    const locale = JSON.parse(
      await readFile(join(pluginSourcePath, "locales", "zh-CN.json"), "utf8"),
    ) as { mcpOverrides: Record<string, { displayName: string; description: string }> };
    expect(Object.keys(locale.mcpOverrides).sort()).toEqual(["synloq-product", "synloq-reviewer"]);
    expect(locale.mcpOverrides["synloq-product"]?.displayName).toBe("Synloq Product");
    expect(JSON.stringify(plugin)).not.toContain(firstToken.trim());
    expect(JSON.stringify(plugin)).not.toContain("CTO");
    expect(JSON.stringify(plugin)).not.toContain("Architect");
  });

  it("flags a channel-set change with an explicit Install/Update next step", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();

    const first = await initializeTeam(options(root, home, pluginSourcePath, host));
    const extended = options(root, home, pluginSourcePath, host);
    extended.roles = [...extended.roles, { agentId: "qa", title: "QA", role: "Verify outcomes" }];
    const second = await initializeTeam(extended);

    expect(second.channelsChanged).toBe(true);
    expect(second.previousPluginVersion).toBe(first.pluginVersion);
    expect(second.pluginVersion).not.toBe(first.pluginVersion);
    expect(second.nextStep).toContain("Channels changed");
    expect(second.nextStep).toContain("Install/Update");
    // The operator must learn that relay and tokens survive the update.
    expect(second.nextStep).toContain("relay");
  });

  it("persists each chat immediately and resumes without duplicating the first", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();
    host.failures.add(2);

    await expect(initializeTeam(options(root, home, pluginSourcePath, host))).rejects.toThrow(
      "create failed before admission",
    );
    const paths = await projectPaths(root, home);
    const state = await new TeamStateStore(paths.bindings).read();
    expect(Object.keys(state?.conversations ?? {})).toEqual(["product"]);

    host.failures.clear();
    const result = await initializeTeam(options(root, home, pluginSourcePath, host));
    expect(host.created).toHaveLength(3);
    expect(result.roles.map((role) => role.conversationKey)).toEqual(["created-1", "created-3"]);
  });

  it("fails closed before chat creation when plugin source belongs to another project", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();
    await mkdir(pluginSourcePath, { recursive: true });
    await writeFile(
      join(pluginSourcePath, ".synloq-owner.json"),
      JSON.stringify({ version: 1, project: "other", projectRoot: "I:\\other" }),
    );

    await expect(initializeTeam(options(root, home, pluginSourcePath, host))).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    expect(host.created).toHaveLength(0);
  });

  it("rejects duplicate supplied conversation ownership before creation", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();
    const input = options(root, home, pluginSourcePath, host);
    input.roles = input.roles.map((role) => ({ ...role, conversationKey: "shared-chat" }));

    await expect(initializeTeam(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(host.created).toHaveLength(0);
  });

  it("reconciles an uncertain create by exact workspace and instructions", async () => {
    const { root, home, pluginSourcePath } = await fixture();
    const host = new FakeHost();
    host.failAfterStore = true;

    const result = await initializeTeam({
      ...options(root, home, pluginSourcePath, host),
      roles: [{ agentId: "reviewer", title: "Reviewer", role: "Review evidence and risks" }],
    });

    expect(host.created).toHaveLength(1);
    expect(result.roles[0]?.conversationKey).toBe("created-1");
  });
});
