# Synloq

Synloq is a local-first message relay for existing, visible coding-agent chats. A loopback HTTP relay owns durable SQLite state. Each chat receives only six agent-facing MCP tools, while explicitly configured adapters provide active delivery to a bound visible session.

Synloq is not an orchestrator. It does not create replacement chats, run one-shot model subprocesses, assign tasks, execute workflows, operate a dashboard, merge or push changes, or deliver to remote clients.

## Support status

- The reference adapter is covered by automated contract and end-to-end tests.
- Claude Code active delivery is **UNVERIFIED** until the manual evidence matrix is executed.
- OpenCode active delivery is **UNVERIFIED** until the manual evidence matrix is executed.
- Codex MCP inbox and lifecycle state reporting are implemented with controlled doubles; live compatibility is **UNVERIFIED**. Active delivery is unsupported and disabled.
- Kimi Work visible delivery to an exact bound client conversation is **VERIFIED for the local CTO ↔ Architect stand on 2026-11-11**: visible two-way turns, autonomous acknowledgement/reply, idempotent resend, and busy deferral passed. See `docs/superpowers/specs/2026-11-11-kimi-work-live-acceptance.md`. Other hosts and Kimi Code CLI active delivery remain **UNVERIFIED**.

Controlled transports and fake SDK clients are contract evidence, not live-client evidence. See `docs/client-compatibility.md` and `test/e2e/real-clients.md`.

## Requirements and installation

- Node.js 24 or newer (SQLite support is provided by `node:sqlite`).
- pnpm 12.18.0 for a repository checkout.

From a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
```

The package is private and has no publish workflow. To create a local installable archive without publishing:

```bash
pnpm pack --pack-destination .tmp-pack
```

The archive contains the compiled `dist` runtime, README, and package metadata. It excludes sources, tests, runtime databases, credentials, logs, IDE state, and message bodies.

The examples below use `node dist/cli/main.js` so they also work without modifying global PATH. After installing or linking the local package, the equivalent binary command is `synloq`.

## 1. Declare roles and initialize a project

Create `synloq.yaml` in the project root:

```yaml
version: 1
project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
  arch:
    title: Architect
    role: Architecture review
```

Initialize once:

```bash
node dist/cli/main.js init --project-root /absolute/path/to/project
```

The JSON output contains an operator token and one token per role, plus the credential and database paths. Save each token in a separate file outside Git with mode `0600`. The stored credential file contains hashes, not recoverable plaintext tokens; keep the one-time output secure.

Do not commit token files, adapter configuration containing secrets, SQLite files, logs, evidence containing message bodies, or IDE state.

## 2. Start the relay

```bash
node dist/cli/main.js serve \
  --project-root /absolute/path/to/project \
  --host 127.0.0.1 \
  --port 4100
```

The command prints a `relayUrl` and runs until SIGINT or SIGTERM. Only `127.0.0.1` and `::1` are accepted. Port `0` selects a free port and is useful for automated tests. The relay owns writes to the per-project SQLite database; run one relay for a project database.

`serve` does not invent stdio clients or inject hidden chats. Start the visible-client and adapter processes described below explicitly.

## 3. Connect ordinary MCP tools to a visible chat

Create a strict JSON file outside Git, for example `/secure/cto-mcp.json`:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token"
}
```

The stdio command is:

```bash
node /absolute/path/to/synloq/dist/cli/main.js mcp --config /secure/cto-mcp.json
```

Configure this command as an MCP stdio server in the existing visible chat. For clients using the common `mcpServers` JSON shape, the configuration is:

```json
{
  "mcpServers": {
    "synloq": {
      "command": "node",
      "args": [
        "/absolute/path/to/synloq/dist/cli/main.js",
        "mcp",
        "--config",
        "/secure/cto-mcp.json"
      ]
    }
  }
}
```

Use the recipient role's own credential in each chat. Do not place a token in JSON or on a command line.

### The six agent-facing tools

| Tool           | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `synloq_list`  | List project participants and role descriptions.                     |
| `synloq_send`  | Send one direct message with an idempotency key.                     |
| `synloq_reply` | Reply to an incoming message in its original thread.                 |
| `synloq_inbox` | Read the authenticated role's incoming history.                      |
| `synloq_wait`  | Bounded long poll for the next incoming message; timeout is normal.  |
| `synloq_ack`   | Acknowledge a delivered message addressed to the authenticated role. |

There are no agent-facing registration, credential, pause, resume, replacement, doctor, permission, or capability-management tools.

## 4. Configure standalone active-delivery adapters

Active delivery is optional. MCP inbox retrieval works without it. Adapter JSON is strict: unknown fields, inline tokens, non-loopback URLs, unsupported protocol versions, and mismatched role credentials fail startup. `projectRoot`, `agentId`, `sessionId`, and the credential must describe the same visible role binding. Adapter protocol version is exactly `1`.

### Claude Code channel child

The visible Claude chat must launch the stdio channel as its child. The same channel connection exposes the six ordinary tools and Claude channel notifications:

```bash
node /absolute/path/to/synloq/dist/cli/main.js adapter \
  --config /secure/claude-cto.json
```

Default-disabled `/secure/claude-cto.json`:

```json
{
  "version": 1,
  "kind": "claude",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "cto",
  "sessionId": "the-visible-claude-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token",
  "protocolVersion": 1
}
```

With neither activation field present, active delivery is disabled. Do not infer activation from a client name or version.

For controlled acceptance only, add one exact message UUID and restart the same visible channel:

```json
"acceptanceMessageId": "69d2065f-46a4-4b2f-9482-f9a64f349e26"
```

This permits one notification for that UUID, once, only when the same session, protocol, idle state, and both channel capabilities are valid. It is consumed after a successful notification write and is not production verification. Ordinary messages still require verified activation. Send the probe while delivery is disabled first so its relay-generated UUID is known. `acceptanceMessageId` and `activationVerifiedAt` are mutually exclusive.

Only after the manual matrix supplies observed evidence, remove `acceptanceMessageId` and instead set:

```json
"activationVerifiedAt": "2026-11-10T12:00:00.000Z"
```

This is an operator assertion for the same visible session and protocol, not a bypass flag. Keep the existing Claude approval policy; Synloq never auto-approves permissions.

Configure these visible-session hook events to invoke the public hook command with the same Claude config: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, and `PreToolUse` (or another unknown event for fail-closed unknown state).

```bash
node /absolute/path/to/synloq/dist/cli/main.js claude-hook \
  --config /secure/claude-cto.json
```

Hook stdout is empty: no injected context or permission decision is emitted. Channel notification success is only `submitted`; a matching `UserPromptSubmit` hook with exact Synloq provenance supplies `delivered` evidence.

### OpenCode sidecar process

The visible OpenCode chat uses the ordinary `synloq mcp` stdio command for the six tools. Run active delivery as a separate, operator-configured process:

```bash
node /absolute/path/to/synloq/dist/cli/main.js adapter \
  --config /secure/opencode-arch.json
```

Example `/secure/opencode-arch.json`:

```json
{
  "version": 1,
  "kind": "opencode",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "arch",
  "sessionId": "the-visible-opencode-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/arch.token",
  "protocolVersion": 1,
  "baseUrl": "http://127.0.0.1:4096",
  "heartbeatIntervalMs": 1000
}
```

`baseUrl` is the existing visible OpenCode server's loopback API, not the Synloq relay. The adapter registers the exact session, subscribes to events, heartbeats fresh state, and submits only with `delivery: "queue"` and `resume: false`. It has no steering path. EOF or reconnect invalidates state until a fresh matching status arrives. Shutdown aborts event/heartbeat/delivery loops and closes the relay session.

### Process topology

```text
visible Claude chat
  └─ child stdio: synloq adapter --config claude-cto.json
       ├─ six MCP tools + Claude channel
       └─ HTTP to relay with cto credential
visible Claude hooks ── synloq claude-hook --config claude-cto.json

visible OpenCode chat
  └─ child stdio: synloq mcp --config arch-mcp.json (six tools)
separate OpenCode adapter: synloq adapter --config opencode-arch.json
       ├─ queue/events/status at the existing OpenCode server
       └─ HTTP to relay with arch credential

synloq serve ── one loopback HTTP relay and one project SQLite writer
```

### Kimi Work embedded visible delivery

A role's ordinary MCP JSON may include a strict `kimiWork` binding. The same MCP child process then owns the active-delivery runner; no separate adapter process is required:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/arch.token",
  "kimiWork": {
    "projectRoot": "/absolute/path/to/project",
    "agentId": "arch",
    "conversationKey": "agent:main:main:conversation:exact-client-conversation-uuid",
    "workAgentId": "main"
  }
}
```

`agentId` is the Synloq role declared in `synloq.yaml`; it is distinct from Kimi Work's `workAgentId`. The relay authenticates the role token and validates its project, role, and session binding during adapter registration. `conversationKey` must identify an existing visible `origin: "client"` conversation in the same canonical project workspace. The installed Kimi Work local-control endpoint and token are discovered in memory through `kimi-daimon status --json`; tokens are never added to role JSON. `KIMI_WORK_EXECUTABLE`, `KIMI_WORK_CLI`, and `KIMI_WORK_CONFIG` are optional installation overrides.

The bridge revalidates exact metadata and fresh idle state before one `conversations.send`. `delivered` means visible user-turn admission only, not model completion, reading, acknowledgement, or task completion. The receiving agent must call `synloq_ack` after actual reading and use `synloq_reply` for the original thread. Ambiguous sends receive bounded read-only history reconciliation; they are never blindly replayed. Risky actions still require operator approval.

If host initialization fails, all six MCP inbox tools remain available. Closing the MCP process closes its runner, adapter, and Synloq registration without closing Kimi Work. The local acceptance stand verified real two-way visible turns, autonomous acknowledgement/reply, idempotent resend, and busy deferral on 2026-11-11; uncertain-send reconciliation remains controlled-test evidence. Generic chat creation and host-enforced per-chat MCP isolation are separate, unfinished work.

## Codex MCP inbox and lifecycle state

Codex currently supports the authenticated MCP inbox and lifecycle state reporting only. Live compatibility is **UNVERIFIED**, and active delivery is unsupported and always disabled. Generic `synloq adapter --config` rejects Codex instead of starting an active runner.

Use one Codex configuration scope, normally one `CODEX_HOME`, for one Synloq role. Do not place role tokens in `config.toml`, and do not configure several role credentials in one shared Codex/Desktop scope. Shared Desktop multi-role binding is unverified.

Create `/secure/codex-mcp.json` separately from the adapter/hook configuration:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "./cto.token"
}
```

Register the existing stdio bridge, substituting absolute paths:

```bash
codex mcp add synloq-cto -- node /absolute/path/to/synloq/dist/mcp/stdio.js /secure/codex-mcp.json
```

Create `/secure/codex-cto.json` with the exact visible Codex session ID and the same role credential:

```json
{
  "version": 1,
  "kind": "codex",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "cto",
  "sessionId": "the-visible-codex-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token",
  "protocolVersion": 1
}
```

Configure these events in the same scope's `hooks.json`. Project-local hooks require a trusted project. Review and trust the exact definitions through Codex `/hooks`; changed hooks must be reviewed again. Do not bypass the trust flow.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "PreModelRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "Interrupt": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 3
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Every handler reads one hook JSON object, limited to 64 KiB, from stdin. Synloq writes no protocol output, `additionalContext`, continuation, permission decision, or message content to stdout. `SessionStart` registers `activeDelivery:false`, `stateReporting:true`, and `clientIdempotency:false`; subsequent events heartbeat state. A different `session_id` fails before relay mutation.

The read-only compatibility probe uses the installed executable without creating a chat or submitting work:

```bash
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path --thread-id REPLACE_WITH_VISIBLE_THREAD_ID
```

Without `--thread-id`, no resume occurs. With it, the probe permits only `thread/resume` and `thread/read` for that exact ID and records sanitized metadata. Neither command is active-delivery evidence. See `docs/client-compatibility.md` and `test/e2e/real-clients.md` for limits and acceptance evidence.

## 5. Binding, replacement, pause, and diagnostics

Adapter startup performs initial same-role session registration through its operator-configured process. Registration is not an MCP tool. A role has one visible session binding. Re-registering the same session supports reconnect; binding a different session requires explicit operator replacement:

```bash
node dist/cli/main.js replace-session \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --agent-id arch \
  --session-id replacement-visible-session \
  --protocol-version 1 \
  --active-delivery true \
  --state-reporting true \
  --client-idempotency true
```

Use capabilities observed from the replacement adapter, never values inferred from a client version. Update the standalone adapter config to the same session before restarting it.

Pause or resume delivery with the operator credential:

```bash
node dist/cli/main.js pause \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --scope participant --scope-id arch

node dist/cli/main.js resume \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --scope participant --scope-id arch
```

Scopes are `project`, `participant`, and `thread`; named scopes require `--scope-id`. Pause gates are durable and do not delete messages.

Inspect local storage and registered sessions:

```bash
node dist/cli/main.js doctor --project-root /absolute/path/to/project
node dist/cli/main.js doctor --help
```

`unknown`, stale, busy, closed, unsupported, paused, or mismatched sessions fail closed. Message text cannot grant tools, permissions, registration, or capabilities.

## Runtime paths and external state

By default Synloq stores per-project state under:

```text
~/.synloq/credentials/<project-key>.json
~/.synloq/data/<project-key>.sqlite
```

Set `SYNLOQ_HOME` to relocate both trees. The key is derived from the canonical project root. Keep MCP/adapter JSON, plaintext token files, logs, and manual evidence outside the repository as well. Runtime logs and evidence indexes should identify participants and message IDs only; do not commit credentials or message bodies.

## Verification

```bash
pnpm verify
pnpm vitest run test/e2e/reference.e2e.test.ts
pnpm pack --pack-destination .tmp-pack
node dist/cli/main.js doctor --help
node dist/cli/main.js adapter --help
node dist/cli/main.js claude-hook --help
node dist/cli/main.js codex-hook --help
```

The automated reference scenario uses real relay/SQLite, real MCP in-memory transport, and the HTTP adapter path. It does not establish live Claude, OpenCode, Codex, or Kimi support. Complete `test/e2e/real-clients.md` with an operator before changing any live support status.
