# Synloq

Synloq is a local-first coordination plugin for visible coding-agent chats. Generic initialization creates explicitly configured Kimi Work client conversations for arbitrary project roles. A supervised loopback HTTP relay owns durable SQLite state, starts automatically with the generated role channels, and gives each chat only six agent-facing MCP tools.

Synloq is not an orchestrator. It does not hide work in replacement chats, run one-shot model subprocesses, execute workflows autonomously, operate a dashboard, merge or push changes, or deliver to remote clients. The operator can inspect and steer every visible role conversation directly.

## Support status

- The reference adapter is covered by automated contract and end-to-end tests.
- Claude Code active delivery is **UNVERIFIED** until the manual evidence matrix is executed.
- OpenCode active delivery is **UNVERIFIED** until the manual evidence matrix is executed.
- Codex MCP inbox and lifecycle state reporting are implemented with controlled doubles; live compatibility is **UNVERIFIED**. Active delivery is unsupported and disabled.
- Kimi Work visible delivery to an exact bound client conversation is **VERIFIED for the local CTO ↔ Architect stand on 2026-11-11**: visible two-way turns, autonomous acknowledgement/reply, idempotent resend, and busy deferral passed. See `docs/superpowers/specs/2026-11-11-kimi-work-live-acceptance.md`.
- Generic arbitrary-role initialization and automatic relay startup/recovery are **VERIFIED for an isolated local Product ↔ Reviewer Kimi Work stand on 2026-11-11**: exact visible chat creation, idempotent reconciliation, automatic startup, two visible reply cycles, and role-initiated acknowledgements passed. Live host respawn recovered the same role; surviving-peer election is covered by a real loopback/SQLite integration test, not claimed as live-host evidence. See `docs/superpowers/specs/2026-11-11-synloq-generic-init-acceptance.md` and `docs/superpowers/specs/2026-11-11-synloq-relay-lifecycle-acceptance.md`. Host-enforced per-chat MCP isolation, other hosts, and Kimi Code CLI active delivery remain **UNVERIFIED**.

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

## 1. Install the plugin and initialize arbitrary roles

For Kimi Work, register `plugins/synloq` through the supported personal-plugin source flow and install it in the client. Ask the agent to **Initialize Synloq for this project**. The skill confirms the project name and each role's stable ID, display name, responsibilities, boundaries, and optional instructions before running `synloq init`.

With no role arguments, `synloq init` starts the same confirmation wizard directly:

```bash
node dist/cli/main.js init --project-root /absolute/path/to/project
```

A non-interactive example with two arbitrary roles:

```bash
node dist/cli/main.js init \
  --project-root /absolute/path/to/project \
  --project example \
  --role "product:Product:Own scope and priorities" \
  --role "reviewer:Reviewer:Review evidence and risks" \
  --plugin-source /secure/synloq-plugin \
  --synloq-home /secure/synloq-home \
  --non-interactive
```

Initialization creates ordinary visible Kimi Work client chats without activating them, binds each exact conversation to its role, writes resumable state after every creation, and renders the personal plugin source with one authenticated MCP channel per role. Re-running the same command reconciles exact bindings and does not create duplicate chats. Use `--conversation <role-id:conversationKey>` to bind an existing visible chat instead.

The JSON result contains role bindings and generated file paths, but no plaintext tokens. Per-role token files are reused from the explicit Synloq home and never copied into plugin source. Do not commit token files, MCP configuration, SQLite files, logs, evidence containing message bodies, or IDE state.

When the result contains `registrationRequired: true`, use the client's single **Install/Update** action for the generated personal plugin. Source registration, plugin installation, channel availability, and end-to-end readiness are different states: do not claim readiness until both generated role channels have been checked.

An existing `synloq.yaml` can supply the same role declarations without `--role` arguments:

```yaml
version: 1
project: example
agents:
  product:
    title: Product
    role: Own scope and priorities
  reviewer:
    title: Reviewer
    role: Review evidence and risks
```

## 2. Automatic relay lifecycle

Generated Kimi Work role channels reuse or start the project relay automatically at `http://127.0.0.1:4100`; no separate `synloq serve` terminal is required. The first compatible MCP process owns the loopback listener and SQLite writer, while other roles reuse it after authenticated project validation. If the owner stops, a surviving channel performs bounded reconnection and listener election, invalidates its old host registration, and registers a new generation after recovery. Durable messages remain in SQLite.

Only explicit loopback HTTP origins with nonzero ports are accepted. An unrelated listener, wrong project, invalid credential, malformed response, or ambiguous endpoint fails closed instead of starting a second writer. A Kimi Work delivery failure does not remove the six MCP inbox tools while the relay remains healthy.

For advanced diagnostics or a custom standalone topology, `serve` remains available:

```bash
node dist/cli/main.js serve \
  --project-root /absolute/path/to/project \
  --host 127.0.0.1 \
  --port 4100
```

The command prints a `relayUrl` and runs until SIGINT or SIGTERM. Port `0` selects a free port for automated tests. Run exactly one writer for a project database; do not start this command alongside the generated automatic topology unless they intentionally share the single compatible relay.

## 3. Connect ordinary MCP tools to an existing chat

Generic initialization writes these files automatically. For other clients or a manual legacy setup, create a strict JSON file outside Git, for example `/secure/reviewer-mcp.json`:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/reviewer.token"
}
```

This legacy shape requires a compatible relay to be running already. Automatic startup is enabled only for generated configuration with an explicit `synloqHome` and exact `kimiWork` binding. The stdio command is:

```bash
node /absolute/path/to/synloq/dist/cli/main.js mcp --config /secure/reviewer-mcp.json
```

Configure this command as an MCP stdio server in the existing visible chat. Use the recipient role's own credential in each chat. Do not place a token in JSON or on a command line.

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

generated Kimi Work role MCP
  ├─ six tools + embedded visible-delivery runner
  └─ supervised relay ownership or authenticated reuse

standalone synloq serve (advanced) ── one loopback HTTP relay and one project SQLite writer
```

### Kimi Work embedded visible delivery

Generic initialization writes a strict `kimiWork` binding and explicit `synloqHome` for each role. The same MCP child process then supervises the relay and owns the active-delivery runner; no separate adapter process is required:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/synloq-home/tokens/reviewer.token",
  "synloqHome": "/secure/synloq-home",
  "kimiWork": {
    "projectRoot": "/absolute/path/to/project",
    "agentId": "reviewer",
    "conversationKey": "agent:main:main:conversation:exact-client-conversation-uuid",
    "workAgentId": "main"
  }
}
```

`agentId` is the Synloq role declared in `synloq.yaml`; it is distinct from Kimi Work's `workAgentId`. The relay authenticates the role token and validates its project, role, and session binding during adapter registration. `conversationKey` must identify an existing visible `origin: "client"` conversation in the same canonical project workspace. The installed Kimi Work local-control endpoint and token are discovered in memory through `kimi-daimon status --json`; tokens are never added to role JSON. `KIMI_WORK_EXECUTABLE`, `KIMI_WORK_CLI`, and `KIMI_WORK_CONFIG` are optional installation overrides.

The bridge revalidates exact metadata and fresh idle state before one `conversations.send`. `delivered` means visible user-turn admission only, not model completion, reading, acknowledgement, or task completion. The receiving agent must call `synloq_ack` after actual reading and use `synloq_reply` for the original thread. Ambiguous sends receive bounded read-only history reconciliation; they are never blindly replayed. Risky actions still require operator approval.

If host initialization fails, all six MCP inbox tools remain available while relay startup succeeds. Closing the MCP process closes its runner, adapter, and Synloq registration without closing Kimi Work; it closes only a relay listener owned by that process, allowing surviving roles to recover. The earlier local acceptance stand verified real two-way visible turns, autonomous acknowledgement/reply, idempotent resend, and busy deferral on 2026-11-11. The generic Product ↔ Reviewer stand separately verified arbitrary-role initialization, automatic startup, visible acknowledgement/reply cycles, and recovery after Kimi Work respawned the stopped role MCP. Surviving-peer election is covered by a real loopback/SQLite integration test; it was not observed as a live-host ownership transfer. Host-enforced per-chat MCP isolation remains unverified. Controlled tests are not live-client evidence.

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

Use `synloq init --synloq-home <path>` to relocate both trees for generated channels. The same absolute path is persisted in each generated MCP configuration and passed explicitly to the relay supervisor; it does not depend on mutable process environment. Legacy commands can use `SYNLOQ_HOME`. The project key is derived from the canonical project root. Keep MCP/adapter JSON, plaintext token files, logs, and manual evidence outside the repository as well. Runtime logs and evidence indexes should identify participants and message IDs only; do not commit credentials or message bodies.

## Security notes and known limitations

All relay traffic stays on explicit loopback HTTP origins, and every authenticated endpoint requires a per-role bearer credential. Before a role channel sends its credential, it verifies the relay's unauthenticated `GET /v1/health` marker: an unrelated process that merely occupies the relay port never receives a token.

**Residual risk R1 (accepted):** the health marker is static and public. A targeted squatting process that mimics the `/v1/health` response can still capture a role token during a probe or reconnect cycle and then impersonate that role on the real relay. On multi-user machines, treat the relay port as untrusted and keep role token files as machine-local secrets. For a single-user machine this residual risk is below the significance threshold. Mutual relay authentication via a per-project challenge is tracked as the follow-up hardening in `docs/backlog.md`.

Operational notes:

- Role tokens are stored as plaintext files under the Synloq home; protect them like any other local credential and never commit them.
- Database migrations are forward-only: once a newer release migrates the project database, older binaries refuse to open it.
- The participant registry is loaded when the relay starts; changing role membership in `synloq.yaml` takes effect only after a relay restart.

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
