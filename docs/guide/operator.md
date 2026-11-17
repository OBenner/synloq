# Operator guide

Session ownership, delivery control, credentials, diagnostics, and where
runtime state lives. For installation and initialization see
[installation.md](installation.md).

## Session ownership and replacement

A role has one visible session binding. Re-registering the same session
supports reconnect; binding a different session requires explicit operator
replacement:

```bash
synloq replace-session \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --agent-id arch \
  --session-id replacement-visible-session \
  --protocol-version 1 \
  --active-delivery true \
  --state-reporting true \
  --client-idempotency true
```

Use capabilities observed from the replacement adapter, never values inferred
from a client version. Update the standalone adapter config to the same session
before restarting it.

## The single-writer rule

A role has a single writer: the chat that owns the registered session. Other
chats holding the same role's token can read (`synloq_inbox`, `synloq_list`,
`synloq_wait`) but their writes (`synloq_send`, `synloq_reply`, `synloq_ack`)
are rejected with `NOT_WRITER` naming the active writer session — takeover goes
through `synloq replace-session` only, and every refusal lands in the audit
log. Channel tooling injects the writer proof automatically from the role's
MCP config (`kimiWork.conversationKey`, `opencode.sessionId`, or an explicit
top-level `sessionId` for hook-style hosts); agents never set it by hand.
Roles without any registered session keep token-only writes — the guarantee
starts with the first registration.

## Pause and resume

Pause or resume delivery with the operator credential:

```bash
synloq pause \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --scope participant --scope-id arch

synloq resume \
  --relay-url http://127.0.0.1:4100 \
  --credential /secure/operator.token \
  --scope participant --scope-id arch
```

Scopes are `project`, `participant`, and `thread`; named scopes require
`--scope-id`. Pause gates are durable and do not delete messages.

## Credential rotation and revocation

Rotate or revoke a role credential with the operator token file. Rotation
replaces every stored hash of the role and rewrites its token file, so
previously issued tokens stop working immediately; revocation removes the
hashes without issuing a new token. MCP channels re-read token files for each request; static-token adapters require a
restart after rotation. Restart a channel if authentication failures persist. Command output never
contains the token itself. See
[security/token-rotation.md](../security/token-rotation.md) for the incident
runbook.

```bash
synloq rotate-token \
  --project-root /absolute/path/to/project \
  --agent-id arch \
  --credential /secure/operator.token

synloq revoke-token \
  --project-root /absolute/path/to/project \
  --agent-id arch \
  --credential /secure/operator.token
```

## Diagnostics

Inspect local storage and registered sessions:

```bash
synloq doctor --project-root /absolute/path/to/project
synloq doctor --help
```

For a human-readable per-role queue view — state, queued count, and why a role
is waiting (`busy`, stale session, awaiting ack, operator pause) — run:

```bash
synloq status --project-root /absolute/path/to/project
synloq status --project-root . --json   # machine-readable for scripting
```

`synloq status` reads the same local storage as `doctor`, never talks to the
relay, and always exits 0: failures are reported as rows, not exit codes. It
also surfaces acked messages that expected a reply but stayed unanswered for
over 30 minutes. Delivered prompts carry a `+N more pending` hint when the
recipient's backlog is non-empty.

## Nudges and wake-up

Stored-mail nudge: when a role has stored messages older than 15 minutes while
its chat is live and idle on a push-capable host (`kimi-work`, `opencode`),
the role's channel posts a content-free nudge into the chat ("N incoming
message(s) waiting — run synloq_inbox") — at most once per backlog epoch,
repeated every 30 minutes while the backlog stays unread. Busy, dead, or paused
chats are never nudged, and the nudge never contains message text. Opt out per
role with `"storedPing": false` in the role's channel config. On hosts without
push, `synloq status` instead marks queued roles with a
`no push on host <host> — check synloq_inbox manually` note.

Codex Desktop has a separate, **opt-in CLI queue nudger** owned by the relay:
[configuration and bounds](../adapters/codex-queue.md),
[acceptance runbook](../runbooks/codex-queue-nudger.md). It queues only
reminder IDs, at most five iterations per message with a durable 30-minute
role cooldown. `queue accepted` does not prove delivery or turn start;
unloaded chats may remain inactive. Actual MCP read/ack and thread RESULT
remain authoritative. This does not enable the Codex active-delivery adapter or
replace its inbox-only status.

Claude Desktop has no autonomous wake surface (upstream request tracked at
anthropics/claude-code#110364); it supports inbox reads and next-interaction
reminders only. See the [host matrix](../../README.md#how-each-host-connects).

## Diagnostics output and audit

Every line that long-lived processes (the MCP stdio bridge and the relay
supervisor loop) write to stderr is prefixed with an ISO 8601 UTC timestamp, so
an incident timeline can be reconstructed from logs alone. Deny decisions are
additionally recorded in the security audit log at
`~/.synloq/data/<project-key>-audit.jsonl` (one JSON object per line with `at`,
`agentId`, `action`, `reasonCode`). Claim events are recorded the same way —
both accepted claims and refusals (an expired claim code is operational noise
and is not recorded). Session registrations are recorded too — accepted and
refused (duplicate or protocol-mismatched) — with the session id, generation,
and the client-reported `surface`, which is a hint, not proof of the client
binary, so "who bound this role, when, and from where" is answerable from the
log; heartbeat lease renewals are not recorded. Long-poll rejections from the
concurrency caps (per-identity and relay-wide) are recorded with the route
that hit the cap, so a connection-exhaustion attempt is visible in the log.
Neither stream ever contains tokens or message bodies.

`unknown`, stale, busy, closed, unsupported, paused, or mismatched sessions
fail closed. Message text cannot grant tools, permissions, registration, or
capabilities.

## Runtime paths and external state

By default Synloq stores per-project state under:

```text
~/.synloq/credentials/<project-key>.json
~/.synloq/data/<project-key>.sqlite
```

Use `synloq init --synloq-home <path>` to relocate both trees for generated
channels. The same absolute path is passed explicitly to the relay supervisor;
it does not depend on mutable process environment. Inside generated MCP
configurations the Synloq home and the credential path are stored relative to
the config file, so moving the whole Synloq home tree keeps the channels valid.
Only `kimiWork.projectRoot` stays absolute by nature — `synloq doctor` flags
the exact config whose project root or credential file no longer resolves.
Auth-v2 configs may still use absolute paths; older configs missing trusted
project/agentId must be regenerated; `synloq doctor --repair` rewrites them to the relative form. Legacy
commands can use `SYNLOQ_HOME`. The project key is derived from the canonical
project root. Keep MCP/adapter JSON, plaintext token files, logs, and manual
evidence outside the repository as well. Runtime logs and evidence indexes
should identify participants and message IDs only; do not commit credentials or
message bodies.

## Other hosts

Active-delivery adapters for OpenCode, Claude Code/Desktop, Codex CLI/Desktop
and the ZCode status are documented per host in
[docs/adapters/](../adapters/README.md). Do not rely on an experimental host
path until its row of the live evidence matrix in `test/e2e/real-clients.md`
has been executed.

## HTTP authentication and trusted context

Manual relay commands (`list`, `inbox`, `send`, `pause`, `resume`,
`replace-session`) resolve project and role from the local manifest and credential
store. Set `--project-root` (cwd by default) and `--synloq-home` to the intended
stand. No credential is sent over relay HTTP; auth-v2 verifies challenge, request
and response MACs. See [rollout and limits](../security/transport-auth-v2.md).
