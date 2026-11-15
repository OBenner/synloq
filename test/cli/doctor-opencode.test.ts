import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorCommand } from "../../src/cli/commands.js";
import type { OpenCodeHostCheck } from "../../src/cli/doctor.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { mergeManifestParticipants } from "../../src/config/manifest.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore } from "../../src/config/team-state.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { OpenCodeSessionHost } from "../../src/host/opencode/client.js";
import { mergeOpencodeMcpServers } from "../../src/host/opencode/config-file.js";

const PROJECT = "stand";
const SESSION_ID = "ses_test_1";

let root: string;
let home: string;
const temporaryDirectories: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synloq-doctor-oc-project-"));
  home = await mkdtemp(join(tmpdir(), "synloq-doctor-oc-home-"));
  temporaryDirectories.push(root, home);

  await mergeManifestParticipants(
    root,
    [
      { project: PROJECT, agentId: "cto", title: "CTO", role: "Coordinates" },
      { project: PROJECT, agentId: "tester", title: "Tester", role: "Verifies" },
    ],
    "en",
  );
  const credentials = new CredentialStore(root, home);
  await credentials.ensureCredential(PROJECT, "tester");
  const paths = await projectPaths(root, home);
  await new TeamStateStore(paths.bindings).write({
    version: 1,
    project: PROJECT,
    projectRoot: root,
    conversations: {
      tester: { kind: "opencode", agentId: "tester", sessionId: SESSION_ID, directory: root },
    },
  });
});

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeHost(getSession: (id: string) => Promise<boolean>): OpenCodeSessionHost {
  return {
    getSession,
    createSession: () => {
      throw new Error("not used by doctor");
    },
    postPrompt: () => {
      throw new Error("not used by doctor");
    },
    deleteSession: () => {
      throw new Error("not used by doctor");
    },
  };
}

async function testerCheck(
  options: Partial<Parameters<typeof doctorCommand>[0]> = {},
): Promise<{ hostCheck: OpenCodeHostCheck; credential: { status: string } | undefined }> {
  const report = await doctorCommand({ projectRoot: root, synloqHome: home, ...options });
  const tester = report.participants.find((participant) => participant.agentId === "tester");
  expect(tester?.hostCheck).toBeDefined();
  return { hostCheck: tester!.hostCheck!, credential: tester?.credential };
}

describe("doctor OpenCode host checks (#32 W6)", () => {
  it("stays offline by default: session unknown, config consistency still reported", async () => {
    await mergeOpencodeMcpServers(root, {
      "synloq-tester": { type: "local", command: ["node", "stdio.js"], enabled: true },
    });

    const { hostCheck, credential } = await testerCheck({});
    expect(hostCheck).toEqual({
      sessionId: SESSION_ID,
      session: "unknown",
      opencodeConfig: "present",
    });
    expect(credential?.status).toBe("ok");
  });

  it("flags a missing opencode.json entry without any probe", async () => {
    const { hostCheck } = await testerCheck({});
    expect(hostCheck.opencodeConfig).toBe("missing");
    expect(hostCheck.session).toBe("unknown");
  });

  it("flags an unreadable opencode.json instead of failing doctor", async () => {
    await writeFile(join(root, "opencode.json"), "{ not json", "utf8");

    const { hostCheck } = await testerCheck({});
    expect(hostCheck.opencodeConfig).toBe("unreadable");
  });

  it("reports a live session with --check-host", async () => {
    const seen: string[] = [];
    const { hostCheck } = await testerCheck({
      checkHost: true,
      openCodeHost: fakeHost(async (id) => {
        seen.push(id);
        return true;
      }),
    });
    expect(seen).toEqual([SESSION_ID]);
    expect(hostCheck.session).toBe("alive");
  });

  it("reports a dead session when the host no longer knows it", async () => {
    const { hostCheck } = await testerCheck({
      checkHost: true,
      openCodeHost: fakeHost(async () => false),
    });
    expect(hostCheck.session).toBe("dead");
  });

  it("degrades to unknown with a note when the host is unreachable", async () => {
    const { hostCheck } = await testerCheck({
      checkHost: true,
      openCodeHost: fakeHost(async () => {
        throw new SynloqError("NOT_FOUND", "OpenCode service is unavailable");
      }),
    });
    expect(hostCheck.session).toBe("unknown");
    expect(hostCheck.note).toBe("OpenCode service is unavailable");
  });

  it("degrades to unknown when --check-host is set but no host was discovered", async () => {
    const { hostCheck } = await testerCheck({ checkHost: true });
    expect(hostCheck.session).toBe("unknown");
    expect(hostCheck.note).toBe("opencode-host-unreachable");
  });

  it("does not attach hostCheck to Kimi Work-bound roles", async () => {
    const report = await doctorCommand({ projectRoot: root, synloqHome: home });
    const cto = report.participants.find((participant) => participant.agentId === "cto");
    expect(cto?.hostCheck).toBeUndefined();
  });
});
