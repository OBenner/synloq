import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore, type TeamState } from "../../src/config/team-state.js";
import { initializeOpenCodeTeam } from "../../src/init/opencode-host.js";

const roles = [
  { agentId: "cto", title: "CTO", role: "Coordinates the team" },
  { agentId: "arch", title: "Architect", role: "Designs the system" },
];

async function setup(): Promise<{ root: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synloq-opencode-init-")));
  const home = await mkdtemp(join(tmpdir(), "synloq-opencode-home-"));
  return { root, home };
}

describe("initializeOpenCodeTeam", () => {
  it("creates manifest, credentials, legacy MCP configs, opencode.json, and team state", async () => {
    const { root, home } = await setup();
    const result = await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    });

    expect(result.project).toBe("stand");
    expect(result.roles.map((role) => role.agentId)).toEqual(["cto", "arch"]);
    expect(result.registrationRequired).toBe(true);

    const manifest = await readFile(join(root, "synloq.yaml"), "utf8");
    expect(manifest).toContain("cto");
    expect(manifest).toContain("arch");

    const paths = await projectPaths(root, home);
    const ctoConfig = JSON.parse(
      await readFile(join(paths.runtime, "mcp", "cto.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(ctoConfig).toEqual({
      relayUrl: "http://127.0.0.1:4100",
      credentialPath: result.roles[0]!.credentialPath,
    });
    await readFile(result.roles[0]!.credentialPath, "utf8");

    const opencode = JSON.parse(await readFile(join(root, "opencode.json"), "utf8")) as {
      mcp: { servers: Record<string, { type: string; command: string[]; enabled: boolean }> };
    };
    expect(Object.keys(opencode.mcp.servers).sort()).toEqual(["synloq-arch", "synloq-cto"]);
    expect(opencode.mcp.servers["synloq-cto"]).toEqual({
      type: "local",
      command: ["node", "dist/mcp/stdio.js", join(paths.runtime, "mcp", "cto.json")],
      enabled: true,
    });

    const state = await new TeamStateStore(paths.bindings).read();
    expect(state).toMatchObject({ project: "stand", projectRoot: root, conversations: {} });
  });

  it("honours a custom loopback relay URL", async () => {
    const { root, home } = await setup();
    const result = await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles: [roles[0]!],
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
      relayUrl: "http://127.0.0.1:4201",
    });
    const config = JSON.parse(await readFile(result.roles[0]!.configPath, "utf8")) as {
      relayUrl: string;
    };
    expect(config.relayUrl).toBe("http://127.0.0.1:4201");
  });

  it("re-run is a no-op: identical opencode.json, reused credentials, preserved conversations", async () => {
    const { root, home } = await setup();
    const options = {
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    };
    const first = await initializeOpenCodeTeam(options);
    const paths = await projectPaths(root, home);

    const conversation = {
      agentId: "cto",
      workAgentId: "main",
      sessionKey: "agent:main:main",
      conversationKey: "existing-key",
      conversationId: "existing-id",
      workspacePath: root,
    };
    await new TeamStateStore(paths.bindings).update((state): TeamState => ({
      ...state!,
      conversations: { cto: conversation },
    }));

    const second = await initializeOpenCodeTeam(options);
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(
      await readFile(join(root, "opencode.json"), "utf8"),
    );
    expect(second.roles[0]!.credentialPath).toBe(first.roles[0]!.credentialPath);
    expect(await readFile(second.roles[0]!.credentialPath, "utf8")).toBe(
      await readFile(first.roles[0]!.credentialPath, "utf8"),
    );
    const state = await new TeamStateStore(paths.bindings).read();
    expect(state!.conversations["cto"]).toEqual(conversation);
  });

  it("rejects --conversation bindings without a reachable service", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles: [{ ...roles[0]!, conversationKey: "ses_123" }],
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a non-loopback relay URL", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
        relayUrl: "http://203.0.113.10:4100",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects duplicate role IDs and foreign team state", async () => {
    const { root, home } = await setup();
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles: [roles[0]!, roles[0]!],
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await initializeOpenCodeTeam({
      projectRoot: root,
      project: "stand",
      roles,
      synloqHome: home,
      runtimeEntrypoint: "dist/mcp/stdio.js",
    });
    await expect(
      initializeOpenCodeTeam({
        projectRoot: root,
        project: "other",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("initializeOpenCodeTeam with a live server API", () => {
  interface FakeSession {
    id: string;
    body: Record<string, unknown>;
    prompts: string[];
  }

  async function stand(): Promise<{
    root: string;
    home: string;
    baseUrl: string;
    sessions: Map<string, FakeSession>;
    close: () => Promise<void>;
  }> {
    const { createServer } = await import("node:http");
    const { root, home } = await setup();
    const sessions = new Map<string, FakeSession>();
    let counter = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const url = request.url ?? "";
        if (request.method === "POST" && url === "/api/session") {
          counter += 1;
          const id = `ses_${counter}`;
          sessions.set(id, { id, body, prompts: [] });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id }));
          return;
        }
        const promptMatch = /^\/api\/session\/([^/]+)\/prompt$/.exec(url);
        if (request.method === "POST" && promptMatch) {
          const session = sessions.get(promptMatch[1]!);
          if (!session) {
            response.writeHead(404).end();
            return;
          }
          session.prompts.push(body.text);
          response.writeHead(200, { "content-type": "application/json" }).end("{}");
          return;
        }
        const getMatch = /^\/api\/session\/([^/]+)$/.exec(url);
        if (request.method === "GET" && getMatch) {
          const session = sessions.get(getMatch[1]!);
          if (!session) {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: session.id }));
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      root,
      home,
      baseUrl: `http://127.0.0.1:${port}`,
      sessions,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("creates one session per role, posts role prompts, and persists opencode bindings", async () => {
    const { root, home, baseUrl, sessions, close } = await stand();
    try {
      const { OpencodeApiClient } = await import("../../src/host/opencode/client.js");
      const result = await initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
        host: new OpencodeApiClient(baseUrl),
      });

      expect(sessions.size).toBe(2);
      expect(result.roles.map((role) => role.sessionId)).toEqual(["ses_1", "ses_2"]);
      const cto = sessions.get("ses_1")!;
      expect(cto.body).toMatchObject({ title: "CTO", location: { directory: root } });
      expect(cto.body.permissions).toEqual([
        { action: "synloq-arch*", resource: "*", effect: "deny" },
      ]);
      expect(cto.prompts).toHaveLength(1);
      expect(cto.prompts[0]).toContain("Role ID: cto");

      const paths = await projectPaths(root, home);
      const state = await new TeamStateStore(paths.bindings).read();
      expect(state!.conversations["cto"]).toEqual({
        kind: "opencode",
        agentId: "cto",
        sessionId: "ses_1",
        directory: root,
      });
      expect(state!.conversations["arch"]).toMatchObject({ kind: "opencode", sessionId: "ses_2" });
    } finally {
      await close();
    }
  });

  it("reconciles: keeps live sessions, recreates missing ones, never re-prompts a live session", async () => {
    const { root, home, baseUrl, sessions, close } = await stand();
    try {
      const { OpencodeApiClient } = await import("../../src/host/opencode/client.js");
      const options = {
        projectRoot: root,
        project: "stand",
        roles,
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
        host: new OpencodeApiClient(baseUrl),
      };
      await initializeOpenCodeTeam(options);
      sessions.delete("ses_2"); // arch session died

      const second = await initializeOpenCodeTeam(options);
      expect(sessions.has("ses_1")).toBe(true);
      expect(sessions.get("ses_1")!.prompts).toHaveLength(1);
      expect(second.roles[1]!.sessionId).toBe("ses_3");
      expect(sessions.get("ses_3")!.prompts).toHaveLength(1);

      const paths = await projectPaths(root, home);
      const state = await new TeamStateStore(paths.bindings).read();
      expect(state!.conversations["arch"]).toMatchObject({ sessionId: "ses_3" });
      expect(state!.conversations["cto"]).toMatchObject({ sessionId: "ses_1" });
    } finally {
      await close();
    }
  });

  it("binds an existing session via --conversation and rejects a missing one", async () => {
    const { root, home, baseUrl, sessions, close } = await stand();
    try {
      const { OpencodeApiClient } = await import("../../src/host/opencode/client.js");
      sessions.set("ses_external", { id: "ses_external", body: {}, prompts: [] });
      const host = new OpencodeApiClient(baseUrl);

      const result = await initializeOpenCodeTeam({
        projectRoot: root,
        project: "stand",
        roles: [{ ...roles[0]!, conversationKey: "ses_external" }],
        synloqHome: home,
        runtimeEntrypoint: "dist/mcp/stdio.js",
        host,
      });
      expect(result.roles[0]!.sessionId).toBe("ses_external");
      expect(sessions.get("ses_external")!.prompts).toHaveLength(0);

      await expect(
        initializeOpenCodeTeam({
          projectRoot: root,
          project: "stand",
          roles: [{ ...roles[1]!, conversationKey: "ses_missing" }],
          synloqHome: home,
          runtimeEntrypoint: "dist/mcp/stdio.js",
          host,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await close();
    }
  });

  it("refuses to rebind a role already bound to a Kimi Work conversation", async () => {
    const { root, home, baseUrl, close } = await stand();
    try {
      const { OpencodeApiClient } = await import("../../src/host/opencode/client.js");
      const paths = await projectPaths(root, home);
      await new TeamStateStore(paths.bindings).write({
        version: 1,
        project: "stand",
        projectRoot: root,
        conversations: {
          cto: {
            agentId: "cto",
            workAgentId: "main",
            sessionKey: "agent:main:main",
            conversationKey: "agent:main:main:conversation:kimi",
            conversationId: "kimi",
            workspacePath: root,
          },
        },
      });
      await expect(
        initializeOpenCodeTeam({
          projectRoot: root,
          project: "stand",
          roles,
          synloqHome: home,
          runtimeEntrypoint: "dist/mcp/stdio.js",
          host: new OpencodeApiClient(baseUrl),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await close();
    }
  });
});
