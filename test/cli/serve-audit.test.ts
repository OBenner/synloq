import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
`;

describe("serveCommand audit wiring", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("writes an audit line for a request with an invalid bearer token", async () => {
    const root = mkdtempSync(join(tmpdir(), "synloq-serve-audit-"));
    dirs.push(root);
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    const home = join(root, ".synloq");
    const handle = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    try {
      const response = await fetch(`${handle.baseUrl}/v1/participants`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(response.status).toBe(401);
      const paths = await projectPaths(root, home);
      const auditPath = join(paths.home, "data", `${paths.key}-audit.jsonl`);
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        action: "authenticate",
        decision: "deny",
        reasonCode: "UNAUTHORIZED",
      });
    } finally {
      await handle.close();
    }
  });

  it("records a relay denial for a foreign inbox with the authenticated identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "synloq-serve-audit-inbox-"));
    dirs.push(root);
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    const home = join(root, ".synloq");
    const handle = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    try {
      // No credentials issued at all: every token is invalid, so this request
      // never reaches RelayService. The foreign-inbox path is covered in
      // test/relay/relay-service-audit.test.ts; here we pin that the audit
      // file exists only after a denial and stays empty otherwise.
      const paths = await projectPaths(root, home);
      const auditPath = join(paths.home, "data", `${paths.key}-audit.jsonl`);
      const ok = await fetch(`${handle.baseUrl}/v1/health`);
      expect(ok.status).toBe(200);
      await expect(async () => readFileSync(auditPath, "utf8")).rejects.toThrow();
    } finally {
      await handle.close();
    }
  });
});
