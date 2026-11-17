import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openCodeBackendLogPath,
  readOpenCodeMcpStates,
} from "../../../src/host/opencode/backend-log.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function readerFor(lines: string[]): (path: string, maxBytes: number) => Promise<string> {
  return async () => lines.join("\n");
}

describe("readOpenCodeMcpStates (#92)", () => {
  it("reports the latest event per synloq-* server, connected after failed", async () => {
    const states = await readOpenCodeMcpStates({
      readTail: readerFor([
        'timestamp=2026-11-16T12:10:24.707Z level=WARN run=abc message="mcp connect failed" server=synloq-arch status.status=failed status.error="Connection closed: MCP server process exited with code 1: something"',
        'timestamp=2026-11-16T12:11:32.360Z level=INFO run=abc message="mcp connected" server=synloq-arch tools=6 role=server',
      ]),
    });

    expect(states.get("synloq-arch")).toEqual({
      server: "synloq-arch",
      state: "connected",
      at: "2026-11-16T12:11:32.360Z",
    });
  });

  it("reports failed for connect failures and transport errors, with a narrow exit code", async () => {
    const states = await readOpenCodeMcpStates({
      readTail: readerFor([
        'timestamp=2026-11-16T12:11:32.360Z level=INFO run=abc message="mcp connected" server=synloq-cto tools=6 role=server',
        'timestamp=2026-11-16T12:11:33.516Z level=WARN run=abc message="mcp transport error" server=synloq-cto error="MCP server process exited with code 1: detail"',
        'timestamp=2026-11-16T12:12:00.000Z level=WARN run=abc message="mcp connect failed" server=synloq-arch status.status=failed status.error="Connection refused"',
      ]),
    });

    expect(states.get("synloq-cto")).toEqual({
      server: "synloq-cto",
      state: "failed",
      at: "2026-11-16T12:11:33.516Z",
      exitCode: 1,
    });
    // No exit code in the line → the field is absent (not undefined-filled).
    const arch = states.get("synloq-arch");
    expect(arch?.state).toBe("failed");
    expect(arch && "exitCode" in arch).toBe(false);
  });

  it("ignores non-synloq servers and malformed lines", async () => {
    const states = await readOpenCodeMcpStates({
      readTail: readerFor([
        'timestamp=2026-11-16T12:10:24.707Z level=WARN message="mcp connect failed" server=other-mcp status.status=failed',
        "this is not a log line",
        'message="mcp connected" server=synloq-tester tools=6',
      ]),
    });

    expect(states.has("other-mcp")).toBe(false);
    expect(states.get("synloq-tester")?.state).toBe("connected");
    expect(states.size).toBe(1);
  });

  it("never leaks the raw error payload, only the extracted exit code", async () => {
    const secretish = "C:/Users/x/.synloq/credentials/token-contents-should-not-appear";
    const states = await readOpenCodeMcpStates({
      readTail: readerFor([
        `timestamp=2026-11-16T12:10:24.707Z level=WARN message="mcp connect failed" server=synloq-arch status.status=failed status.error="Connection closed: MCP server process exited with code 2: ${secretish}"`,
      ]),
    });

    const arch = states.get("synloq-arch");
    expect(arch).toMatchObject({ state: "failed", exitCode: 2 });
    expect(JSON.stringify(arch)).not.toContain(secretish);
  });

  it("is offline-safe: a missing log yields an empty map", async () => {
    const states = await readOpenCodeMcpStates({
      readTail: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    expect(states.size).toBe(0);
  });

  it("reads only the bounded tail and drops a cut first line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synloq-oc-log-"));
    directories.push(directory);
    const logDir = join(directory, "opencode", "log");
    await mkdir(logDir, { recursive: true });
    const path = join(logDir, "opencode.log");
    const filler = "x".repeat(2000);
    await writeFile(
      path,
      [
        `timestamp=2026-11-16T12:00:00.000Z level=WARN message="mcp connect failed" server=synloq-arch status.status=failed`,
        filler,
        'timestamp=2026-11-16T12:05:00.000Z level=INFO message="mcp connected" server=synloq-arch tools=6',
        "",
      ].join("\n"),
      "utf8",
    );

    // The tail window covers only the connected line; the failed line and the
    // (cut) filler fall outside or fail to parse.
    const states = await readOpenCodeMcpStates({
      maxBytes: 256,
      environment: { XDG_DATA_HOME: directory },
    });
    expect(states.get("synloq-arch")?.state).toBe("connected");
    expect(states.size).toBe(1);
  });

  it("resolves the default log path from XDG_DATA_HOME with a home fallback", () => {
    expect(openCodeBackendLogPath({ XDG_DATA_HOME: "/data" })).toBe(
      join("/data", "opencode", "log", "opencode.log"),
    );
    expect(openCodeBackendLogPath({ HOME: "/home/u" })).toBe(
      join("/home/u", ".local", "share", "opencode", "log", "opencode.log"),
    );
  });
});
