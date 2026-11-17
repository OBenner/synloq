# Claude persisted-session nudger (#126)

Status: implementation of the architecture-approved cooperative N1 contract.
Live acceptance remains pending the coordinated auth-v2 re-init window.

## Ownership and product boundary

This optional relay-owned service resumes an **existing persisted Claude Code
conversation**. It does not create replacement conversations or run a daemon.
The operator sees the nudge turn when opening the chat; there is no live progress
feed. Participant reach remains `next-interaction`.

Opt-in explicitly hands the named session to the nudger. The role must have a
known `closed` registration with that exact session ID and no active-delivery
capability. Unknown/busy/idle, missing persistence, an unrecognized CLI version,
or an inconclusive process scan causes a skip; mail stays available in the inbox.
The conservative process scan skips if **any** Claude process is found, even for
another session. This intentionally favors safety over simultaneous throughput.

An exclusive-create lock beside the canonical transcript is held for the whole
handoff. Another nudger or a cooperating launcher using
`acquireClaudeOwnership(transcript, sessionId, "manual")` cannot enter until it is
released. A cooperating launcher must keep that handle until its child exits.
There is no age/PID-based stale lock stealing. This module is the shared launcher
contract; this change does not add a standalone interactive launcher command.

**Raw concurrent `claude --resume` is unsupported.** The process scan has a
TOCTOU gap and is not host-enforced exclusion. An unwrapped manual launch during
a nudge can fork transcript ancestry (observed in Probe C), degrading turn
visibility. It cannot manufacture an authenticated SQLite acknowledgement.

## Local operator configuration

Disabled by default. The optional file is
`<synloq-home>/state/<project-key>.claude-nudges.json`, outside the repository.
Use existing generated MCP/adapter/hook files, not hand-written credentials.
All paths must be absolute. This example is documentation, not an activation:

```json
{
  "version": 1,
  "enabled": true,
  "executable": "/absolute/path/to/claude",
  "cliVersion": "2.1.326",
  "bindings": [
    {
      "agentId": "arch",
      "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cwd": "/absolute/path/to/role-arch",
      "transcript": "/absolute/path/to/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
      "mcpConfig": "/absolute/path/to/role-arch/.mcp.json",
      "settings": "/absolute/path/to/role-arch/live-settings.json",
      "adapterConfig": "/absolute/path/to/role-arch/adapter.json"
    }
  ]
}
```

First complete a harmless exchange in the visible session so its transcript is
persisted, then exit that session and confirm its relay state is closed. Configure
the opt-in and restart the relay. Supervisor-started relays use the same lifecycle.
The version pin is checked before every attempt; an upgrade needs reviewed probe
evidence before the allowlist is extended. Existing relay process environment,
including `NODE_EXTRA_CA_CERTS` if needed, is inherited; TLS verification and
credentials are not changed by this feature.

To return to manual use, set `enabled: false` or remove the opt-in and stop/restart
the relay. A filesystem change notification also disables the service and aborts
an owned child before releasing the lock; always confirm the lock is gone before
opening the visible session. Enabling or changing a binding requires a restart.
No inference is triggered by startup, configuration edits, or shutdown.

## Trigger and execution

Only committed new send/reply messages produce hints. Dedup replay does not.
There is no polling, startup backfill, or continuous retry. The pending hint set
is bounded by the configured roles (maximum 100), with one child at a time.
Each attempt captures a bounded snapshot of unacknowledged IDs (maximum 100).
The existing FIFO/pause/quarantine guard is reused without reading message bodies;
any blocked item or a larger backlog skips the automatic attempt. The prompt
requires paginated inbox reading, then ACK of every unacknowledged message.
Durable proof must cover every ID in the captured snapshot. New arrivals after
the snapshot do not retroactively expand the proof obligation.

The prompt starts `Synloq nudge: N pending message(s), messageId ...` and contains
only validated identifiers, a unique marker, and fixed instructions. No message
body is copied into argv. Built-in tools are disabled; strict MCP configuration
contains exactly the assigned role channel. Only that channel's inbox and ack
are allowed; send/reply/list/wait are explicitly denied for this process. No
permission bypass or persistent permission change is made. The variadic
`--allowedTools` option is terminated with `--` before the prompt.

The owned inference child has a 60-second deadline. Version check and process
scan have separate five-second limits. Combined stdout/stderr and transcript
reads are capped at 4 MiB; oversize transcripts fail closed and require operator
review. Raw output exists only in bounded memory, never in the nudger ledger or
diagnostics. Timeout/overflow/shutdown kills only the owned child and waits for
its exit before releasing ownership. If the OS does not confirm exit, ownership
must remain held; there is no unsafe forced unlock. Inherited MCP descendants
are not treated as proof of successful completion.

## Durable checks and retry

Success requires all of:

1. Pinned CLI structured success with no permission denials.
2. Exact new assistant `NUDGE-ACK-<uuid>` marker in the same persisted transcript,
   following the pre-run ancestry checkpoint without a fork.
3. Correlated successful inbox results containing each target, then ACK use/result
   for each of those targets, before the marker.
4. Independent authenticated relay SQLite state says all captured targets are acknowledged.

Exit zero, idle, a marker in the user prompt, an old transcript entry, or an ACK
claim in model prose is insufficient. SQLite stores message state, **not an
inbox invocation audit**; the host transcript supplies the tool-result evidence.

Attempts and explicit session ownership are recorded in the separate
`<synloq-home>/data/<project-key>.claude-nudges.sqlite`. The ledger imports the
shared 30-minute cooldown and maximum-five-attempt constants. It reserves before
execution. Cooldown is per role, including when the oldest target changes.
There is at most one retry of a structured external 402/connection failure for a
target, counted within the total attempt budget, after cooldown on a **new event**.
Free-form error text is not classified as safely retryable. A partial/ambiguous
outcome, timeout, tool denial, or interrupted/reserved attempt blocks further
automatic attempts for the role. There is no retry on a timer.

## Inspection and recovery

With a read-only SQLite viewer inspect `ownership` (project, agent, session,
active) and `attempts` (id, target, marker, started, outcome, proof). These tables
contain identifiers and bounded classifications only, never message bodies,
transcripts, stderr, credentials or provider output. `proof=1` records all checks
passing; it is not a claim that a visible UI refreshed live.

For a stale lock or blocked attempt: disable the opt-in, stop the relay, verify
there is no Claude child left, and inspect the actual persisted conversation and
relay ACK state. Only after resolving any uncertain work should the operator
archive the local ledger and remove the stale ownership lock. That is an explicit
recovery, not an automatic retry or permission bypass. Do not delete a live lock
or publish the private evidence. Restarting alone does not clear attempts.

## Validation and rollout

Hermetic tests cover a second process contending for the lock, crash reservation,
external cooldown/retry cap, denied-at-exit-zero, missing SQLite ACK, wrong
session/fork/tool-result correlation, unpersisted/truncated transcript, bounded
process timeout/output, wrong role configuration and post-commit dedup events.
No paid inference is used by those tests.

Live acceptance must verify seed → inbox/ACK tool results → marker → independent
SQLite, plus denied-tool failure followed by an explicitly corrected run. Perform
it only in the coordinated auth-v2 re-init window. The saved pre-auth-v2 Claude
stand and its historical W7A startup FAIL are not changed by this implementation.
