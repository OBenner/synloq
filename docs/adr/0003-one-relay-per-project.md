# ADR 0003: One relay per project, with surviving-peer election

- Status: accepted
- Date: 2026-11-14
- Deciders: Architect (proposal), operator (approval)
- Related: README §2 (automatic relay lifecycle); ADR 0001 (project as trust boundary); issue #1 (R1 residual: static health marker)

## Context

The relay owns the project's durable SQLite state: message queue,
deduplication keys, delivery claims. Two relays on one project database would
mean two writers with divergent views of the queue — lost exactly-once
semantics, double delivery, corrupted dedup.

At the same time, Synloq's operator experience requires zero daemon
management: opening a role chat must be enough for the whole team to work,
and the relay must survive any single chat closing (including its owner's).

## Decision

**Exactly one relay writer per project, started and kept alive by the role
channels themselves.**

1. **Automatic startup.** A generated role channel (Kimi Work or OpenCode)
   probes the project's relay endpoint when its MCP process starts. If a
   compatible relay answers, the channel reuses it; otherwise the channel
   starts the relay itself and becomes its owner.
2. **Fail-closed identity check.** Before reusing a listener on the expected
   port, the channel verifies the unauthenticated `GET /v1/health` marker:
   correct service, correct project, expected protocol version. An unrelated
   process, a relay of another project, or an ambiguous answer means the
   channel refuses to attach and never starts a second writer.
3. **Surviving-peer election.** If the owner channel stops (chat closed,
   client restarted), the remaining channels detect it via heartbeat loss,
   run a bounded reconnection window, and exactly one surviving peer
   re-binds the listener. Registrations from before the restart are
   invalidated (session generation bump); channels re-register with a fresh
   generation. Messages in SQLite are unaffected.
4. **One project = one port.** Two projects on one machine need two ports;
   the same project opened in several hosts (Kimi Work + OpenCode) shares the
   single relay — that is the supported multi-host topology.
5. **Manual `synloq serve`** remains for diagnostics and custom topologies
   only; it must never run alongside the generated automatic topology unless
   they intentionally share one compatible relay.

## Consequences

- Operators never start or stop a relay by hand; the team's lifecycle follows
  its chats.
- Any single chat can be closed or restarted without losing the team's
  message state.
- The health-marker check is the only thing standing between a role token
  and a port squatter; its residual weakness on multi-user machines is
  tracked as R1 (issue #1, mutual relay authentication).
- A second project requires a second port — a known UX edge (research gap
  G5) to be smoothed by port assignment in init.

## Alternatives considered

- **A system-level daemon (systemd/user service) owning the relay** —
  rejected: contradicts local-first, zero-install ergonomics; ties the team
  lifecycle to OS service management instead of the chats the operator
  actually sees.
- **Multi-writer relays with DB-level locking** — rejected: complexity and
  failure modes (split-brain claims, dedup divergence) vastly outweigh the
  benefit; single-writer with election is simpler and observable.
- **Relay embedded in one designated "leader" chat** — rejected: makes that
  chat a single point of failure and couples team availability to one role's
  window being open.
