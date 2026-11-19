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
are allowed; every other registered Synloq tool, including send/reply/list/wait
and note_read/note_write, is explicitly denied for this process. The deny list
is derived from the shared MCP name catalog minus inbox/ack; an SDK tools/list
regression rejects surface drift outside that catalog. No
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
The 60-second deadline includes shutdown after a final answer: a structured
success followed by a process timeout remains `uncertain`, even when the marker
and ACK already exist. The re-init negative-permission probe observed this
boundary; a final answer alone does not override the process-exit requirement.

## Durable checks and retry

Success requires all of:

1. Pinned CLI structured success with no permission denials.
2. Exact new assistant `NUDGE-ACK-<uuid>` marker in the same persisted transcript,
   following the pre-run ancestry checkpoint without a fork.
3. Correlated successful inbox results containing each target, then ACK use/result
   for each of those targets, before the marker.
4. Independent authenticated relay SQLite state says all captured targets are acknowledged.

The ancestry anchor is the last conversational (user/assistant) UUID, not the
last arbitrary JSONL record. A checkpoint also retains same-session parent links
for trailing `attachment` and `system/stop_hook_summary` graph nodes. Verification
projects each conversational parent through those known service links to the
preceding conversational anchor. Service nodes cannot supply tools, results or
markers; side attachments do not advance the conversational chain. Unknown graph
types/subtypes, unresolved or forward parents, cycles, UUID reuse, foreign
sessions and conversational forks fail closed. A service path is capped at 64
nodes, with at most 1024 service nodes across checkpoint ancestry and delta,
inside the existing 4 MiB file/delta limits. Non-graph diagnostic records carry
no parent links and no proof semantics. This whitelist follows the observed
2.1.326 transcript schema and must be revalidated when the pinned CLI changes.

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
automatic attempts in that Claude session. A new session for the role can
process a later eligible event after the role cooldown. A target that stayed
pending after an ambiguous attempt in the old session may be nudged again in
the new one, within the same per-target total and external error limits.
Successful targets retain their terminal status across sessions. There is no
retry on a timer.

## Inspection and recovery

With a read-only SQLite viewer inspect `ownership` (project, agent, session,
active), `attempts` (id, target, marker, started, outcome, proof, transcript path)
and `corrections` (attempt ID, verification time, proof version). These tables
contain identifiers, classifications and local paths. Keep the ledger private.
An original `proof=1` or a correction represents durable proof.

To re-verify an `uncertain` attempt, stop the relay and close Claude processes.
You can leave the nudger disabled while retaining its binding. Run:

```sh
synloq claude-reverify --project-root <path> --attempt-id <uuid>
```

Use `--synloq-home` if the relay used a custom home. The command takes the relay
and transcript ownership locks for verification. It checks the unique original
nudge turn in the bound transcript against durable relay ACKs for all captured
messages. The same transcript and ancestry limits as live verification apply.
A new correction returns `verified` and counts as effective success.
`already-verified` returns the existing result. `unproven` leaves the attempt
quarantined, and `not-uncertain` means there is no eligible attempt in this
project. Output contains only the attempt ID and status on a completed check.

Re-verify before changing the role binding. Recovery of a session requires
its original trusted binding and transcript. If the binding is lost, that
attempt stays uncertain even though the role can use a new session. Replay
confirms persisted tool and ACK evidence. Live verification checks the
full delivery path in a separate run. For a stale transcript ownership lock,
stop the relay and verify there is no Claude owner before inspecting it.
Restarting alone does not clear attempts.

## Validation and rollout

Hermetic tests cover a second process contending for the lock, crash reservation,
external cooldown/retry cap, denied-at-exit-zero, missing SQLite ACK, wrong
session/fork/tool-result correlation, unpersisted/truncated transcript, bounded
process timeout/output, wrong role configuration and post-commit dedup events.
Recovery coverage includes a session change after an ambiguous attempt, racing
ledger migration, repeated correction, active relay exclusion and a historical
turn whose transcript contains all ACK results but whose relay database does
not yet confirm them all.
No paid inference is used by those tests.

Live acceptance must verify seed → inbox/ACK tool results → marker → independent
SQLite, plus denied-tool failure followed by an explicitly corrected run. Perform
it only in the coordinated auth-v2 re-init window. The saved pre-auth-v2 Claude
stand and its historical W7A startup FAIL are not changed by this implementation.
