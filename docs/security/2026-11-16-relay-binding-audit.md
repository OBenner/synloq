# Relay binding and denial coverage (#96)

Date: 2026-11-16. Scope: bounded A+D, unchanged protocol v1 and session/wire
contracts. The [threat model](threat-model-2026-11-12.md) defines the guarantee.

## Identity and enforcement

`RelayHttpServer.authenticate` resolves a bearer credential to project/role using
CredentialStore. Bodies, tool names, surface hints and conversation strings do
not choose that identity. Kimi's conversationKey already maps to sessionId; no
second binding key or caller-chat assertion is added.

Existing RelayService and storage checks remain authoritative. Storage checks
recipient plus session/generation in the same transaction as claim mutations.
Each iteration of a delivery long poll repeats the claim check, including after
operator replacement wakes it. Missing delivery generation fails schema
validation; heartbeat/close retain their existing optional-generation behavior.

## Route matrix and audit ownership

| Route or service method                     | Existing authorization/binding check                                             | Denial owner                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| Any authenticated HTTP route                | CredentialStore project/role bearer lookup                                       | HTTP authenticate                             |
| GET health                                  | Public compatibility marker, no role/session data                                | None                                          |
| GET participants                            | Authenticated project roster; mirror reads allowed                               | No additional binding guard                   |
| POST messages / replies                     | Role from credential, writer proof if registered; recipient/parent checks        | RelayService send/reply                       |
| GET inbox (including MCP wait)              | HTTP derives project/agent from credential; direct service calls also check both | RelayService inbox; longPoll owns cap refusal |
| POST ack                                    | Writer proof if registered; message project/recipient in storage                 | RelayService acknowledge                      |
| RelayService getMessage (not an HTTP route) | Project plus sender/recipient membership                                         | RelayService getMessage                       |
| POST sessions/register                      | Credential role, protocol, unique binding/ownership rules                        | HTTP registerSession                          |
| POST sessions/heartbeat, close              | Stored role/session; generation when supplied                                    | HTTP heartbeat/close                          |
| GET deliveries/next                         | Current recipient/session/generation before claim, repeated on wake              | HTTP claim; longPoll owns cap refusal         |
| POST deliveries/:id/authorize               | Recipient, current binding and submitted claim                                   | HTTP authorizeDelivery                        |
| POST deliveries/:id/receipt                 | Recipient, current binding, claim and receipt evidence                           | HTTP deliveryReceipt                          |
| POST deliveries/:id/failure                 | Recipient, current binding/claim, failure semantics                              | HTTP deliveryFailure                          |
| POST operator/pause, resume                 | Operator for current project                                                     | RelayService pause/resume                     |
| POST operator/replace-session               | Operator plus registration rules                                                 | HTTP replaceSession                           |
| GET operator/doctor                         | Operator                                                                         | HTTP doctor                                   |

The HTTP fallback matches only fixed session/delivery/doctor route classes that
have no lower denial owner. It logs controlled domain errors and Zod validation
failures on those routes; register/replace do the same in their dedicated
handlers. Long-poll admission emits its own event before returning RATE_LIMITED;
claim's outer handler does not emit a second event for it. Message operations
retain RelayService ownership, including direct calls. Successful operations do
not emit denial events.

This is not a universal access log: unknown routes, malformed HTTP parsing before
an audited operation, validation before RelayService dispatch, and unexpected
non-domain failures are not claimed as audited here. Existing HTTP error mapping
is unchanged. No new metrics backend or dependency is introduced; deny events
can be counted by action/reason.

## Bounded diagnostics

Denied operations use fixed action names and domain reason codes. Details are a
constant per action, not `error.message`: writer errors can contain an unverified
sessionId, and an attempted registration is not a verified binding. Registration
denials retain only allowlisted surface labels (`kimi-work`, `opencode`,
`opencode-mcp`, `claude`, `codex-hook`; other values become `other`). The
`opencode-mcp` label preserves the existing doctor diagnostic. Surface remains
client-supplied, not an authorization input. Long-poll diagnostics contain only
the fixed route label and existing bounded cap error.

API error text/codes and accepted registration diagnostics keep their prior
behavior. Audit output is not guaranteed durable under disk failure; same-user
log tampering remains outside this protection. Tokens/bodies/raw URLs/headers
and attempted conversation identifiers are not copied into these denial events.

## Conformance evidence and limits

- HTTP: two roles with different sessions; foreign binding on all six delivery/
  lifecycle paths yields UNAUTHORIZED, exactly one denial, unchanged message and
  session state. Unauthorized doctor reveals no sessions.
- HTTP lifecycle: missing/stale delivery generation, operator replacement during
  a parked poll, positive own-binding claim/authorize/receipt/ack, and foreign
  receipt without mutation. Read-only mirrors, NOT_WRITER, hidden-parent
  NOT_FOUND, session-less behavior and existing cap tests stay intact.
- Service: cross-role and cross-project inbox/message checks, including no data
  mutation and single-event assertions.
- SDK → MCP → HTTP: foreign-recipient ack returns a tool error and one audit event;
  valid channel credentials still act as that role without any caller-chat proof.
  The latter is an explicit limitation, not a passing host-isolation test.
- Regression origin: seven HTTP denial paths initially returned correct errors
  without audit events; a writer denial copied an unverified session marker.
  All eight assertions failed before the fix and passed afterward.

All fixtures use temporary local relay/storage instances. No live foreign-role
channels, host sessions or token rotations are used for this evidence.
