import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGenericInit } from "../../src/cli/init-cli.js";
import { doctorCommand } from "../../src/cli/commands.js";

describe("init per-role placement", () => {
  it("uses a mixed manual-host manifest, prints claim checklists, and detects host drift offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-placement-cli-"));
    const home = join(root, "home");
    const manifest =
      "project: manual\nagents:\n  arch:\n    title: Architect\n    role: Design\n    host: codex-desktop\n  qa:\n    title: QA\n    role: Verify\n    host: zcode\n";
    await writeFile(join(root, "synloq.yaml"), manifest);
    const output: string[] = [];
    const initHost = vi.fn();
    const openCodeHost = vi.fn();
    await runGenericInit(
      [
        "--project-root",
        root,
        "--synloq-home",
        home,
        "--relay-url",
        "http://127.0.0.1:4399",
        "--non-interactive",
      ],
      {
        stdout: {
          write: (text) => {
            output.push(text);
            return true;
          },
        },
      },
      { initHost, openCodeHost },
    );
    expect(initHost).not.toHaveBeenCalled();
    expect(openCodeHost).not.toHaveBeenCalled();
    const result = JSON.parse(output.join(""));
    expect(result.roles).toEqual([
      {
        agentId: "arch",
        host: "codex-desktop",
        canProvisionSessions: false,
        hasPush: false,
      },
      { agentId: "qa", host: "zcode", canProvisionSessions: false, hasPush: false },
    ]);
    expect(result.manual.nextSteps.join(" ")).toContain("trust");
    expect(result.manual.nextSteps.join(" ")).toContain("synloq serve");
    expect(result.manual.roles[0].claimCode).toMatch(/^synloq-claim-qa-/);
    expect(result.desktop.roles[0].agentId).toBe("arch");
    expect(JSON.parse(await readFile(result.manual.roles[0].configPath, "utf8")).relayUrl).toBe(
      "http://127.0.0.1:4399",
    );
    await writeFile(
      join(root, "synloq.yaml"),
      manifest.replace("host: codex-desktop", "host: opencode"),
    );
    const report = await doctorCommand({ projectRoot: root, synloqHome: home });
    expect(report.participants[0]?.placement).toMatchObject({ host: "opencode", ok: false });
    expect(report.participants[0]?.placement?.issue).toContain("differs");
  });
});
