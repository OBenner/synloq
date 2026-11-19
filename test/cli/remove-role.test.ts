import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeRoleCommand } from "../../src/cli/commands.js";
import { ClaimCodeStore } from "../../src/config/claim-codes.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { loadManifest, mergeManifestParticipants } from "../../src/config/manifest.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import { OpencodeApiClient } from "../../src/host/opencode/client.js";
import { mergeOpencodeMcpServers } from "../../src/host/opencode/config-file.js";

const PROJECT = "stand";

interface Fixture {
  root: string;
  home: string;
  port: number;
  operatorTokenPath: string;
  deleted: string[];
  close: () => Promise<void>;
}

let fixture: Fixture;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-remove-role-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-remove-role-home-"));
  temporaryDirectories.push(root, home);

  const paths = await projectPaths(root, home);
  const credentials = new CredentialStore(root, home);
  await credentials.ensureOperatorCredential(PROJECT);
  await credentials.ensureCredential(PROJECT, "arch");
  await mergeManifestParticipants(
    root,
    [
      { project: PROJECT, agentId: "cto", title: "CTO", role: "Coordinates" },
      { project: PROJECT, agentId: "arch", title: "Architect", role: "Designs" },
    ],
    "en",
  );
  await mergeOpencodeMcpServers(root, {
    "synloq-arch": {
      type: "local",
      command: ["node", "dist/mcp/stdio.js", join(paths.runtime, "mcp", "arch.json")],
      enabled: true,
    },
  });
  await new TeamStateStore(paths.bindings).write({
    version: 1,
    project: PROJECT,
    projectRoot: root,
    conversations: {
      arch: { kind: "opencode", agentId: "arch", sessionId: "ses_1", directory: root },
    },
  });

  const deleted: string[] = [];
  const server = createServer((request, response) => {
    const match = /^\/api\/session\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && match) {
      deleted.push(match[1]!);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  fixture = {
    root,
    home,
    port,
    operatorTokenPath: join(paths.tokens, "operator.token"),
    deleted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterEach(async () => {
  await fixture.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("removeRoleCommand (#32 W5)", () => {
  it("tears down an OpenCode role: session, credential, claim code, manifest, config, state", async () => {
    const paths = await projectPaths(fixture.root, fixture.home);
    await new ClaimCodeStore(new TeamStateStore(paths.bindings)).issue("arch");
    const host = new OpencodeApiClient(`http://127.0.0.1:${fixture.port}`);

    const result = await removeRoleCommand({
      projectRoot: fixture.root,
      agentId: "arch",
      operatorCredentialPath: fixture.operatorTokenPath,
      synloqHome: fixture.home,
      openCodeHost: host,
    });

    expect(result).toMatchObject({
      agentId: "arch",
      manifest: "removed",
      credential: "revoked",
      claimCode: "cleared",
      session: "deleted",
      opencodeConfig: "removed",
    });
    expect(fixture.deleted).toEqual(["ses_1"]);
    expect((await loadManifest(fixture.root)).map((p) => p.agentId)).toEqual(["cto"]);
    const opencode = JSON.parse(await readFile(join(fixture.root, "opencode.json"), "utf8")) as {
      mcp: { servers: Record<string, unknown> };
    };
    expect(opencode.mcp.servers).toEqual({});
    const state = await new TeamStateStore(paths.bindings).read();
    expect(state!.conversations["arch"]).toBeUndefined();
    expect(state!.claims).toBeUndefined();
    // The revoked credential no longer authenticates.
    const token = (await readFile(fixture.operatorTokenPath, "utf8")).trim();
    const identity = await new CredentialStore(fixture.root, fixture.home).authenticate(
      PROJECT,
      token,
    );
    expect(identity.operator).toBe(true);
    expect(result.nextSteps.join("\n")).toContain("Restart the relay");
  });

  it("reports skipped-host-unavailable when no OpenCode host is supplied", async () => {
    const result = await removeRoleCommand({
      projectRoot: fixture.root,
      agentId: "arch",
      operatorCredentialPath: fixture.operatorTokenPath,
      synloqHome: fixture.home,
    });

    expect(result.session).toBe("skipped-host-unavailable");
    expect(result.manifest).toBe("removed");
    expect(result.nextSteps.join("\n")).toContain("OpenCode service was unreachable");
  });

  it("marks a Kimi Work-bound role as manual and keeps the chat note", async () => {
    const paths = await projectPaths(fixture.root, fixture.home);
    await new TeamStateStore(paths.bindings).update((state) => ({
      ...state!,
      conversations: {
        ...state!.conversations,
        arch: {
          agentId: "arch",
          workAgentId: "main",
          sessionKey: "agent:main:main",
          conversationKey: "agent:main:main:conversation:arch",
          conversationId: "kimi-1",
          workspacePath: fixture.root,
        },
      },
    }));

    const result = await removeRoleCommand({
      projectRoot: fixture.root,
      agentId: "arch",
      operatorCredentialPath: fixture.operatorTokenPath,
      synloqHome: fixture.home,
    });

    expect(result.session).toBe("manual");
    expect(result.nextSteps.join("\n")).toContain("Close the role's Kimi Work chat manually");
    expect(fixture.deleted).toEqual([]);
  });

  it("rejects an unknown role and a non-operator credential", async () => {
    await expect(
      removeRoleCommand({
        projectRoot: fixture.root,
        agentId: "ghost",
        operatorCredentialPath: fixture.operatorTokenPath,
        synloqHome: fixture.home,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const paths = await projectPaths(fixture.root, fixture.home);
    await expect(
      removeRoleCommand({
        projectRoot: fixture.root,
        agentId: "arch",
        operatorCredentialPath: join(paths.tokens, "arch.token"),
        synloqHome: fixture.home,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // The role survives a failed attempt.
    expect((await loadManifest(fixture.root)).map((p) => p.agentId)).toEqual(["cto", "arch"]);
  });
});
