# Backlog

Open work after the 2026-11-12 acceptance. Sources: `docs/security/review-2026-11-12.md` and the consolidated CTO RESULT (thread bcc7b70f). Priorities: P0 — before protocol v1 implementation (closed), P1 — next, P2 — as adapters and stabilization progress, P3 — low, opportunistic. Tasks are tracked as GitHub Issues (https://github.com/OBenner/synloq/issues); this table mirrors their state.

## Security and hardening

| #   | Item                                                                                            | Priority | Status                          |
| --- | ----------------------------------------------------------------------------------------------- | -------- | ------------------------------- |
| H1  | Unauthenticated `/v1/health` before sending the token                                           | P0       | DONE (56bfeae)                  |
| H2  | Fail-closed loopback validation of `relayUrl` in the MCP config and `RelayHttpClient`           | P0       | DONE (56bfeae)                  |
| R1  | Mutual relay authentication (per-project challenge) — closing the R1 residual                   | P1       | open                            |
| M1  | `rotate-token` + runbook: reissuing does not isolate old tokens (append-only)                   | P1       | DONE (b716489, runbook 3454840) |
| M2  | Concurrent long-poll limit (per-identity, `RATE_LIMITED` rejection)                             | P1       | open                            |
| M4  | Audit log: auth failures, operator actions, token issuance (append-only, doctor)                | P1       | open                            |
| M3  | Message retention/GC in sync with the 7-day dedup TTL from spec v1                              | P2       | open                            |
| —   | Reserving sender ids `relay`/`operator` in the protocol                                         | P2       | open                            |
| —   | npm Trusted Publishing (OIDC from GitHub Actions) — granular publish tokens deprecated Jan 2027 | P3       | open                            |

## UX and upgradability

| Item                                                                                                 | Priority | Status |
| ---------------------------------------------------------------------------------------------------- | -------- | ------ |
| `doctor --repair`: restore configs after 401/token reissue from saved state                          | P1       | open   |
| Remove absolute paths from generated configs (repository/synloqHome relocation without regeneration) | P1       | open   |

## Protocol and isolation

| Item                                                                                                                                                                                                                                                                               | Priority | Status                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| P1.1 per-chat isolation: relay-side binding of role-token ↔ bound conversationKey, deny log, conformance                                                                                                                                                                           | P1       | open                                                                                                        |
| P1.2 upstream feature request to Kimi Work: per-conversation plugin/MCP scoping                                                                                                                                                                                                    | P1       | open                                                                                                        |
| Spec v1.1: the sender must also be a participant (`requireParticipant` asymmetry, 2026-11-12 incident)                                                                                                                                                                             | P1       | open                                                                                                        |
| Delivery watchdog: alert/conformance for "stored without visible delivery > N minutes" after a relay restart (2026-11-12 incident)                                                                                                                                                 | P1       | open                                                                                                        |
| Flaky spawn tests (`codex-probe`, `supervisor-loop`): fail under load in the verify chain, consistently green in isolation — increase timeout or add retry                                                                                                                         | P3       | open                                                                                                        |
| Runner recovery: `HttpAdapterRunner` does not recover after UNAUTHORIZED on `nextDelivery` (stale generation) — heartbeat without generation masks the failure, poll silently backs off; fix via re-registration + diagnostics (2026-11-12 incident, CTO messages stuck in stored) | P1       | DONE (this commit: heartbeat carries generation, runner terminates on UNAUTHORIZED, lifecycle re-registers) |
| P1.3 / P2: adapters for other hosts (per-role processes where supported)                                                                                                                                                                                                           | P2       | open                                                                                                        |
| Research: long-term memory for role chats (host-native / MCP plugins / Synloq-native) — issue #20, assigned arch                                                                                                                                                                   | P2       | open                                                                                                        |
| L-findings: dead-code `initCommand`, lock on credentials.json, fsync, spec↔impl reconciliation (hops, NOTICE to operator, strict zod)                                                                                                                                              | P2       | open                                                                                                        |

## Working rules for this backlog

- An item is closed by a commit referencing its row in this table; the status changes in the same commit.
- New review findings are added by the role that performed the review, with priority and source.
