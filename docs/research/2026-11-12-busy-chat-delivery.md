# Research: delivery into busy host chats with visible queue state

- Date: 2026-11-12
- Author: Architect
- Issue: [#23](https://github.com/OBenner/synloq/issues/23)
- Status: proposal, awaiting CTO review

## Verified facts (code evidence, not assumptions)

### The state gate is two-layered and deliberate

1. **Relay side.** The dispatcher skips a recipient whose effective session
   state is not `idle` (`src/relay/dispatcher.ts:90`), and the message store
   only offers a delivery when the session is _freshly_ idle — state observed
   within the last 5 s, lease valid, nothing paused
   (`src/storage/message-store.ts:301-312`).
2. **Adapter side.** Before sending, the Kimi Work adapter re-checks idleness
   twice: a cached state check and a fresh `refresh()` right before admission
   (`src/adapters/kimi-work.ts:201-224`).

### Kimi Work rejects busy sends — it does not queue them

The plugin delivery path is `conversations.send` over the host JSON-RPC
control socket (`src/host/kimi-work/control-client.ts:247-272`). Its request
schema has exactly three fields — `agentId`, `conversationKey`, `text`. There
is **no enqueue/queue parameter**.

When a send races a busy conversation, the host responds with a JSON-RPC
error whose `data.reasonCode` is `CONVERSATION_BUSY` or `OPERATION_BUSY`
(handled at `src/adapters/kimi-work.ts:231-236`; `reasonCode` is extracted
from the host error frame at `src/host/kimi-work/json-rpc.ts:131-140`). These
are host-originated rejection codes — the host refuses the send rather than
queueing it.

The operator-input queue the operator observed (typed text in a busy chat is
enqueued and shown in the UI) belongs to the client UI input path, which is
**not exposed** on the plugin JSON-RPC surface. The full method inventory we
use is `conversations.create / list / getMetadata / getBusy / getMessages /
send`; none offers queued admission.

### OpenCode natively supports queued delivery

The OpenCode adapter already admits prompts with `delivery: "queue"`
(`src/adapters/opencode.ts:167-175`) and validates the admission echo
(`admitted.delivery === "queue"`, line 211). The host capability for
busy-queueing **exists there today** — our adapter still gates on idle
(`opencode.ts:162-164`) by policy, not by necessity.

### Today's pain is invisibility, not latency

The 2026-11-12 latency investigation (dev, thread 07a79ef6) and the
controlled busy-case test the same day showed: the gate works as designed,
delivery after the chat goes idle takes seconds, but a `stored` wait is
invisible without reading the relay DB. This motivated #19 (`synloq status`).

## Options

### (a) Busy-delivery via host queue

Deliver through the host's queue instead of waiting for idle.

- **Kimi Work:** blocked upstream. `conversations.send` has no queue
  semantics; busy sends are rejected. Requires a Kimi Work feature request —
  same channel as #9 (per-conversation scoping); the two asks can be filed
  together.
- **OpenCode:** natively available (`delivery: "queue"`). Would mean relaxing
  the adapter's idle gate for a host-specific behavior.
- Semantics if the host queues: the queued text becomes the **next user turn**
  after the current one finishes — same as queued operator input. Ordering
  follows relay FIFO if we enqueue in order; cancellation maps to the send's
  abort signal.
- Risks: mid-turn interleaving expectations per host; host-divergent delivery
  timing complicates conformance ("delivered" means different things per
  host); a queued turn still does not run until the chat drains, so
  **latency to actual processing barely improves** — what improves is
  visibility and admission time.
- Effort: 0.5 d to draft+file the upstream request; ~1 d to enable on
  OpenCode + conformance tests, if we accept divergence.

### (b) Keep the state gate + make the queue visible

Delivery policy unchanged; attack invisibility instead.

- #19 (`synloq status`): per-role stored count, chat state, wait reason
  ("2 stored — waiting for arch chat to go idle"). Read-only, no protocol or
  host dependency.
- Optional widget/doctor surface later.
- Effort: 0.5–1 d. Zero protocol risk, zero upstream dependency.
- Directly addresses the observed pain (all 2026-11-12 "hangs" were
  invisibility, not stuck delivery).

### (c) Hybrid: deliver NOTICE/probes into busy, hold TASK/RESULT

Only viable where the host accepts busy delivery — i.e. **not Kimi Work
today**. Adopting it only on OpenCode makes delivery semantics
host-dependent, which hurts the conformance story and role instructions
(identical behavior is currently assumed across hosts). Also, a NOTICE queued
as the next turn still does not interrupt the running turn, so the urgency
benefit is small.

## Protocol v1 impact assessment

**Zero — confirmed.** Spec v1 governs the envelope, message types, state
machine (`stored → delivered → acked`), ack semantics and reason codes
(§1–§5). Delivery _timing_ — when the relay offers a stored message and when
the host admits it — is implementation. All three options leave the message
state machine and envelope untouched. Option (a) changes only when `stored →
delivered` happens, not what the states mean.

## Recommendation

**Adopt (b) now** — implement #19 (`synloq status`) as the fix for the
invisibility that caused every 2026-11-12 latency complaint. Effort 0.5–1 d,
no dependencies.

**File (a) as an upstream request** to Kimi Work (queued/visible admission
for plugin-sourced sends, e.g. an `enqueue` flag on `conversations.send` with
UI parity to operator input), bundled with the #9 request. Re-evaluate busy
delivery when the host answers. Do not enable OpenCode-only queueing in the
meantime — host-divergent delivery semantics cost more than the visibility
they buy, and (b) already covers visibility uniformly.

**Reject (c)** as policy: not implementable on the primary host, and
per-host divergence is the wrong direction for a conformance-driven protocol.

## Risk list

- (b) only: users may still _want_ faster admission into busy chats; the
  status command makes waits explained, not shorter. Accepted — the evidence
  shows waits are short once the chat idles.
- Upstream (a) may be declined or delayed indefinitely; (b) must stand alone.
  It does.
- If (a) lands upstream later, revisit ordering semantics (queued turn vs
  interleave) before enabling — queued-as-next-turn is the safe semantic.
