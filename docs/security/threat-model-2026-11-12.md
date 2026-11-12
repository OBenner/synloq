# Synloq Threat Model — 2026-11-12

Scope: single-host relay (loopback HTTP), 4 role channels via one Kimi Work plugin,
per-role bearer tokens in `~/.synloq/credentials/<projectKey>/`.

## Assets

- Message store (SQLite) — integrity and confidentiality of team communication.
- Per-role tokens — identity of a role; possession = the role.
- Operator token — pause gates, cross-inbox read.
- Role conversation bindings (conversationKey) — visible-chat authenticity.

## Actors

- Legitimate role chats (cto, arch, security, dev), operator, relay process.
- Adversary model: a confused or misbehaving agent in a role chat (primary),
  a local process running as the same OS user (secondary, out of full mitigation).

## Trust boundaries

1. MCP stdio channel ↔ relay HTTP (authenticated by per-role token).
2. Visible chat ↔ role channel (enforced by adapter conversationKey binding,
   fail-closed; host does NOT scope tools per conversation — see P1 research).
3. Relay process ↔ on-disk state (OS user boundary; not defended in v1).

## Threats and mitigations (P1.1 status)

| Threat                                      | Mitigation                                                                                            | Status          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------- |
| Agent calls another role's MCP channel      | Adapter binding UNAUTHORIZED + audit event                                                            | Done (P1.1)     |
| Role reads/acks foreign inbox or message    | RelayService UNAUTHORIZED + audit event                                                               | Done (P1.1)     |
| Reply into a thread not addressed to caller | NOT_FOUND (no existence leak) + audit                                                                 | Done (P1.1)     |
| Stolen role token                           | Full role impersonation — accepted residual risk in v1; rotation is an open question (P1 research §5) | Accepted        |
| Sender identity spoofing at relay           | Known gap: `requireParticipant` validates recipient only; fix deferred to protocol v1.1               | Open (v1.1)     |
| Audit log tampering                         | Same OS user can edit JSONL — detective, not preventive control                                       | Accepted        |
| Host shows all role channels in every chat  | Instruction + fail-closed adapter; host-side scoping requested upstream (P1.2)                        | Open (upstream) |

## Audit log

Append-only JSONL at `~/.synloq/data/<projectKey>-audit.jsonl`; one event per
controlled denial (`SynloqError`) with action, project, agentId, reasonCode.
Detective control: operator reviews on suspicion; no alerting in v1.

## Non-goals (v1)

Encryption, non-loopback transport, multi-relay federation, OS-user isolation.
