# Claude Code live acceptance — inbox and lifecycle observed

- Status: **PARTIAL — original W7 scoped probes PASS; re-init resume startup
  PASS; #126 automatic proof acceptance BLOCKED**. Original W7 received Lead
  Developer review PASS on 2026-11-17; the separate re-init results below are new.
- Coordinator/auditor: staff1; operator executed two visible role sessions.
- Original W7 runtime stayed `0d972bc8d7b726542ed4cbd8d00094d7190c5a8a` throughout.
  The separately authorized re-init used `2097715157a0a39054585de012f9ca03ffe376f4`.
- Node `v24.13.0`; isolated project `claude-code-live-20261117`, roles cto/arch.
- Scope: inbox, ack, dedup, provenance, lifecycle, busy/idle, next interaction,
  reconnect and relay restart. Autonomous wake was disabled and out of scope.
- Procedure: [live runbook](../runbooks/2026-11-14-claude-code-live-dod.md).

## Evidence and version boundaries

Actual host tool_use/tool_result pairs were correlated with read-only SQLite,
recorded hook events and relay deny audit. Duplicate transcript entries with
one tool-use ID were counted once. Screenshots support, rather than replace,
these checks. Private artifacts remain untracked; no credentials, message bodies
or private paths are included here.

| Phase                                | Claude Code version | Evidence                              |
| ------------------------------------ | ------------------- | ------------------------------------- |
| Preflight / early setup              | 2.1.81              | CLI and early host transcript records |
| Successful W7A list / W7B cycle      | 2.1.326             | Actual per-record version and UI      |
| W7C busy / W7D reconnect and restart | 2.1.326             | Actual per-record tool calls          |

The host version changed mid-window; the auditor did not upgrade it. This is not
whole-window acceptance for either version in isolation. Synloq stayed pinned;
auth-v2 was not introduced. Preparation build and 14 existing adapter/lifecycle
tests passed; they are separate from live-client evidence.

## Capability verdicts

| Probe                                   | Observed evidence                                                                                  | Verdict                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| W7A binding / tools                     | Captured IDs matched registrations; per-role list succeeded; six tools exercised across both roles | PASS for observed wiring      |
| Initial arch SessionStart               | Heartbeat NOT_FOUND before MCP registration                                                        | FAIL                          |
| Re-init SessionStart (#124)             | Actual cto/arch resume hooks exit 0; relay registrations and SQLite idle correlated                | PASS for observed resume      |
| W7B inbox / own ack / cross-role denial | Both sides read/acked; outgoing ack rejected UNAUTHORIZED                                          | PASS                          |
| W7B dedup / provenance                  | Replay retained UUID; changed body rejected IDEMPOTENCY_CONFLICT; reply thread/parent matched      | PASS                          |
| W7B repeated ack / wait                 | Two distinct acks returned acked; waitMs=1000 returned an empty list                               | PASS                          |
| W7C busy / idle                         | Message creation inside busy interval; retained through Stop/idle                                  | PASS                          |
| W7C next interaction                    | Explicit subsequent inbox returned stored question                                                 | PASS                          |
| W7D same-relay reconnect                | Same arch session ID; generation 1 to 2; hooks and list successful                                 | PASS                          |
| W7D relay restart / replay              | Metadata persisted; both sessions generation 3; original UUID/time/thread on replay                | PASS                          |
| W7D final exchange                      | Question and correlated reply acked; four total messages, all acked                                | PASS                          |
| SessionEnd / closed                     | Both sessions closed before restart; hooks exit 0, database closed                                 | PASS for observed close cycle |
| StopFailure / recovery                  | Provider 402 triggered exit-0 hook and idle; operator continuation completed reply                 | PASS for observed transition  |
| Host permission prompts                 | No independently correlated prompt/decision probe retained                                         | UNVERIFIED                    |
| Final stand shutdown                    | Closed after separately authorized headless probes; isolated relay stopped 09:36:47 UTC            | PASS                          |
| Autonomous wake / headless resume       | active_delivery=0; neither exercised                                                               | OUT OF SCOPE                  |

Observed scoped rows replace their preparation-only UNVERIFIED verdicts. This
acceptance does not upgrade the older activation/full-client matrix wholesale.

## Message and timing ledger

All times are UTC on 2026-11-17.

| Probe | Question UUID                        | Reply UUID                           | Thread UUID                          |
| ----- | ------------------------------------ | ------------------------------------ | ------------------------------------ |
| W7B   | 00ea9265-e9aa-457b-af8e-d6a976e22c74 | 3217fc45-2cac-45a4-8bbe-8cbd99ee20fd | fc02a9a9-8016-4810-98f2-42e346cf774e |
| W7C/D | c4dfd365-015f-40ec-a1d4-994e3b55fb60 | 0a346f8e-d8d1-4bdf-b900-dbdb113814b9 | d54968cc-b2a5-4418-a068-2612972f537d |

- Arch busy at 08:57:08.862; question created 08:57:26.465; Stop/idle at
  08:57:49.225. Explicit next-interaction inbox returned it at 09:00:29.434.
- Before relay restart: ONE pending question and TWO already acked messages.
  Before/after snapshots at 09:08:10 matched sessions/messages/dedup/quarantine.
  Only the verified isolated relay process restarted; no database/credential reset.
- Replay at 09:10:28.858 returned original UUID, createdAt and thread; still
  three messages and three dedup rows. Both original session IDs registered
  generation 3 after resume.
- Arch inbox/ack completed at 09:12:20/09:12:24. Provider 402 interrupted before
  reply. After operator continuation, one reply was created at 09:14:46.760.
  Despite host prose about parallel operations, actual tools were sequential
  across the interruption.
- Final CTO ack tooluse_L0OPLurXizD9ozAfyuVbfj returned acked at 09:16:40.524.
  Snapshot w7-final-cycle.json at 09:17:12.042: FOUR messages ALL acked, four
  dedup rows, zero quarantine, both sessions idle/generation 3. Dedup rows retain
  original stored acceptance metadata; they are not pending-delivery rows.

## Failures and environment caveats

**Original startup ordering was FAIL.** Arch SessionStart at 08:39:59.284 exited 1
with empty stdout. Relay audit recorded heartbeat NOT_FOUND at 08:39:59.718,
before registration at 08:39:59.979. Later successful resume hooks do not erase
this failure. No production fix or fabricated heartbeat was applied. Lead
Developer tracks the follow-up in
[issue #124](https://github.com/OBenner/synloq/issues/124).
The fresh-runtime resume result is recorded separately below; no absent-channel
race was forced during that run, so it does not erase the original evidence.

**Session persistence.** First arch capture produced a real SessionStart ID but
no persisted conversation; resume failed. One visible recapture with a completed
exchange produced the working session. Initial failure evidence is retained.

**Kaspersky TLS inspection, machine-specific.** Node rejected the inspected
certificate chain. A public CA already trusted by Windows was exported locally
and supplied via NODE_EXTRA_CA_CERTS in each terminal. Strict TLS then passed;
certificate verification was never disabled. This is not a universal Synloq
setting. The operator checklist contains the actual local path; generic form:

```powershell
$env:NODE_EXTRA_CA_CERTS = '<path-to-approved-public-CA.pem>'
```

**Provider key type.** A management key caused HTTP 403 on inference. After
direct operator approval, ONLY the existing Claude auth-token setting was
replaced with the already verified ordinary provider key. No keys were issued,
printed or committed. An explicit provider model was selected on resume.

**Provider balance.** The UI reported 402 Insufficient balance between ack and
reply. StopFailure exited 0 with empty stdout; its snapshot recorded idle.
One operator continuation completed the reply. Permanent provider recovery is
not established by this observation.

**Host wiring.** Role-specific .mcp.json and explicit
`--settings ./live-settings.json` were used. Live hooks were not hot-loaded into
capture-only chats. Observed role wiring does not prove adversarial host-enforced
per-chat isolation or permission-policy acceptance. Version drift is recorded
per phase above, not hidden under a single installed-version claim.

## Private evidence index

Artifacts remain in the isolated stand; raw logs, transcripts, screenshots,
SQLite, credentials and message bodies are not publication artifacts.

- Setup: w7-preflight.json, w7-baseline.json, w7a-list-audit.json,
  w7a-arch-resume-failure.json, w7a-provider-tls-diagnosis.json,
  w7a-provider-key-type.json.
- Startup: w7a-arch-startup-race.json, hook event/audit streams, relay deny audit.
  The initial race note predates the later exact NOT_FOUND confirmation.
- W7B: w7b-cto-audit.json, w7b-arch-tools.json, w7b-cto-final-tools.json,
  w7b-complete.json.
- W7C: w7c-busy-correlation.json, w7c-busy-arrival.json,
  w7cd-arch-transcript-tools.json.
- W7D: w7d-reconnect-after.json, w7d-before-relay-restart.json,
  w7d-after-relay-restart.json, w7d-restart-persistence-comparison.json,
  w7d-post-restart-replay-tools.json, w7d-arch-reply-tools.json.
- Final: w7-final-cto-tools.json, w7-final-cycle.json, w7-final-cto-ack.png;
  hook streams include StopFailure and recovery.

Final cleanup occurred after a separately operator-authorized headless microprobe,
which is not part of W7 acceptance. Snapshot headless-after.json has both sessions
closed and all four W7 messages acked; the isolated relay was stopped at
09:36:47 UTC. The stand and database were preserved. Headless evidence stays in
the stand's separate headless-probe-20261117 directory.

## Unified re-init window: 2026-11-17

The operator confirmed both visible sessions closed before the isolated restart.
Process inspection found no Claude process. The team relay was outside this
window's scope and was not changed by the auditor. Before mutation, the auditor
saved SQLite/WAL/SHM, a consistent SQLite backup, old stand configs and a SHA256
index of 124 existing evidence files. The supported generic init generator
regenerated trusted project/agentId configs; observed session IDs and credential
file references were retained. No credential value entered the report.

Fresh main `2097715` migrated the preserved database from schema 5 to 6;
`integrity_check` returned `ok`, with all five previous messages still acked.
Node remained 24.13.0 and Claude Code 2.1.326; strict TLS used the previously
approved public CA via `NODE_EXTRA_CA_CERTS`. No provider 402 was observed.

### Startup recheck (#124)

Actual host SessionStart hooks, rather than injected hook JSON, produced:

| Role | Hook started (UTC) | Relay REGISTERED (UTC) | Hook exit       | Correlated SQLite   |
| ---- | ------------------ | ---------------------- | --------------- | ------------------- |
| cto  | 14:57:33.246       | 14:57:33.419           | 0, empty stdout | idle, generation 4  |
| arch | 14:59:55.036       | 14:59:55.321           | 0, empty stdout | idle, generation 10 |

This is PASS for resume startup on the upgraded preserved stand. Existing
session rows remained present; this window did not force a missing-registration
NOT_FOUND or demonstrate a live retry. The original cold-start race evidence
remains FAIL historically; deterministic race coverage belongs to #124's tests.

### Event-driven nudger (#126)

One newly committed synthetic message triggered the actual relay-owned nudger,
without a manual follow-up prompt or another visible session:

- Seed `d74ca97a-eafe-46c4-995d-48e6d338b34b`, created 14:59:51.737 UTC.
- Paired inbox tool result returned that seed as `stored` at 15:00:01.186.
- Paired ACK tool result returned the same ID as `acked` at 15:00:06.746.
- Exact assistant marker `NUDGE-ACK-93c579cc-fa97-420e-8167-3acbf38d8917`
  persisted at 15:00:11.550: **19,813 ms from seed to transcript**.
- Independent SQLite contained six messages, all acked, with zero quarantine.
  Inbox execution is proven by the paired transcript records, not an invented
  SQLite inbox-call log. Visible UI rendering was not measured.

These independently correlated delivery facts passed, but the product's durable
acceptance **failed**: its ledger retained `outcome=uncertain`, `proof=0`.
An offline call to the unmodified production verifier reproduced `false`.
The checkpoint selects the last user/assistant UUID, while the next actual user
row points to the previous `system/stop_hook_summary` UUID. The verifier ignores
that node and rejects the first parent link. Seven new attachment nodes also
participate in the transcript graph. A duplicate tool-use seen inside diagnostic
API-request data is not a second conversational call and is not the root cause.

No runtime patch, ledger reset or blind retry was performed. The uncertain row
was preserved for investigation; #126 is not fully live-accepted by this window.

### Negative tool-permission case

The saved CTO session ran the production nudger launch arguments with a request
to attempt send/reply. The actual initialization tool list omitted send, reply,
list and wait. An attempted send received `No such tool available`; there was
no actual reply call, and no new database message was created. This establishes
send denial and reply exclusion, not a separately observed reply-denial result.

The host reported a successful final result, but the process exceeded the 60 s
limit and was interrupted before SessionEnd. It is not a clean exit-0 acceptance.
The host's prose about available tools was inaccurate; the initialization list
is the evidence. That list also exposed #106's `note_read` and `note_write`, so
this launch policy cannot be described as exposing only inbox/ACK after #106.
No note-write execution was observed; that permission boundary is tracked in
[issue #137](https://github.com/OBenner/synloq/issues/137).

### Closure and evidence

After confirming no Claude/MCP child remained, the auditor explicitly closed
CTO generation 4 through the authenticated stand API as test cleanup. This is
not host SessionEnd evidence. Arch generation 10 closed through its actual
SessionEnd hook. The stand nudger config was disabled; ownership became inactive,
and the isolated relay shut down gracefully at 15:03:21.066 UTC. Final consistent
database and ledger backups retain six acked messages, both sessions closed,
zero quarantine and the unchanged uncertain attempt.

Private evidence lives under `reinit-20261117/`: pre-snapshots/index, upgrade
hashes, `startup-correlation.json`, hook/relay metadata, sanitized transcript
records, `durable-analysis.json`, negative-probe facts and `finalclosed.json`.
An intermediate relay restart needed termination of its verified owned PID
because the execution host closed stdin; its lock was preserved only after
process exit. Subsequent shutdown used explicit graceful control. No other
relay or production source was changed. Evidence and database files remain
untracked; this report contains no message bodies or credentials.
