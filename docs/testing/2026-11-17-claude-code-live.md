# Claude Code live acceptance — prepared, not executed

- Status: **UNVERIFIED — awaiting operator window and visible session binding**.
- Coordinator/auditor: staff1; operator-led visible Claude Code role sessions.
- Source runtime: `0d972bc8d7b726542ed4cbd8d00094d7190c5a8a` (main).
- Installed Claude Code: `2.1.81`; Node: `v24.13.0`.
- Scope: inbox, ack, dedup, provenance, lifecycle, busy/idle, reconnect and next
  interaction. Autonomous wake is outside this acceptance scope.
- Procedure: [live runbook](../runbooks/2026-11-14-claude-code-live-dod.md).

## Preparation evidence

Isolated project/home and roles `cto` + `arch` were created. Build passed; a fresh
loopback relay answered health. Read-only SQLite baseline contained no sessions,
messages or quarantine rows. These observations establish only stand readiness.
No Claude session has been bound and no live MCP probe has run.

Private evidence index (filenames only; files remain in the stand):

- `w7-preflight.json`: runtime commit and versions.
- `w7-health.json`: discovery response.
- `w7-baseline.json`: metadata-only SQLite snapshot.
- `observed-session-<role>.json`: pending actual host SessionStart observation.
- `hook-events-<role>.jsonl`, `hook-audit-<role>.jsonl`: pending live hook evidence.

## Capability verdicts

| Probe                                   | Required evidence                                             | Verdict                |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| W7A exact binding / six tools           | Visible IDs, MCP pickup, tools/list, relay registration       | UNVERIFIED             |
| W7B inbox / own ack / cross-role denial | Tool output, message metadata, deny audit                     | UNVERIFIED             |
| W7B dedup / provenance                  | Original UUID on retry, conflict, correlated reply            | UNVERIFIED             |
| W7C lifecycle / busy / idle             | Host hooks plus fresh relay timestamps and generations        | UNVERIFIED             |
| W7C next interaction                    | Pending message read after operator interaction, no injection | UNVERIFIED             |
| W7D reconnect / restart                 | Same IDs/history, generations, exactly-once disposition       | UNVERIFIED             |
| W7D shutdown                            | Observed close event and relay state                          | UNVERIFIED             |
| Autonomous wake                         | Separate upstream/activation work                             | OUT OF SCOPE; disabled |

No support-matrix claim is upgraded. Populate probe/message IDs and failure
details only after independent evidence is available; never publish raw logs,
credential values, private paths or message bodies.
