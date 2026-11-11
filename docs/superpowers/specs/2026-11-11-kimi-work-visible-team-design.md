# Synloq generic visible team for Kimi Work

- **Date:** 2026-11-11
- **Status:** visible delivery implemented and live-verified; generic initialization pending
- **Product:** Synloq
- **Initial example:** CTO and Architect; the implementation must support arbitrary configured roles
- **Verified host fact:** an authenticated local-control `conversations.send` call created a real visible turn and assistant response in the existing Architect chat on 2026-11-11

## 1. Product goal

A user installs Synloq, runs initialization, describes the roles they need, and obtains a team of ordinary visible Kimi Work chats. Each role has its own instructions, authenticated MCP channel, and stable binding to one visible conversation. Roles can ask questions, delegate bounded tasks, and return results without the operator copying messages between chats.

CTO and Architect are examples used by the current test stand. They must not be hard-coded as the only supported roles, and chat titles must not become the permanent addressing mechanism.

The human remains able to inspect and steer every conversation. Synloq does not create a second hidden agent runtime or turn an MCP `stored` result into a claim of visible delivery.

## 2. Approaches considered

### 2.1 Generic init plus stable host bindings — selected

Use one initialization engine behind both an interactive CLI and a natural-language Kimi dialogue. Create or select visible chats, persist their exact `conversationKey` values, generate per-role credentials and MCP channels, and run delivery bridges inside the installed plugin.

This gives the user one coherent setup flow and does not depend on role names, title matching, manual credentials, or manually copied conversation IDs.

### 2.2 Title-based zero-configuration discovery — rejected

Matching arbitrary role names to chat titles is ambiguous after renaming, duplication, localization, or reuse of another workspace. It is unsuitable as the permanent identity boundary.

### 2.3 Standalone per-role adapter configuration — rejected for the user-facing flow

A separate adapter process and hand-written JSON for every role make setup unnecessarily difficult. The existing role MCP process already has the correct credential and lifecycle and can own the corresponding host bridge.

### 2.4 Shared MCP channel with a caller-supplied role — rejected

A shared channel cannot prove which visible chat invoked it and would let one chat claim another role. Per-role authenticated MCP channels remain the isolation boundary, even though host-specific tool exposure still requires separate hardening.

## 3. Initialization user story

### 3.1 Entry points

Both entry points call the same initialization engine and produce the same durable state:

1. `synloq init` starts an interactive terminal wizard.
2. In an ordinary Kimi chat, the user asks to initialize Synloq. The agent asks the same questions using the host interaction mechanism and invokes the non-interactive engine with confirmed values.

The engine also supports explicit arguments for automation and tests. Neither entry point requires the user to edit adapter JSON.

### 3.2 Role definition

The wizard asks for the project and one or more roles. For each role it collects:

- a short stable agent ID;
- a display name;
- the role's responsibility and boundaries;
- optional user additions to the generated instructions.

The agent may draft a fuller role instruction from a short description, but the user confirms it before initialization. Role IDs are validated by the existing domain rules. Duplicate role IDs and duplicate chat ownership are rejected.

### 3.3 Visible chat creation

On Kimi Work, initialization probes the authenticated loopback local-control API. For each unbound role it attempts `conversations.create` with:

- `origin: "client"`;
- `activate: false`;
- the canonical project `workspacePath`;
- common Synloq rules and the confirmed role instructions in `clientInstructions`.

The returned exact `conversationKey` is persisted before active delivery is enabled. The initial role card may be sent to the chat so the user can identify it, but the title is never used as its address.

Creating a chat must not switch the operator's current chat. No hidden, headless, SDK-owned, or replacement runtime is accepted as a substitute.

If creation is unsupported or fails safely, initialization lists eligible existing visible client conversations and lets the operator select one per role. If no suitable chats exist, it asks the operator to create them and repeats discovery. Raw IDs are never required from the operator.

### 3.4 Channel generation and readiness

Initialization creates or updates:

- the project manifest;
- per-role credentials stored outside Git;
- per-role MCP configuration;
- the role-to-`conversationKey` binding store;
- the local plugin's generated MCP server entries and role instructions.

The same installation/update path is used for the personal plugin. If Kimi Work cannot hot-reload the generated channels, the operator receives one explicit reload/restart instruction. Synloq must not report readiness until the role channels and bindings are actually usable.

Initialization finishes with a controlled question and response between two selected roles. The evidence must include the visible target turn, its Synloq message ID and thread ID, and the response. A relay-only `stored` result is insufficient.

## 4. Runtime architecture

```text
Role MCP process
  ├── six authenticated Synloq tools
  ├── shared relay connection
  └── Kimi Work host bridge
        ├── exact binding and metadata validation
        ├── idle/busy heartbeat
        ├── nextDelivery → conversations.send
        └── receipt / reconciliation / quarantine
```

The host bridge uses the existing `DeliveryAdapter` and `HttpAdapterRunner` contracts and the existing message framing with project, sender, message ID, thread ID, and registration generation. Relay message semantics and the six tool names remain unchanged.

The bridge starts and closes with its role MCP process. Closing Synloq does not close the visible chat or the Kimi daemon.

### 4.1 Automatic relay lifecycle

The user does not run `synloq serve` manually. Role MCP processes coordinate one loopback relay for the project:

- the first available process attempts to host the relay;
- other processes use the authenticated existing endpoint;
- port ownership and relay identity are verified rather than assuming that any listener is Synloq;
- if the owner closes, another process takes ownership after a bounded reconnect cycle;
- transient failover sets session state to `unknown`; durable SQLite messages are not deleted or rewritten;
- an unrelated service on the configured port fails closed.

An already running compatible relay, including the current development relay, is reused. No second daemon is started merely because status is ambiguous.

### 4.2 Local-control discovery

The plugin discovers standard Kimi Work installation paths automatically. On non-standard installations, documented environment overrides may identify the executable, runner CLI, and configuration without adding required role JSON fields.

The bridge obtains the dynamic loopback WebSocket endpoint and development token through `status --json`. The token is retained only in memory and is never placed in role JSON, URLs committed to Git, logs, errors, receipts, or reports. Only loopback WebSocket endpoints are accepted.

The initial implementation uses the `ws` runtime dependency and its type package. No Python helper is required in production.

Local-control is an installed-host interface, not assumed to be a stable public API. Every method and response is validated at runtime. An incompatible shape disables active delivery while leaving MCP inbox available.

## 5. Stable binding and state reporting

A role binding contains at least:

```text
project + role agent ID + Work agent ID + conversationKey + canonical workspacePath
```

The Work agent ID defaults to `main`. Before registration and immediately before every submission, `conversations.getMetadata` must prove:

- exact conversation and stable session keys;
- `origin: "client"`;
- the configured Work agent ID;
- the same canonical workspace as the initialized project;
- a consistent `kernelSessionId` when present.

A title mismatch alone does not change the binding. Missing, duplicated, wrong-workspace, non-client, or malformed conversations fail closed.

`conversations.getBusy` drives heartbeat state:

- exact metadata plus `busy:false` → `idle`;
- `busy:true` → `busy`;
- transport failure, stale observation, changed binding, or malformed response → `unknown`;
- confirmed deletion of the bound conversation → `closed`.

A bridge never calls `setActive`, creates a replacement chat, changes model or permission settings, or steers a running turn.

## 6. Conversation and task protocol

### 6.1 Lightweight message conventions

The first version uses standardized text frames inside the existing message body rather than a new task database or message-schema migration:

- `QUESTION` — a question requiring a response;
- `TASK` — a bounded assignment with objective, expected result, and scope;
- `RESULT` — changes or findings, executed checks and their real outcomes, and limitations;
- `BLOCKED` — the obstacle and the exact operator or peer input required;
- `NOTICE` — information that does not require a response.

`QUESTION` and `TASK` normally use `expectsReply:true`. Responses and results use `synloq_reply` in the original thread. A task is complete only when an explicit `RESULT` is returned; `stored`, `delivered`, and `acked` are not task completion.

The existing `threadId`, `inReplyTo`, `expectsReply`, idempotency key, inbox, and ack mechanisms remain authoritative. Later structured task types can be added without changing the visible-chat boundary.

### 6.2 Autonomy and operator control

A receiving agent may immediately perform analysis, read code, design, make in-scope local changes, and run relevant local checks. The agent must remain within its role, the delegated scope, project instructions, and host permission settings.

The following require explicit operator approval rather than peer-agent authorization:

- push, merge, publication, external communication, purchases, or paid API use;
- new dependencies;
- deletion of data or evidence;
- changes to secrets, security boundaries, or Synloq role/channel configuration;
- actions outside the workspace;
- any other action prohibited by the project or requiring approval under its rules.

When classification is uncertain, the agent returns `BLOCKED` with a concrete question. Peer instructions never override operator, project, or host rules.

Each thread permits at most eight automatic Synloq hops. A hop is a Synloq message that triggers another role's visible turn; internal model steps and tool calls do not count. At the limit, delivery pauses and the operator is asked to continue or start a new thread. This prevents unattended agent loops without restricting ordinary human messages.

## 7. Submission, receipts, and duplicate prevention

The runner submits only for the exact registered role/session generation and fresh idle state. The bridge revalidates metadata and `busy:false` immediately before calling `conversations.send` with the existing framed message text.

A valid result must contain `accepted:true`, the exact bound conversation and kernel session, and a non-empty host `turnId`. It produces a `delivered` receipt whose `clientMessageId` is that host turn ID. Here `delivered` means admitted as a real user turn to the exact visible conversation. It does not mean model completion, agreement, task completion, reading, or acknowledgement.

The bridge does not automatically ack incoming Synloq messages. The receiving agent acks only after actual reading.

The Work API has no caller-owned send idempotency key. Therefore:

- successful in-process submissions are memoized by Synloq message ID;
- before a first submission, recent visible history is checked for the exact unique Synloq frame;
- after a timeout, disconnect, or malformed success response, the bridge attempts bounded read-only reconciliation through `conversations.getMessages`;
- exactly one matching user turn converts the uncertain result into a delivered receipt using the stable history message/turn identity;
- no match, multiple matches, or inconclusive history produces `DELIVERY_UNCERTAIN` and quarantine, never blind resubmission;
- `clientIdempotency:false` is registered unless a future host operation provides durable deduplication;
- definite busy rejection before admission is retryable through the ordinary runner; mutation requests are never automatically replayed after an ambiguous transport result.

The relay's durable receipt or quarantine state is the persistence boundary across restarts. No direct writes to Kimi SQLite, `wire.jsonl`, or session files are permitted.

## 8. Failure handling and compatibility

- Busy chat: leave the message queued until fresh idle; never steer or interrupt.
- Wrong/missing chat: disable active delivery for that binding and retain inbox.
- Local-control unavailable or incompatible: bounded reconnect with `unknown` state; no replacement chat.
- Token/status failure: sanitized diagnostic without credentials; no daemon restart loop.
- Ambiguous send result: reconcile read-only, then quarantine if unresolved.
- MCP process shutdown: abort polling, close the runner and WebSocket, await bounded cleanup, and close only the Synloq registration.
- Plugin reload: restore bindings from durable state, obtain a new registration generation, and never resurrect an old lease.
- Role receives another role's message: reject before host mutation and report the binding error.

Diagnostics contain IDs, bounded allowlisted codes, and state transitions, not credentials or full private transcripts.

## 9. Testing and acceptance

### 9.1 Controlled tests

- Shared initialization through CLI and dialogue inputs produces identical manifests, bindings, instructions, and generated channels.
- Arbitrary role IDs and descriptions; no CTO/Architect-only branch or title-based permanent addressing.
- Chat creation uses client origin and `activate:false`; attach fallback never switches the active chat.
- Exact workspace/conversation validation and rejection of wrong, duplicate, hidden, or malformed targets.
- Authenticated WebSocket transport, strict JSON-RPC decoding, timeouts, bounded bodies, reconnect, and token redaction.
- Automatic relay ownership, reuse, failover, unrelated-port rejection, and no duplicate relay.
- Busy/idle/closed/unknown mapping and fresh idle revalidation.
- Exact framed `conversations.send`, accepted receipt mapping, no automatic ack, and no `setActive` or permission changes.
- Memoization, timeout reconciliation, no/multiple-match quarantine, restart behavior, and proof that ambiguous sends are not replayed.
- Risk instructions and the eight-hop limit, including operator continuation.
- Existing MCP/relay suites and full `pnpm verify`, formatting, build, package inspection, and CLI smoke checks.

### 9.2 Live acceptance for the current two-role example

Use CTO and Architect only as test data:

1. Initialize through one entry point and repeat equivalent input through the other in an isolated test project.
2. Confirm two ordinary visible chats with persistent role instructions and exact stored bindings; the current operator chat remains active.
3. Start without manually launching a relay or adapter and verify both role channels.
4. Send a real Synloq `QUESTION` from CTO to Architect. Confirm the framed user turn appears in Architect and the response appears in the same thread.
5. Delegate a bounded `TASK`, return a `RESULT`, and verify that no risky action occurs without operator approval.
6. Keep Architect busy and verify that a second message neither steers nor overtakes the active turn.
7. Induce reconnect and an uncertain-send case; inspect the visible history for exactly one admission or an explicit quarantine.
8. Reload the plugin and verify restored bindings, new generation, no duplicate relay, and no automatic ack.
9. Verify the eight-hop stop and operator continuation.
10. Record real results and keep compatibility unverified for any host/version not exercised.

A successful controlled double, a relay `stored` result, or the earlier manual local-control probe alone does not pass this matrix.

## 10. Scope boundaries

In scope: generic roles, shared initialization, visible Kimi Work chats, stable bindings, automatic relay/bridge lifecycle, active delivery, lightweight team rules, and the two-role live example.

Out of scope for this increment:

- DeepSeek, Codex, Gemini, Cursor, or other host implementations;
- a separate task orchestrator, group broadcast, remote relay, dashboard, or hidden background team;
- automatic merge, push, PR publication, approval bypass, or elevated host permissions;
- title-based routing after initialization;
- direct modification of Kimi storage or transcript files;
- a claim that per-role MCP tools are isolated by the host merely because separate credentials exist.

MCP tool exposure per visible chat remains a separate follow-up. The host bridge proves addressed visible delivery, not host-enforced tool isolation.

## 11. Research basis

Observed locally on 2026-11-11:

- `conversations.send` accepted a turn for the exact Architect `conversationKey` and returned host `turnId` `fb9774cd-349c-43ae-8048-821480e6c26c`;
- the Architect session history contained the test user turn and the exact response `SYNLOQ_VISIBLE_OK`;
- the operator confirmed both were visible in the existing Architect chat;
- `conversations.list` returned the CTO and Architect client conversations in the Synloq workspace;
- `conversations.getMessages` exposed role, turn/message identity, and text parts sufficient for bounded reconciliation;
- the installed local-control route table contains `conversations.create`, `getMetadata`, `getBusy`, `getMessages`, and `send`;
- public CLI prompt mode is not a supported way to resume an ordinary Work client conversation and is not used by this design.

These observations describe the installed host only. Runtime validation and the live matrix remain mandatory.
