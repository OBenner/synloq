# ADR 0005: Platform-independent role execution

- Status: accepted (operator, 2026-11-14)
- Date: 2026-11-14
- Deciders: Architect (proposal), CTO (convergence), operator (direction)
- Related: ADR 0001 (project boundaries, replace-session); ADR 0003 (one
  relay per project); ADR 0004 (role placement and claim); issue #45
  (stored-ping watcher); issue #46 (single-writer enforcement); issue #11
  (delivery watchdog)

## Context

A Synloq role lives inside a host chat, but the platform-dependent part is
not the role — it is the delivery _into_ the chat. The host capability
matrix (verified 2026-11-14):

| Host          | Push into chat                     | Chat identity for MCP              |
| ------------- | ---------------------------------- | ---------------------------------- |
| Kimi Work     | yes (client API)                   | bound at init                      |
| OpenCode      | yes (server API, proven by tester) | session id from API                |
| Codex Desktop | no                                 | per-role project config (ADR 0004) |
| ZCode         | no (API chats skip workspace MCP)  | none (vendor-blocked)              |

Push is not processing: a message pushed into a busy chat still waits for
the model to become free (observed live 2026-11-14: messages stored
09:52–10:21 surfaced only when the chat was activated at ~10:23). The
baseline that works on every host is MCP-visible `stored` state — any chat
with the Synloq channel can read its inbox once it runs.

The operator requirement: a coordinator role must be platform-independent —
responsive even when no client is open, and equally addressable from any
host.

## Decision

Three mechanisms, one ownership model. Protocol v1 is untouched (no
envelope, message type, reason-code, or constant changes); all mechanisms
are host-side or tooling-side.

1. **Single executor per role.** Whoever speaks for a role is an _executor
   binding_: the ADR 0004 claim binding between the role and a host session,
   marked `mode=executor`. Liveness is the existing session heartbeat (the
   lease TTL _is_ the heartbeat TTL — no separate clocks, no lease verbs in
   the protocol). There is at most one executor per role at any time.

2. **Chats are read-only showcases under a foreign executor.** When a role
   has an active executor, that role's MCP tools in any other chat run in
   read-only mode: `inbox`/`list` work; `send`/`reply`/`ack` are refused
   with a pointer to the active executor and to `replace-session` as the
   only takeover path. No parallel writers, no duplicate replies. A stuck
   executor is handled by the delivery watchdog family plus an operator
   takeover command (tracked separately as issue #46; useful already today,
   before any headless executor exists).

3. **Stored-ping watcher (mixin transport).** A watchdog-family component
   watches `stored` messages older than a threshold for roles that have a
   live chat, and pushes a lightweight ping into that chat through the host
   API where one exists ("N pending since <id>"). On hosts without push it
   falls back to surfacing the fact in status/doctor output. This is the
   primary near-term mechanism (issue #45): cheaper than an external
   notification bridge, no LLM, no new ownership concepts, and it targets
   exactly the observed pain (stored messages invisible until chat
   activation).

The full delivery matrix per host, best to worst: host push (real
delivery) → stored-ping into a live chat → external notification (future,
hosts without push) → headless executor (no live chat at all).

The **headless executor** (`synloq agent run <role>`: poll inbox → LLM →
process per role instructions → reply) is the target architecture for truly
unattended roles. It is an executor binding like any other, so the
single-executor and read-only rules above apply unchanged. Its LLM
provider, runtime, and scheduling are deliberately out of scope for this
ADR; it gets its own issue once this ADR is accepted and a provider
decision exists.

## Consequences

- A role's reachability no longer depends on which host its chat lives in;
  the host only selects which delivery transport applies.
- Ack semantics stay sacred: nothing acks on a role's behalf except the
  executor that actually processed the message.
- The relay stays dumb: no auto-replies, no lease CAS verbs, no protocol
  changes. Ownership state lives in the team state next to claim records.
- Cost: the tools layer grows a foreign-executor check; the watcher is one
  more long-running component to supervise (same family as the existing
  watchdog).
- Read-only mode (#46) and the stored-ping watcher (#45) are independently
  useful and can ship before any headless executor.

## Alternatives considered

- **Relay-side auto-responder (protocol-level)** — rejected: auto-ack breaks
  the ack=read semantics for senders; auto-reply turns the relay into an
  executor, which is the headless-loop idea implemented in the worst
  possible place (today a relay failure leaves state untouched; an executor
  inside the relay changes that).
- **External notification bridge only (desktop notify / bot)** — rejected
  as primary: it is an alarm clock, not delivery, and strictly more
  expensive than the stored-ping watcher where host push exists. Kept as
  the fallback tier for hosts without push.
- **TTL lease with CAS verbs in the protocol** — rejected: complexity far
  ahead of need. One local relay, claim bindings plus heartbeat liveness
  are sufficient; a real multi-machine lease can revisit this when the
  relay leaves loopback.
- **Do nothing beyond portability (ADR 0004)** — rejected: claim/init move
  a role to where push exists, but do not make it timely.

## Implementation status

- Stored-ping watcher (#45): implemented — per-channel watcher nudges a live
  idle chat with stale stored mail on push-capable hosts (kimi-work,
  opencode), content-free, throttled per backlog epoch; hosts without push
  get a manual-poll note in `synloq status`. Per-role opt-out via
  `"storedPing": false` in the channel config.
- Single-writer / read-only mode (#46): not implemented. The headless
  executor gets its own issue after this ADR is accepted and the LLM
  provider is chosen.
