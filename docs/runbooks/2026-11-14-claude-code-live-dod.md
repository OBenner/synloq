# Live runbook: Claude Code inbox and lifecycle verification

Updated 2026-11-17 for TASK fdb77ccf. Coordinator/auditor: staff1. Executor:
operator-led visible Claude Code sessions, roles `cto` and `arch`.

This runbook implements the inbox/lifecycle subset of
`test/e2e/real-clients.md`. The previous channel-activation procedure is outside
this window. Do not set `acceptanceMessageId` or `activationVerifiedAt`; do not
load development channels. Autonomous wake and notification admission are
non-goals. The verdict ceiling is **MCP inbox / lifecycle / next-interaction**,
with a separate result for each capability.

## Stand and evidence boundaries

Use a dedicated project root, isolated `SYNLOQ_HOME`, two per-role working
folders and a fresh loopback port. Never reuse the team's live relay or home.
Use a fixed, recorded main commit throughout the window; do not mix unpublished
auth-v2 clients with the current relay. No package upgrades during the run.

The stand has:

- `project/synloq.yaml`: only `cto` and `arch`.
- `synloq-home/`: isolated credentials, database, runtime and audit files.
- `role-cto/` and `role-arch/`: one role-specific `.mcp.json` each, an adapter
  config with a credential **path**, and explicit `live-settings.json`.
- `evidence/`: local-only tool outputs, observed session IDs, hook metadata,
  read-only SQLite snapshots, timestamps and operator observations.

Never display token values, claim codes or raw credential stores. Init results
must be filtered before recording: retain role and config/credential paths,
not claim codes. Public acceptance documents contain only sanitized evidence
indexes, commit/version, probe IDs and verdicts. Logs, SQLite, host transcripts
and message bodies stay outside tracked files.

Use visible interactive sessions only. No `claude -p`, hidden model processes,
permission bypass or automatic approvals. The coordinator uses only its assigned
team channel; the operator's two stand sessions own their stand MCP tools.

## W7A — preflight and exact binding (window 1, 30–45 minutes)

1. Record the Synloq commit, Node and installed Claude Code version, successful
   build, actual relay URL and health. Health is availability, not acceptance.
2. Confirm a read-only SQLite baseline: zero messages and sessions, no quarantine.
3. Discover each **actual** visible session ID via a host `SessionStart` hook
   or the client's own session display. Do not invent IDs. The stand helper's
   capture hook stores only time, role, session ID and event; it does not register
   a role or submit any model prompt.
4. Complete a harmless visible exchange before closing the capture session:
   SessionStart alone may not persist a resumable conversation. Close it and
   bind its observed ID to that role's adapter config.
   Configure exactly one `synloq-<role>` server in its `.mcp.json`, invoking
   `node <checkout>/dist/cli/main.js adapter --config <role>/adapter.json`.
   The MCP child and hooks must inherit the isolated `SYNLOQ_HOME`.
5. Resume the **same** session with `--resume <observed-id> --mcp-config .mcp.json
--strict-mcp-config --settings ./live-settings.json`. This avoids hot-loading
   live hooks into capture-only sessions. Review ordinary trust prompts. Inspect `/mcp`
   and `/hooks`; record what is actually loaded. A config file alone proves
   neither pickup nor host-enforced isolation.
6. Verify six Synloq tools: list/send/reply/inbox/wait/ack; no registration or
   permission-granting tool. Record `synloq_list` from each role. Check matching
   session/role/generation in relay SQLite and `doctor`.

Lifecycle hooks invoke the public `claude-hook` command for `SessionStart`,
`UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, and `PreToolUse`.
The wrapper must preserve stdin and empty stdout, record event metadata plus
exit status, and take a read-only relay snapshot. Never save the hook prompt or
last assistant message. Hook stdout must not inject context or approval.

Record provider prerequisites without secrets. On machines with approved TLS
inspection, use `NODE_EXTRA_CA_CERTS` with the locally verified public CA; never
disable TLS verification or recommend a machine's CA universally. Verify the
provider key supports inference (a management key may not). Secret changes need
direct operator approval. Record host versions per phase if the host changes
mid-window; do not imply a single-version run.

An initial SessionStart can run before the MCP child registers. Record any
failure as observed; do not count an unobserved startup transition as PASS.
After MCP is connected, an operator-triggered reconnect/resume may supply a
fresh comparable event. Keep the first failure in the evidence.

## W7B — inbox, acknowledgement, provenance and dedup (window 1)

Use synthetic content only, with a fresh run marker (for example W7-20261117-A).
The operator asks each visible role to execute its own tools; no copying message
bodies between chats and no auditor impersonation of a stand role.

1. In `cto`, send `QUESTION W7-20261117-A review` to `arch`, expectsReply true,
   key `w7-20261117-a-question`. Save tool output and generated UUID/thread ID.
2. Repeat the identical send: same UUID/thread, one database message. Reuse that
   key with different text: expect `IDEMPOTENCY_CONFLICT`, no new message.
3. In `cto`, try ack on that outgoing message: expect `UNAUTHORIZED`; capture
   the error and matching deny audit. Do not delete the failed observation.
4. On the next operator interaction in `arch`, call inbox, read the question,
   then ack. Reply `RESULT W7-20261117-A received` with inReplyTo equal to the
   question UUID, expectsReply false, fresh reply key.
5. On the next interaction in `cto`, read and ack the reply. Check project,
   sender/recipient, original thread, inReplyTo, IDs and final acked state in
   both tool output and SQLite. Replay an ack: no duplicate message/effect.
6. Exercise bounded wait with no pending message; timeout is normal. Save actual
   tool schema/arguments rather than assuming a timeout parameter exists.

An inbox read is not a channel notification. Record actual state changes; never
manufacture a `submitted` or `delivered` receipt to satisfy an old matrix row.

## W7C — lifecycle, busy/idle and next interaction (window 2, 30–45 minutes)

1. Record SessionStart and Stop event metadata with relay state. Current mapping:
   SessionStart/Stop/StopFailure → idle, UserPromptSubmit → busy, SessionEnd →
   closed, PreToolUse/other events → unknown. Fresh timestamps and generations
   matter; do not infer state from a sleep or from the UI spinner alone.
2. Ask `arch` for a visible response and send a second synthetic probe from `cto`
   while the response is active. Require a matching busy event/snapshot; if the
   timing misses it, mark the row UNVERIFIED and do at most one explicit repeat.
3. Confirm the message stays available without injection while busy. After Stop,
   confirm fresh idle, active_delivery=0 and no automatic wake claim.
4. On a subsequent operator interaction in `arch`, explicitly request inbox,
   read/ack/reply. Check exactly one stored question and correlated reply.
5. Record an ordinary permission prompt and its host-controlled result. Synloq
   must not grant permissions. Synthetic message text cannot change tool lists,
   capabilities or policy. Do not request dangerous commands to provoke a prompt.

## W7D — reconnect, restart and shutdown (window 2 or 3)

1. Capture before-state IDs/generations and a pending synthetic message. Close
   and resume the same role session with the same per-role config; record host
   events, registration generation and message history after reconnect.
2. The coordinator verifies the stand relay PID and command line before stopping
   **only that process**. Restart the same checkout/project/home and original
   port, without deleting SQLite or changing credentials. Never kill by port alone.
3. Reconnect both visible clients. Reissue a prior idempotent send and verify the
   original UUID. Read/ack the pending message; verify no loss or duplicates.
4. Close both sessions. Observe SessionEnd/closed or record the actual failure.
   Stop the isolated relay after the auditor confirms the final snapshot.

## Audit and acceptance

For each row, correlate visible tool output + hook metadata + read-only SQLite
snapshot + security audit where applicable. Each snapshot selects metadata only:
message IDs, sender/recipient, thread/inReplyTo, delivery state, dedup key,
session state/generation/capabilities, quarantine. Do not copy message text or
credential material into public evidence. Preserve failures and retries.

Record PASS/FAIL/UNVERIFIED per row. `docs/testing/` holds the sanitized acceptance
index; capability-specific matrix/compatibility claims change only after complete
observed evidence. Startup health, builds, mocked clients, or self-reported
success cannot upgrade the live verdict. Autonomous wake stays out of scope.

On unexpected errors: stop the affected probe, preserve safe diagnostic metadata,
report BLOCKED with a reason code; no improvised fixes or more than one retry.
If peer verdicts on #1/#104 arrive, pause at a recorded checkpoint to handle them.

## Host references

- [Claude Code MCP](https://code.claude.com/docs/en/mcp): project `.mcp.json`,
  explicit MCP config and visible trust review.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): event input includes
  session ID; project hooks live in `.claude/settings.json`.

References checked 2026-11-17. Installed CLI help/version and live observations
remain the evidence for this particular build; newer documentation is not a
claim that every feature exists in the installed client.
