# Synloq Plugin Design

- **Date:** 2026-11-09
- **Status:** draft for user review
- **Product:** Synloq
- **Repository:** `synloq`, independent of Verdicta
- **CLI / MCP server:** `synloq`
- **Scope:** local communication between existing visible role-based agent chats

## 1. Context

A project has multiple visible chats, each with its own role, instructions,
runtime settings, and responsibility. Examples include CEO, CTO, Architect,
Developer 1, and Tester. The chats may run in Kimi Code, OpenCode, or Claude
Code.

GitHub Issues provide durability but are too slow for operational
agent-to-agent communication. Copying messages between chats requires human
work and loses the sender/recipient structure.

Synloq is a separate local plugin, not a Verdicta core subsystem. It lets
existing chats address one another directly while leaving role decisions and
work management to the chats themselves.

## 2. Goals

1. One shared implementation for multiple MCP-capable chat clients.
2. Each visible chat connects as a specific project participant.
3. A chat can send a direct message or reply without human copying.
4. An idle open chat receives messages actively.
5. A busy chat is never interrupted or steered by an incoming message.
6. A closed chat receives its pending messages after reconnecting.
7. Messages, threads, and acknowledgements survive Synloq restarts.
8. Incoming agent messages remain visibly distinct from local user input.

## 3. Non-goals

The first version does not include:

- task management, task statuses, dependencies, or automatic assignment;
- deadlines, escalation, or workflow orchestration;
- a dashboard or Web UI;
- group chats, broadcast channels, or public rooms;
- attachments or secret transfer;
- remote network access or multi-machine delivery;
- role creation, system-prompt management, or replacing client instructions;
- automatic GitHub synchronization, merge, or push;
- guaranteed active delivery on a client whose adapter has not passed the
  delivery contract tests.

## 4. Architecture

```text
Role chat A                 Role chat B
Kimi/OpenCode/Claude        Kimi/OpenCode/Claude
      │                           │
      ├──────── shared MCP ───────┤
      │                           │
      └──────────┬────────────────┘
                 │
          ┌──────▼───────┐
          │    Synloq    │
          │ identity     │
          │ routing      │
          │ FIFO queues  │
          │ deduplication│
          └──┬────────┬──┘
             │        │
       ┌─────▼──┐  ┌──▼────────────────┐
       │ SQLite │  │ Delivery adapters │
       └────────┘  │ Claude/OpenCode/  │
                   │ Kimi/reference    │
                   └───────────────────┘

                 Operator CLI
```

### 4.1 Synloq

Synloq is a local process bound to loopback. It owns message persistence,
routing, per-recipient queues, idempotency, and adapter dispatch. It contains
no LLM calls and no task workflow.

### 4.2 Shared MCP interface

All clients use the same MCP tools for sending and reading messages. MCP is
not assumed to provide portable push delivery. Active delivery is a separate
adapter capability.

### 4.3 Client delivery adapters

An adapter maps a registered `agentId` to a concrete client session, reports
session state when the client exposes it, and submits pending messages through
the client-supported mechanism.

During registration, Synloq and the adapter negotiate a `protocolVersion` and
exchange an explicit capability set, including active delivery, session-state
reporting, and client-side idempotency. An incompatible protocol version is an
explicit registration error. A missing optional capability disables only the
corresponding behavior. Capabilities are detected at runtime, never inferred
from the client name or version alone.

Adapters are optional per client. A client without a working active-delivery
adapter can still use MCP inbox operations, but must not be reported as
supporting active delivery.

### 4.4 Operator CLI

The CLI provides local diagnostics and manual operation: list participants,
inspect queues and threads, send a message as the operator, and pause or resume
active delivery for a project, participant, or thread. It is not a dashboard
and does not implement a second routing or storage layer.

`synloq doctor` reports storage health, registered participants, negotiated
protocol versions and capabilities, adapter connectivity, last heartbeat, and
the concrete reason active delivery is unavailable. It does not print message
bodies or credentials by default.

## 5. Project registry and identity

A versioned project manifest contains participant identities and short role
descriptions:

```yaml
project: verdicta

agents:
  ceo:
    title: CEO
    role: Product goals and priorities
  cto:
    title: CTO
    role: Technical strategy and architecture
  arch:
    title: Architect
    role: ADRs and architectural review
  developer-1:
    title: Developer 1
    role: Implementation
  tester:
    title: Tester
    role: Independent verification
```

The operator configures each chat once with `project` and `agentId`. For
example, the CTO chat connects as `project=verdicta`, `agentId=cto`.

The manifest informs routing and participant discovery. It does not replace
the chat's existing role instructions.

Each chat connection also receives a local credential stored outside the
repository. Synloq derives the sender from the authenticated connection rather
than trusting a model-supplied `from` field. The credential prevents accidental
cross-wiring and casual impersonation on the local machine; it is not a
security boundary against a malicious machine administrator.

At most one distinct visible client session may be actively bound to a
`(project, agentId)` pair. A second session claiming that identity is rejected
unless the operator explicitly replaces the previous binding. Separate MCP and
adapter connections belonging to the same bound session share its credential
and identity. Reconnecting restores that binding and its pending queue without
creating a second participant.

## 6. Message model

A direct message contains:

```text
id, threadId, from, to, text,
expectsReply, inReplyTo, createdAt, idempotencyKey
```

- `id` is generated by Synloq and is unique per message.
- `threadId` groups an initial message and its replies.
- `from` is the authenticated project participant.
- `to` is one explicit `agentId`; role broadcasts are not supported.
- `text` is plain text limited to 32 KiB per message.
- `expectsReply` expresses the sender's intent but creates no workflow.
- `inReplyTo` references the parent message for a reply.
- `idempotencyKey` is supplied by the sender and makes retries safe after an
  uncertain client result.

Messages may include references in plain text, but the first version has no
attachment channel.

## 7. MCP tools

| Tool           | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `synloq_list`  | List project participants and role descriptions |
| `synloq_send`  | Send a direct message to one participant        |
| `synloq_reply` | Reply in an existing thread                     |
| `synloq_inbox` | Read pending or historical incoming messages    |
| `synloq_wait`  | Optional fallback: wait for an incoming message |
| `synloq_ack`   | Acknowledge receipt of a message                |

`synloq_wait` is not the primary delivery mechanism when an active adapter is
available. A long-poll timeout is a normal result, not a delivery failure.

An acknowledgement means that the recipient has read the message. It does not
mean agreement, task completion, or verification of a result.

## 8. Active delivery semantics

The selected policy is **always queue; never steer**.

### 8.1 Recipient states and liveness

An adapter reports one of four states when it can:

- `idle`: the session is open and no response is running;
- `busy`: the session is open and a response is running;
- `closed`: the session is not currently open;
- `unknown`: the adapter cannot reliably determine the state.

Each adapter registration holds a short-lived lease renewed by heartbeats and
fresh state reports. When the lease expires or the state becomes stale, Synloq
marks the recipient `unknown`. A previously observed `idle` state is never
sufficient for later injection. A heartbeat proves adapter liveness only; the
client must separately report whether the visible session is idle or busy.

### 8.2 Dispatch rules

```text
idle    → submit the next pending message immediately
busy    → retain it in the FIFO queue until the client reports idle
closed  → retain it in SQLite until session startup or reconnect
unknown → do not attempt active injection; retain it as pending
```

Synloq and adapters never use steering to insert a team message into a running
response. A pending message may initiate a new response only when the
recipient is known to be idle.

An operator pause is an independent delivery gate, not another session state.
While a project, participant, or thread is paused, active injection stops and
messages remain stored. Resuming triggers normal dispatch only when the
current recipient state is `idle`.

Messages for one recipient are delivered in FIFO order. A failure does not
allow a later message to overtake the failed one.

### 8.3 Client mechanisms

- **Claude Code:** during MCP `initialize`, the channel adapter declares both
  experimental capabilities `claude/channel` and
  `claude/channel/permission`. Active injection uses
  `notifications/claude/channel` with `{ content, meta? }`. The client must
  load the server through `--dangerously-load-development-channels` for local
  development or the managed `allowedChannelPlugins` allowlist. If either
  capability is missing or activation has not been verified for the running
  client, the adapter performs no injection and uses MCP inbox fallback. The
  permission
  channel cannot expand the client's existing approval policy.
- **OpenCode:** use `session.prompt` with `delivery=queue`; never use
  `delivery=steer` for team messages.
- **Kimi Code:** evaluate an ACP adapter using `session/resume` and
  `session/prompt`. Active-delivery support is declared only after a prototype
  proves safe interaction with an already open TUI session. Otherwise the
  adapter falls back to session-start/Stop hooks where applicable and MCP
  inbox retrieval, without claiming instant delivery.
- **Reference adapter:** a deterministic fake client implements the complete
  contract for tests without launching a model or a third-party client.

### 8.4 Delivery states

```text
stored → submitted → delivered → acked
```

- `stored`: Synloq committed the message to SQLite;
- `submitted`: a client adapter accepted it into its local pending path;
- `delivered`: the client admitted it to the intended visible session;
- `acked`: the recipient explicitly acknowledged reading the message.

A submission, delivery receipt, or acknowledgement is not evidence that the
agent agreed with or acted on the content.

## 9. Persistence and failure handling

The project manifest is versioned in the repository. Runtime messages,
queues, delivery receipts, and cursors live in one local SQLite file outside
Git, keyed by project identity. Runtime state does not dirty worktrees.

Synloq is the single writer. Message creation and its initial delivery record
are committed in one transaction.

- Repeating a send with the same `idempotencyKey` returns the original result
  without creating a duplicate.
- After a Synloq restart, pending queues and cursors are restored from SQLite.
- After a client reconnect, pending messages are drained in FIFO order.
- A timeout or transport error with an uncertain submission result is retried
  only with the same message identity and client-side idempotency support.
- Transient adapter failures use bounded backoff. State transitions and
  reconnects trigger further delivery attempts rather than a tight retry loop.
- Configurable per-sender and per-recipient rate and burst limits reject
  excessive sends with an explicit error before any state change.
- Each recipient queue has configurable pending-message count and byte limits.
  Exceeding either limit rejects the new message with explicit backpressure
  while preserving the existing queue.
- Synloq never generates agent replies. A configurable per-thread rate guard
  detects rapid cyclic exchanges and pauses active delivery for that thread.
  Only the operator can resume it; the guard changes no message content or task
  status.
- Unknown recipients, invalid manifests, malformed messages, and oversized
  text are rejected before any state change.
- If SQLite is unavailable or corrupted, Synloq rejects state changes and
  reports an explicit error. It never falls back to memory-only delivery.

## 10. Trust and safety

- Synloq listens on loopback only.
- Message text is untrusted external data, never Synloq configuration or an
  instruction to bypass the receiving client's approval policy.
- The receiving client renders or injects the message with explicit team
  provenance, including sender, project, and message ID.
- A team message has no elevated permission and cannot approve tools, change
  roles, alter the manifest, or expand network access.
- Only the operator can change participant registration, credentials, client
  adapter configuration, delivery limits, and pause/resume gates. These
  operations are not exposed through agent-facing MCP tools.
- Runtime credentials and SQLite contents are excluded from Git.
- Logs contain message IDs and participant IDs, not message bodies by
  default.

## 11. Testing and acceptance

### 11.1 Unit and storage tests

- participant registration and authenticated sender identity;
- rejection of duplicate active identities and operator-only replacement;
- direct routing, replies, and thread preservation;
- idempotent sends and acknowledgements;
- FIFO ordering per recipient;
- state-dependent dispatch for `idle`, `busy`, `closed`, and `unknown`;
- lease expiration and heartbeat loss forcing `unknown`;
- operator pause/resume gates for projects, participants, and threads;
- rate, burst, queue-limit, and cyclic-thread protections;
- persistence across Synloq restart, including pause gates and delivery state;
- rejection of malformed and oversized messages;
- fail-closed behavior for storage failures.

### 11.2 Adapter contract tests

Every adapter claiming active delivery must pass the same scenarios:

1. negotiate the protocol version and capabilities, rejecting incompatibility;
2. register a unique visible session and report its state;
3. deliver to an idle session without user copying;
4. hold a message while the session is busy;
5. never steer or interrupt a running response;
6. drain pending messages after reconnect;
7. preserve team provenance in the receiving session;
8. deduplicate a retried submission;
9. preserve FIFO order after a failed delivery;
10. stop injection when the heartbeat lease expires;
11. report unsupported or unknown capabilities honestly.

The Claude Code adapter additionally has mock-MCP tests for the exact
`initialize` capabilities and channel-notification shape, plus a test proving
inbox fallback when activation or either capability is absent. Active support
also requires a documented manual test against a real Claude Code session
started with the required development-channel or managed-allowlist setting.

### 11.3 End-to-end acceptance

Two distinct visible chats with different roles exchange a question and a
reply through different supported client adapters without human copying. The
following behavior is observed:

- the sender can continue its own work after sending;
- an idle recipient starts processing the incoming message;
- a busy recipient finishes its current response before receiving it;
- a closed recipient receives the message after reconnecting;
- both participants can retrieve the same thread and message IDs;
- Synloq restart loses no pending message and creates no duplicate;
- incoming content receives no additional tool or approval privileges.

Client support is declared individually. The existence of an adapter or a
successful reference test is not evidence that a real client works.

## 12. Future extensions

A read-only or interactive dashboard, group channels, GitHub references with
structured metadata, and additional clients can be added over the same Synloq
API. These are separate iterations and do not change the first-version
message or queue semantics.
