# OpenCode manual stand: live evidence, gaps, and required work

Date: 2026-11-13. Reviewer: operator-driven live stand (OpenCode desktop 2.2.7, Windows,
Node.js 24.13, synloq 0.0.2 at c523753).

Status: **live evidence for the manual path only.** This note does NOT change the OpenCode
adapter support status: the sidecar adapter remains UNVERIFIED until
`test/e2e/real-clients.md` is executed. What was verified live is (a) the six agent-facing
MCP tools over stdio from OpenCode and (b) the OpenCode server API primitives the adapter
is designed to use.

## Verified live

On a fresh project (`open-code-synloq`, roles `cto` + `arch`, relay on a dedicated loopback
port, manual legacy MCP configs), without any Kimi Work component:

1. Manual bootstrap works end to end: hand-written `synloq.yaml`, credentials issued via
   `CredentialStore.ensureCredential` from the built `dist`, per-role legacy MCP configs
   `{relayUrl, credentialPath}`, `synloq serve`, and a project `opencode.json` with one
   local stdio MCP server per role.
2. Full message cycle through the real OpenCode MCP integration:
   `list → send → inbox → ack → reply → inbox`, correct shared `threadId`,
   `deliveryState` transitions `stored → acked`. `synloq doctor` reports healthy storage
   and both participants.
3. OpenCode hot-reloads `opencode.json`: both MCP servers connected without an IDE restart.
4. Visible chat creation via the OpenCode server API (same background service the desktop
   app uses): `POST /api/session` with `{title, location: {directory}}` creates sessions
   that appear in the desktop UI; `POST /api/session/{id}/prompt` with `{text}` starts a
   visible agent turn. Sessions created this way used their role MCP tools autonomously
   (observed relay-side as an `acked` transition initiated by the created session).
5. Manual active delivery: posting a wake-up prompt with `delivery: "queue"` to the idle
   recipient session made its agent poll `synloq_inbox` and `synloq_ack` the pending
   message. This is the exact primitive (`delivery: "queue"`, `resume: false`) the
   experimental OpenCode adapter is built on — confirmed working against a live client.

No credentials, tokens, or message bodies are included in this note.

## Gaps found (OpenCode host)

- **G1. No generic OpenCode init.** `synloq init` is hard-bound to the Kimi Work host
  (visible conversation creation, plugin rendering). An OpenCode stand requires a fully
  manual bootstrap (manifest, credentials, MCP configs, relay, `opencode.json`).
- **G2. No relay auto-start for OpenCode channels.** The MCP stdio config schema is strict:
  `synloqHome` without a `kimiWork` binding is rejected, and relay supervision/election is
  enabled only for generated Kimi configs. OpenCode roles need a separately started
  `synloq serve`.
- **G3. MCP config is project-wide, not per-chat.** Every OpenCode session in the project
  sees every role's tool set (`synloq_cto_*`, `synloq_arch_*`); role separation is prompt
  discipline only. Mitigation found live: `POST /api/session` accepts a
  `permissions` ruleset (`[{action, resource, effect}]`, action supports wildcards), so a
  role chat can be created with the other roles' tools denied at the host level.
- **G4. No active delivery while the adapter is UNVERIFIED.** Messages wait in SQLite;
  an idle recipient chat does not notice until its agent polls. Manual wake-up push
  (Verified #5) is a viable interim pattern.
- **G5. One relay = one project = one port.** A second project on the same machine needs a
  second port (default 4100 was occupied by the existing Kimi stand).
- **G6. Host discovery is unstable-shaped.** The desktop-bundled CLI lives under a
  versioned path (`%APPDATA%\ai.opencode.desktop\cli\<version>-x64\opencode-cli.exe` on
  Windows) and the service port is dynamic (`opencode api get /api/info` → `urls[0]`).
- **G7. First MCP tool use in a newly created session may require interactive approval**
  in the UI.

## Required work (proposal)

Mapped to existing code areas; priorities follow `docs/backlog.md` conventions.

- **W1 (P1) — Generic OpenCode init host** (`src/init/`, alongside `kimi-work-host.ts`):
  reuse `initializeTeam` minus Kimi branches; write legacy MCP configs; merge
  `mcp.servers.synloq-<role>` into the project `opencode.json` non-destructively; create
  one visible session per role via `POST /api/session` with a per-session permission
  ruleset denying other roles' tools (G3); post the role prompt; persist
  `conversations[role] = {kind: "opencode", sessionId, directory}` in team state;
  idempotent reconcile via `GET /api/session/{id}`; `--conversation` analogue binds an
  existing session id.
- **W2 (P1) — OpenCode host discovery** (`src/host/opencode/`): locate the bundled CLI
  (versioned directory, pick newest) or PATH `opencode`; resolve the service base URL via
  `opencode api get /api/info`; fail closed with a clear error when no desktop/service is
  running.
- **W3 (P1) — Relay auto-start for OpenCode MCP configs**: extend the strict schema in
  `src/mcp/stdio.ts` with an `opencode` binding (`{projectRoot, agentId, sessionId}` +
  explicit `synloqHome`) and reuse the existing supervisor-loop election, so OpenCode role
  channels get the same automatic relay lifecycle as Kimi channels (G2).
- **W4 (P2) — Role prompt template renderer**: the OpenCode analogue of Kimi
  `clientInstructions` — role, boundaries, protocol rules (poll via `inbox`/`wait`,
  `ack` after reading, `reply` in-thread, idempotency keys), own-tools-only.
- **W5 (P2) — `add-role` / `remove-role` lifecycle**: manifest + credential + MCP config +
  `opencode.json` merge + session create/delete (`DELETE /api/session/{id}`); remind that
  the participant registry loads at relay start.
- **W6 (P2) — `doctor` for OpenCode**: relay health, session liveness via
  `GET /api/session/{id}`, config/registry consistency, port conflicts (G5).
- **W7 (P1) — Execute the OpenCode adapter evidence matrix** (`test/e2e/real-clients.md`):
  the required API primitives are now confirmed live (Verified #4–#5), so the sidecar
  adapter (`docs/adapters/opencode.md`) can be run through the manual matrix to lift the
  UNVERIFIED status (G4).

## Working rules note

Findings recorded per `docs/backlog.md` conventions; backlog rows referencing this note:
OpenCode generic init host, relay auto-start for OpenCode configs, adapter evidence matrix.
