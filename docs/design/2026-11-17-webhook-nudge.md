# Webhook nudge channel (#117)

Status: v1.1 implementation of the architecture decision from 2026-11-17.
The final decision replaces the earlier contradictory combination of at-most-once
and three retries: **one HTTP attempt per event, no retries**, including timeouts.
This is opt-in observability for an operator-owned local receiver. It does not
activate a host, confirm message delivery, or grant authority to execute a task.

## Local configuration

Only the gitignored `synloq.local.yaml` may contain this configuration:

```yaml
webhooks:
  enabled: true
  url: http://127.0.0.1:62013/events
```

Absent configuration or `enabled: false` starts no exporter. One endpoint per
project is supported. Changes apply on relay restart. The shared `synloq.yaml`
rejects the `webhooks` field, including a disabled value; this is a deliberate
exception to forward-tolerant parsing of other unknown manifest fields. Invalid
local configuration fails with a sanitized error, never its input values.

Only HTTP/HTTPS numeric loopback addresses (`127.0.0.0/8` or `::1`) with an explicit
port are accepted. DNS names, non-loopback, link-local/metadata addresses, URL
credentials, query, fragment and redirects are rejected. This includes IPv4
aliases and IPv4-mapped IPv6. The path is at most 128 characters, restricted to
ASCII letters, digits, slash, underscore, dot, tilde and hyphen. The target port
must differ from this relay's listening port, even on a different loopback IP.
TLS verification remains enabled for HTTPS; certificates must match the literal
address and be trusted by Node.
HTTPS on loopback is supported explicitly; self-signed certificates are not
automatically trusted and certificate checks are never bypassed by the exporter.

The transport uses bare `node:http`/`node:https` with `Connection: close`, no
connection pool, relay authentication, cookies, secret headers or proxy routing.
It discards the response immediately after headers and never follows redirects.
No arbitrary response body is buffered or included in diagnostics.

## Event and trigger

The exact schema is:

```json
{
  "version": 1,
  "event": "stored_pending",
  "project": "example",
  "agentId": "arch",
  "messageId": "96366490-c3f0-4bbe-81bc-95ab7a5406ef",
  "threadId": "fc7ec86e-143b-4793-87bf-e7698ced1460",
  "sentAt": "2026-11-17T12:00:00.000Z",
  "relayInstance": "77f0d812-95e8-4fde-95bc-50ce3bb19f87"
}
```

IDs originate in the relay, project comes from server configuration, and agentId
is the validated roster recipient. `sentAt` is the event's reservation time,
not proof of receipt. `relayInstance` is a new UUID for this exporter's boot.
There are no message bodies, titles, notes, user prompts, session IDs, paths or
credentials in the payload. Construction uses an allowlist, never object spread
from a message. The receiver must treat these **unauthenticated hints** as data,
not commands or proof: any local process can forge a request to its endpoint.
Actual state must be verified through the authenticated relay.

The trigger is a newly committed `send` or `reply` (`result.created`), after
sender/recipient validation, durable storage and protection accounting. Replays
and rejected sends do not emit. Export failures do not change a committed send or
ack result. There is no scan/backfill, new delivery state, SQLite migration,
delivery receipt, ACK or host wake performed by this worker.

Emission is debounced per `(project, agentId)` for five minutes. The epoch is
reserved **before** network work, including if global bounds drop the event.
Dropping an event by a cap consumes that epoch: subsequent mail cannot retry it
until the five-minute epoch expires or an actually empty backlog resets it.
More messages in the same epoch do not emit. Once five minutes pass, a subsequent
new message can create another event; time passing alone sends nothing.
An actually empty unacknowledged backlog resets the epoch, so new mail can emit
sooner, still subject to global caps. Delivered-but-unacknowledged messages keep
the epoch alive. The post-commit observer also detects an empty previous backlog
when only the new message remains, including after retention or out-of-band ACK.

## Bounds, failure and shutdown

- One in-flight request, at most 256 queued identifier records and 1024 epoch
  entries. Expired epoch entries are pruned on new events.
- Admission and actual attempts are each capped at one per second and 30 per
  rolling minute. There is no burst allowance in v1 (stricter than the draft's
  burst-10 ceiling). Overflow/rate pressure drops the new event.
- The monotonic deadline is five seconds from enqueue, including queue time;
  a request gets at most one second or the remaining budget, whichever is less.
- Any HTTP result, network failure, timeout or abort is terminal. A 2xx outcome
  only describes HTTP acceptance, never Synloq delivery/read/processing.
- Queue and epochs are memory-only. Crash, restart, rate drops and ambiguous
  timeouts can lose hints. A later mail transition may emit a new event. No
  delivery guarantee or retry compensation is promised. Delayed old-boot hints
  are distinguishable by boot ID and reservation time.
- Shutdown stops admission, clears the queue/timers, aborts the active request
  and awaits its termination before relay storage closes.

Terminal attempts write a finite stable audit code (`HTTP_nnn`, `TIMEOUT`,
`NETWORK_ERROR`, `ABORTED`) with a constant description. Audit rate is bounded by
actual attempt caps. **No per-drop audit/log record** is emitted. Audit exceptions
are contained. No endpoint, response text, thrown error text or token is logged.

Drop/attempt/failure counters saturate at `Number.MAX_SAFE_INTEGER`. A single
fixed-size file in the existing local state directory is atomically replaced at
most once per ten seconds, plus initialization/final shutdown. Writes do not
overlap or build an unbounded backlog. `synloq doctor` includes this snapshot as
`webhook`; its `observedAt`, boot ID and `stopped` flag describe the last observation,
**not current liveness**. A crash or subsequently disabled exporter can leave an
old snapshot. Missing, oversized or malformed files are ignored. Counters reset
on the next enabled boot. This does not add a relay HTTP endpoint or wire field.

## Explicit non-goals and return triggers

- `allowRemote`: design-approved direction, deferred from v1. Revisit only for
  a concrete remote-export requirement, with SSRF/metadata-blocking, DNS pinning,
  TLS and security review before enabling it. `allowRemote` is rejected now.
- `startup` and `session_rebound`: deferred until a lifecycle-observability
  requirement. Current payload/event filter supports message events only.
- Optional webhook authentication: deferred until a token-file contract is
  approved. Repository rules prohibit raw tokens in configuration/command lines;
  v1 does not accept `token` or send `X-Synloq-Token`.
- `pendingCount`/`oldestAgeMinutes`, multiple endpoints, startup replay, durable
  outbox, external delivery guarantees and live host wake are not provided.

## Validation

Tests exercise strict shared/local config boundaries, endpoint policy, a real
HTTP receiver, redirect refusal, absolute timeout/abort, payload/header hygiene,
post-commit observation, send/reply dedup, observer failure isolation, epoch reset
including delivered-but-unacked messages, cap/audit bounds, shutdown and bounded
doctor snapshots. All tests use synthetic local projects; no operator endpoint,
production configuration, or retained Claude stand is activated by the change.
