// Minimal MCP stdio probe: logs process identity at startup, answers the MCP
// handshake, then asks the client for roots/list and logs everything. Used to
// test (a) whether Codex Desktop spawns per-conversation stdio servers with
// cwd set to the thread's project directory and (b) whether any reliable
// chat/session identity reaches the server (initialize params, roots, env).
// See relay threads 7412fb3b / ac1ebdb8, decisions-log D-11/D-12.
//
// Register in ~/.codex/config.toml (global probe) or a trusted project's
// .codex/config.toml (project-scope probe):
//   [mcp_servers.synloq-cwd-probe]
//   command = "node"
//   args = ["<absolute path to this file>"]
//
// Each process appends JSON lines to SYNLOQ_CWD_PROBE_LOG,
// default <os.tmpdir()>/synloq-cwd-probe.jsonl.

import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const logPath = process.env.SYNLOQ_CWD_PROBE_LOG ?? join(tmpdir(), "synloq-cwd-probe.jsonl");
mkdirSync(dirname(logPath), { recursive: true });

function log(kind, data) {
  appendFileSync(
    logPath,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, ...data }) + "\n",
  );
}

// Env: names always, values only for a small allowlist (never tokens).
const ENV_VALUE_ALLOWLIST = /^(CODEX_|TERM_PROGRAM$|PWD$|INIT_CWD$|OLDPWD$)/;
const env = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k]) => ENV_VALUE_ALLOWLIST.test(k))
    .map(([k, v]) => [k, /TOKEN|KEY|SECRET|AUTH/i.test(k) ? "<redacted>" : v]),
);

log("spawn", {
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  execPath: process.execPath,
  ppid: process.ppid,
  envAllowlisted: env,
  envNamesAll: Object.keys(process.env).sort(),
});

let nextId = 1;
const pending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function requestRoots() {
  const id = `probe-${nextId++}`;
  pending.set(id, "roots/list");
  send({ jsonrpc: "2.0", id, method: "roots/list" });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    log("rootsResponse", { result: msg.result ?? null, error: msg.error ?? null });
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "initialize" && msg.id !== undefined) {
    // Log the full initialize payload verbatim: vendor-specific identity
    // fields (_meta, session/thread ids, workspace hints) would live here.
    log("initialize", { params: msg.params ?? null });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: {},
        serverInfo: { name: "synloq-cwd-probe", version: "0.0.2" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    // Client capability "roots" is advertised in initialize; ask anyway —
    // an error response is itself evidence.
    requestRoots();
  }
});
