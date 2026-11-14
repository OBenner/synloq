// Minimal MCP stdio probe: logs process identity at startup, then answers the
// MCP handshake so the host keeps the process alive. Used to test whether
// Codex Desktop spawns per-conversation stdio servers with cwd set to the
// thread's project directory (see relay thread 7412fb3b / decisions-log D-11).
//
// Register globally in ~/.codex/config.toml:
//   [mcp_servers.synloq-cwd-probe]
//   command = "node"
//   args = ["<absolute path to this file>"]
//
// Each spawned process appends one JSON line to the log file:
//   SYNLOQ_CWD_PROBE_LOG env var, default <os.tmpdir()>/synloq-cwd-probe.jsonl

import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const logPath = process.env.SYNLOQ_CWD_PROBE_LOG ?? join(tmpdir(), "synloq-cwd-probe.jsonl");
mkdirSync(dirname(logPath), { recursive: true });

appendFileSync(
  logPath,
  JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    execPath: process.execPath,
  }) + "\n",
);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize" && msg.id !== undefined) {
    // Probe B: log whatever session/project identity the host passes us
    // (clientInfo, capabilities, roots, _meta) — looking for a per-chat id.
    appendFileSync(
      logPath,
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        event: "initialize",
        params: msg.params ?? null,
      }) + "\n",
    );
    const reply = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: {},
        serverInfo: { name: "synloq-cwd-probe", version: "0.0.1" },
      },
    };
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
  // Notifications (including notifications/initialized) need no reply.
});
