# ADR 0002: Uncertain deliveries are retried, not quarantined

- Status: accepted
- Date: 2026-11-13
- Deciders: CTO, Architect (implementation: dev)
- Related: issue #28; commits b3f4aeb, cd7349e, d3ff851; `docs/protocol/v1.md` §3 (delivery states), §6 (failure handling)

## Context

When a host answers a delivery ambiguously (the request was transmitted but
the result was lost — `DELIVERY_UNCERTAIN`), the original design failed
closed and hard:

- the message was parked in a durable `submitted` quarantine row,
- a pause gate muted the whole participant,
- resubmission was refused by a permanent adapter-side uncertain set.

Live operation on 2026-11-12 showed the cost: one ambiguous host response
silently stalled a role's entire FIFO queue, and the only recovery was
operator intervention. A transient host hiccup became a permanent outage for
that participant.

## Decision

**An uncertain delivery returns to the FIFO queue (`stored`) and the
participant keeps working.** Safety against duplicate visible sends moves
from the relay to the receiving adapter:

1. Relay side (b3f4aeb): `reportDeliveryFailure` releases `RETRYABLE` and
   `DELIVERY_UNCERTAIN` claims back to `stored`; no pause gate, no
   quarantine row. Acceptance-consumed marks are preserved so a consumed
   acceptance is never re-claimed. (Re)registration reconciles outstanding
   claims unconditionally — a fresh session generation is the natural
   reconcile boundary.
2. Adapter side (cd7349e): resubmission is **probe-gated**. Before
   re-sending, the adapter re-reads the visible history; a matching frame is
   memoized without a second send, and only a proven-invisible message is
   sent again.
3. Recovery loops are rate-limited (d3ff851): repeated re-registration
   storms (observed live at 1.5–3 per second) are throttled with a cooldown
   and a diagnostics line.

### Accepted trade-off

A delivered-but-invisible frame (the host swallowed the echo, so the probe
finds nothing) can produce **one duplicate visible message** on resubmit.
This is accepted because prompts carry the Synloq message id, so the
receiving role can recognize the repeat — and a rare visible duplicate is
strictly better than silently muting a participant.

## Consequences

- A single ambiguous host response no longer stalls a role; transient host
  flakiness self-heals on the next runner tick.
- Duplicate-visible-message is now a known, acceptable outcome of one narrow
  failure window; receivers must tolerate it (the message id is in the
  frame, and receiver-side dedup per spec §5 applies).
- The e2e evidence matrix row "OpenCode uncertain result"
  (`test/e2e/real-clients.md`) expects the new behavior: return to `stored`,
  probe-gated resubmit, registration as the reconcile point.
- Relay-side audit (#3) should record release-of-uncertain events so the
  duplicate window stays observable.

## Alternatives considered

- **Keep quarantine + pause (status quo ante)** — rejected: one ambiguous
  response muted a participant indefinitely; the failure cost was wildly
  disproportionate to the cause.
- **Never resubmit uncertain messages; surface to the operator** — rejected:
  turns a recoverable transient into guaranteed manual work; with
  probe-gating the common case (frame actually never landed) is safe to
  retry automatically.
- **Relay-side probe** — rejected: the relay has no host access by design;
  only the bound adapter can read the visible history.
