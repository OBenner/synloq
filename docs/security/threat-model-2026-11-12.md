# Synloq Threat Model — 2026-11-12

Updated 2026-11-16 (#96, bounded A+D). Scope: single-host relay (loopback HTTP),
per-role bearer tokens, mixed host placements. This document is the current
source of truth; the 2026-11-12 isolation research is historical.

## Assets

- Message store (SQLite) — integrity and confidentiality of team communication.
- Per-role tokens — identity of a role; possession = the role.
- Operator token — pause gates, cross-inbox read.
- Role session bindings (Kimi conversationKey is its sessionId) — delivery target
  and writer consistency, not authentication of the initiating chat.

## Actors

- Legitimate role chats (cto, arch, security, dev), operator, relay process.
- Adversary model: a confused or misbehaving agent in a role chat (primary),
  a local process running as the same OS user (secondary, out of full mitigation).

## Trust boundaries

1. Caller chat → MCP channel: tool visibility/configuration is a host property.
   A shared channel does not supply verified caller-chat provenance.
2. MCP channel → relay HTTP: CredentialStore authenticates token → project/role.
   MCP injects a configured writer sessionId; this is not host attestation.
3. Relay → storage/adapter: recipient, writer and claim session/generation guards
   validate the operation against stored state before reading/mutating it.
   Adapter metadata/admission checks validate the delivery target only.
4. Relay process ↔ on-disk state (OS user boundary; not defended in v1).

## Threats and mitigations (P1.1 status)

| Threat                                      | Mitigation                                                                                                             | Status          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| Agent calls another role's MCP channel      | Relay-side consistency is enforced; caller-chat isolation is a host property, not a relay guarantee (#27, upstream #9) | Host-dependent  |
| Role reads/acks foreign inbox or message    | RelayService UNAUTHORIZED + audit event                                                                                | Done (P1.1)     |
| Reply into a thread not addressed to caller | NOT_FOUND (no existence leak) + audit                                                                                  | Done (P1.1)     |
| Stolen role token                           | Role impersonation remains possible; token rotation/revocation does not attest caller-chat identity                    | Accepted        |
| Sender identity spoofing at relay           | Known gap: `requireParticipant` validates recipient only; fix deferred to protocol v1.1                                | Open (v1.1)     |
| Audit log tampering                         | Same OS user can edit JSONL — detective, not preventive control                                                        | Accepted        |
| Host shows all role channels in every chat  | Instructions only on the shared Kimi Work plugin path; host-side scoping requested upstream (P1.2)                     | Open (upstream) |

The existing v1 §2.4 contract remains unchanged: mirrors can read with the role
token; a registered writer is required for send/reply/ack (`NOT_WRITER` on
mismatch); session-less roles keep token-only writes; the operator is exempt
from writer checks. Delivery endpoints separately enforce recipient and current
session/generation (`UNAUTHORIZED` on mismatch). A foreign reply parent remains
`NOT_FOUND`, avoiding an existence leak. These guarantees must not be described
as chat-origin authentication.

## Audit log

Append-only JSONL at `~/.synloq/data/<projectKey>-audit.jsonl`; one event per
covered controlled denial with timestamp, authenticated project/role, bounded
action and reasonCode. HTTP owns session/delivery/doctor denials; RelayService
owns message-operation denials; long-poll admission owns its rate-limit events.
The [route matrix](2026-11-16-relay-binding-audit.md) identifies owners and validation
coverage so an outer catch does not duplicate an inner event. New denial details
do not copy error text, request bodies, tokens or unverified session identifiers.
Registration denial surface hints use a fixed vocabulary and are audit-only,
not evidence of host identity. Successful binding events retain their existing
operational diagnostics. This is not a general HTTP access log.
Detective control: operator reviews on suspicion; no alerting in v1.

## Known limitations

- **Per-role channel isolation is instruction-only in the Kimi Work host**
  (verified 2026-11-13, [#27](https://github.com/OBenner/synloq/issues/27)):
  a chat that can see another role's MCP channel tools can invoke them and act
  as that role — the relay authenticates the channel token and cannot
  distinguish the initiating chat; the adapter conversationKey binding does not
  cover the Kimi Work plugin path. Acceptable under the current threat model:
  all MCP processes and tokens belong to a single OS user, and compromise of
  the user's process already compromises the project. Resolution depends on the
  upstream request for per-conversation MCP scoping
  ([#9](https://github.com/OBenner/synloq/issues/9)); no self-built enforcement
  (agentId + host attestation) is planned — without host support it would be
  security theater.
- **Host differences:** Codex Desktop's per-role trusted project configuration
  limits which role server is provisioned in that project ([ADR-0004](../adr/0004-role-placement-and-claim.md)).
  This is configuration scoping, not per-chat attestation: another chat using the
  same project/channel acts with that channel's credential. Additional globally
  configured servers and same-user access to credential files are outside that
  guarantee. OpenCode delivery binding similarly does not prove the origin of a
  tool call. No universal host-isolation claim follows from relay tests.
- **Bootstrap and replacement:** registration is authorized by a role token and
  supplies a session identifier. Registration/claim/generation checks prevent
  conflicting operations under their existing rules; they do not verify where
  that identifier came from. Operator replacement invalidates old delivery
  generations and writer ids; a waiting delivery poll rechecks storage after
  notification. Expiry, re-registration and hook/session-less compatibility
  keep their current semantics. No new enrollment or wire identity is introduced.

## Non-goals (v1)

Encryption, non-loopback transport, multi-relay federation, OS-user isolation.
