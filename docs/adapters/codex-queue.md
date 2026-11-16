# Codex CLI queue nudger

The queue wrapper recognizes only `codex-cli 0.169.0` and
`codex-cli 0.169.0-alpha.11.1`. It checks the configured exact version before each
send and invokes `codex queue --thread <UUID> --message <reminder>` without a shell
or `--resume`. Session names are not targets. The maximum claim is **queue
accepted**: exit 0, a recognized UUID queue ID, and an exact target UUID echo in
`Queued message <queueId> for thread <UUID>.` Unexpected output, a mismatch,
timeout or interrupted process is uncertain; never blindly repeat that operation.
Output is bounded to 8 KiB and runtime to 10 seconds per process. Raw CLI output
is not logged or persisted. This is an undocumented CLI surface, not a stable
Codex API contract; new versions require reviewed fixtures and probe evidence.

Acceptance does not prove persistence independently, delivery, turn start or
completion. A nudge does not guarantee turn start, especially for unloaded chats.
There is no Desktop lifecycle observer, app-server, daemon, database inspection
or resume fallback. Real Synloq inbox/ack and a subsequent RESULT remain the
delivery/read and execution evidence. The CLI-only scope was approved in #83;
the separate Desktop observability gap remains open.

Probe evidence: [#83 CLI-only matrix](https://github.com/OBenner/synloq/issues/83#issuecomment-6917088249).
Loaded-idle and busy behavior was visually confirmed in that window; it is not
observable by this wrapper. The unloaded microprobe returned queue acceptance
without an observed new turn. No probe identifiers or task text belong in config
examples or committed fixtures.

## Opt-in configuration and ownership

The service belongs to the relay (`synloq serve`, including supervisor-started
relays), not to a per-role MCP child. It is off when the local configuration file
is absent. Under the same `SYNLOQ_HOME` as the relay, create
`state/<projectKey>.codex-queue.json`. The project key is the existing relay
database filename without `.sqlite` in `data/`; do not invent a second home or
key for the watcher. Substitute an absolute path to the tested Codex executable
and the **exact Desktop chat UUID** in this template:

```json
{
  "version": 1,
  "enabled": true,
  "executable": "<absolute-path-to-codex-executable>",
  "cliVersion": "0.169.0",
  "bindings": [
    {
      "agentId": "staff1",
      "threadId": "11111111-1111-4111-8111-111111111111"
    }
  ]
}
```

The UUID above is synthetic. A Synloq message/thread ID is **not** a Desktop chat
UUID. The operator selects the role's correct visible chat; CLI has no read-only
target preflight. Echo matching catches a response for a different UUID, not a
mistakenly configured but valid chat. Duplicate roles or chat targets, session
names, extra keys, unknown versions and relative executable paths are rejected.
Config is read at relay startup; restart the owning relay after a change. Remove
the opt-in file and restart to disable. Invalid config/ledger/placement disables
the nudger with a diagnostic; inbox service stays available.

Only manifest members with a local `codex-desktop` placement and no push
conversation or active-delivery registration are eligible. This is rechecked
before each enqueue. Kimi Work/OpenCode keep their existing #45 MCP-child nudge;
they cannot opt into this watcher. No SessionStore binding, writer proof,
generation, claim, protocol v1 or host capability is changed. The local UUID map
is only a notification destination, not authority to act as the role.

## Delegation model

The nudger implements delegation-by-binding, not instruction delegation. The
binding from role to its exact visible Desktop chat is established by the
operator at provisioning and revocable only through explicit operator actions
(token rotation/revoke, `remove-role`, fail-closed host move); it is revalidated
before every enqueue rather than inferred from a remembered UUID.

Authority to act never travels in the nudge. The reminder is identifier-only — a
fixed inbox instruction plus Synloq message/thread IDs — so a delivered nudge can
make the role *read* at most: the woken role must read its authenticated Synloq
inbox, where the relay enforces per-recipient authorization. A correctly built
watcher is therefore close to a scoped observation grant plus an explicit owner
binding, not to external instruction execution.

Known residual gaps, upstream-tracked in
[openai/codex#61773](https://github.com/openai/codex/issues/61773):

1. A nudge already sitting in the Desktop queue starts a turn even after the
   operator revokes the role; it then fails loudly at the authenticated inbox
   read, but a turn is spent. The systemic fix is host-side delegation
   revalidation at dispatch time, not client memory.
2. A queued reminder renders in the Desktop transcript as plain user text with
   no machine-origin marker; today the fixed content-free reminder text is the
   mitigation. The proper fix is a host-side origin label on externally-queued
   turns.

This maps to the four-part wake contract discussed in that issue (event origin,
thread-owner delegation, single turn-admission decision, distinct observations):
origin and single-admission are covered by the relay envelope and the durable
ledger below; observations remain the separate open gap.

## Durable bounds and diagnostics

- Scan every 15 seconds, with one async sweep in flight. Read only ID/state
  metadata of each role's oldest unacknowledged message. A submitted, paused or
  quarantined head blocks nudging later mail; all pause scopes are respected.
  A delivered message is still eligible until the role actually acknowledges it.
- Reserve before any CLI call in `data/<projectKey>.codex-nudges.sqlite` using
  a SQLite transaction (WAL, FULL synchronous). All relay instances using that
  project/home share one durable owner per role. The role cooldown is at least
  **30 minutes**, including across head changes, bindings and restarts.
- Each message gets at most **five reserved iterations** for its lifetime;
  preflight/cancellation also conservatively consume a slot. A different target
  UUID does not reset this counter. After the fifth without a real ack, log
  `undelivered after 5 nudges` once and stop. This means the ack is absent, not
  that the watcher observed delivery failure or a dead Desktop. Later mail does
  not bypass that head to keep nudging a dead chat indefinitely.
- Accepted enqueues may repeat only within that budget and cooldown. A timeout,
  ambiguous output/echo, rejection or version failure blocks automatic retries.
  A process crash leaves a durable `reserved` owner: it is never stolen by a
  timeout or relay restart. Diagnostics show `blocked=<state>` and request
  operator review. No CLI idempotency key exists, so losing a response cannot
  safely be retried. Shutdown aborts and reaps the owned child before closing
  storage.
- The reminder contains only a fixed inbox instruction and Synloq message/thread
  IDs. Logs/journal store IDs, attempt counts, state and fixed reason codes, never
  task text, tokens or raw CLI output. The journal is local operational metadata
  retained across message retention sweeps; do not delete it to retry.
- Nudging never marks a Synloq message submitted, delivered or acked. Existing
  relay/MCP semantics remain authoritative: inbox reading alone does not mutate
  delivery state; `synloq_ack` records the actual read acknowledgement. A RESULT
  in the original thread, with checks and limitations, proves task execution.
