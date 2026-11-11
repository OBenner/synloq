# DeepSeek Harness Web Host adapter design

- **Date:** 2026-11-11
- **Status:** approved design, implementation pending
- **Product:** Synloq
- **Target:** an existing ordinary session in an authenticated loopback `dsh web` Host
- **Initial evidence level:** controlled HTTP doubles; live compatibility and active delivery UNVERIFIED

## 1. Purpose and constraints

Add DeepSeek Harness without creating a second agent runtime or confusing SDK-owned sessions with the user's existing visible Web chat. Reuse Synloq identity, durable queues, generation-bound dispatch, heartbeat freshness, receipts, and MCP tools.

The selected boundary is the authenticated Web Host Session Controller API. It exposes exact session identity, passive state, queued prompt admission, and caller-owned request identity. The adapter must never infer compatibility from a product version or treat controlled doubles as live evidence.

## 2. Approaches considered

### 2.1 Authenticated Web Host adapter — selected

Use Node's built-in `fetch` against a loopback `dsh web` Host. This fits the existing `DeliveryAdapter` and `HttpAdapterRunner` contracts and adds no runtime dependency.

Advantages are exact visible-session addressing, passive state reads, queue-only submission, and Host-side request deduplication. The principal limitation is that the Web wire format can change between Harness releases, so strict runtime validation and live acceptance are mandatory.

### 2.2 SDK JSON-RPC runtime — rejected for visible delivery

The SDK can open, resume, prompt, and observe sessions in its own composed Harness runtime. That is useful for automation but does not prove attachment to the already open Web UI chat. Starting an SDK runtime as a replacement would violate Synloq's visible-session requirement.

### 2.3 In-process Cordis plugin — rejected for this increment

A plugin could call Host services directly, but would couple Synloq to Cordis composition, plugin loading, service lifecycle, and release-specific internals. It would not provide the simplest reusable adapter for the current codebase.

### 2.4 MCP inbox only — viable fallback, not the selected active increment

The existing six MCP tools remain available without active delivery. Inbox-only operation is the fallback when activation is absent or compatibility fails, but it does not satisfy the goal of actively admitting a message to an idle visible chat.

## 3. Scope and non-goals

In scope:

- strict `kind: "deepseek-harness"` standalone configuration;
- authenticated loopback Web Host connection and strict unary RPC decoding;
- exact ordinary-session/project binding;
- passive state reporting with bounded polling and reconnect backoff;
- queue-only prompt admission with stable request identity;
- fail-closed one-message acceptance and later operator activation;
- existing MCP inbox documentation and a live acceptance matrix.

Out of scope:

- DeepSeek Desktop attach or pairing;
- SDK-owned, headless, hidden, replacement, or newly created chats;
- explicit `session/create`, `session/fork`, `session/cancel`, queue edits, steering, approvals, permission changes, or model changes;
- a Cordis plugin, dashboard, remote Host, new runtime dependency, publication, or release;
- native Harness provenance claims beyond Synloq's visible framed message text.

## 4. Configuration and secrets

Extend the existing common adapter fields with:

```json
{
  "version": 1,
  "kind": "deepseek-harness",
  "project": "verdicta",
  "projectRoot": "/absolute/project",
  "agentId": "cto",
  "sessionId": "session-visible-cto",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token",
  "protocolVersion": 1,
  "hostUrl": "http://127.0.0.1:3080",
  "hostTokenPath": "/secure/dsh-web-launch.token",
  "heartbeatIntervalMs": 1000
}
```

`hostUrl` uses the same HTTP loopback-only rule as the relay. `hostTokenPath` is resolved relative to the adapter configuration, must name a non-empty file, and is distinct from the Synloq role `credentialPath`. Neither token may be inline in JSON, URLs committed to Git, logs, errors, or reports.

Optional `activationVerifiedAt` and `acceptanceMessageId` follow the existing Claude acceptance model and are mutually exclusive. With neither field, registration reports `activeDelivery:false`. `stateReporting:true` and `clientIdempotency:true` describe the actual Host mechanisms even while active delivery is inactive.

The launch token is exchanged once per adapter connection through:

```text
GET /connect?token=<launch-token>&interactions=none
```

The client expects the documented 302 and signed API cookie, does not follow the redirect, and retains only the cookie in memory. It does not persist the cookie or exchange the token per poll. A 401 invalidates the cached cookie and permits one serialized re-authentication before retrying a read. Prompt submission is never automatically repeated after an arbitrary HTTP failure except through the normal Synloq uncertain-outcome path with the same Harness `requestId`.

Harness currently documents no logout for this cookie and may retain an unused API Peer until Host shutdown when no API socket attaches. The adapter therefore creates at most one API Peer per authenticated connection generation and never claims that closing Synloq revokes the Host cookie or closes the visible chat.

## 5. Strict Web RPC boundary

Use a fresh transport `rpcId` for every unary request:

```json
{
  "type": "client-request",
  "rpcId": "fresh-transport-id",
  "method": "session/state",
  "payload": {
    "args": {
      "request": { "sessionId": "session-visible-cto" }
    }
  }
}
```

The response must be a bounded JSON `server-response` with the same `rpcId` and a discriminated `result` union. HTTP 200 does not imply business success. Unknown/malformed envelopes, mismatched IDs, oversized bodies, invalid state values, and unexpected successful payloads fail closed. Remote error messages and response bodies are not copied into Synloq diagnostics; only a bounded allowlisted error code may be retained for classification.

Only these methods are implemented:

```text
session/list
session/state
session/prompt
```

Default request and authentication timeouts are five seconds and injectable in tests. Bodies are capped at 1 MiB by default; an oversized `session/list` is an explicit unsupported/unknown condition rather than an unbounded read. No streaming endpoint, WebSocket, history read, transcript parsing, or `session/search` is required.

## 6. Visible-session binding

Before Synloq registration, `session/list` must contain exactly one row satisfying all of:

- `sessionId` exactly equals configuration;
- the row is not a subagent and has no subagent origin/ownership marker;
- `cwd` is present and resolves to the same canonical directory as `projectRoot`;
- the payload passes strict validation.

Canonical path comparison uses real paths and platform-appropriate case handling, never string-prefix matching. A missing, duplicate, subagent, wrong-directory, or malformed binding rejects startup before Synloq registration or Host mutation. The same binding is revalidated after a connection failure and immediately before prompt submission.

No title-based addressing is allowed. The adapter does not create a session when the configured ID is absent. `session/list` and `session/state` are passive reads and must not be replaced with an activating endpoint.

## 7. State model and heartbeat

Poll `session/state` at the configured heartbeat interval, defaulting to 1000 ms. Consecutive failures use bounded backoff and force `unknown`. A cached idle observation older than five seconds is also `unknown`; existing Synloq lease and effective-state checks remain authoritative.

Map the passive Host state as follows:

| Host observation                                                                                                                                                  | Synloq state |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `active:false`, `running:false`, `queue:null`, empty `pendingInput`                                                                                               | `closed`     |
| `active:true`, `running:true`                                                                                                                                     | `busy`       |
| `active:true`, non-empty Host queue                                                                                                                               | `busy`       |
| non-empty `pendingInput`                                                                                                                                          | `busy`       |
| `active:true`, `running:false`, empty queue, empty `pendingInput`                                                                                                 | `idle`       |
| `active:false` with `running:true` or `queue !== null`; missing session, changed binding, malformed response, transport failure, or any other contradictory state | `unknown`    |

A non-empty queue is busy even when `running:false`, so Synloq does not overtake existing Host work. Pending approval/question/other input is not treated as an idle invitation. The heartbeat loop reports current state through the existing relay client. Close aborts polling, awaits queued reports, and closes only the Synloq registration; it does not cancel or close the Harness session.

## 8. Prompt admission and retries

Submission requires all of the following:

1. the configured production activation or the exact unused acceptance message;
2. the configured generation-bound Synloq session ID and recipient binding;
3. successful exact `session/list` revalidation;
4. fresh `idle` from an immediate passive `session/state` read.

The only mutation is:

```json
{
  "requestId": "<synloq-message-id>",
  "sessionId": "session-visible-cto",
  "mode": "queue",
  "content": [
    {
      "type": "text",
      "text": "<existing frameMessage(message, generation) output>"
    }
  ]
}
```

The Harness `requestId` is exactly the Synloq message UUID and remains stable across retries. It is distinct from the fresh unary transport `rpcId`. The adapter never sends `mode:"steer"`.

A valid `{ accepted:true }` produces a `delivered` Synloq receipt with `clientMessageId` equal to that request ID. Here `delivered` means admitted to the exact visible Host session inbox, not model execution, completion, agreement, or acknowledgement. The visible team provenance is the existing `frameMessage` project/sender/message/thread/generation text. Harness records an owner `user-rpc` source; Synloq must not claim a native non-user provenance category.

Definite semantic rejection is retryable without a delivered receipt. A timeout, connection loss, malformed success response, or other uncertain result raises `DELIVERY_UNCERTAIN`. Because both the adapter and registered session retain `clientIdempotency:true`, the ordinary runner may retry with the same request ID; Host deduplication covers queued, claimed, and logged first insertion. A successful result is memoized per Synloq message so an in-process duplicate does not issue another prompt.

## 9. Activation and controlled acceptance

Without activation fields, the adapter still authenticates, binds, reports state, and supports MCP inbox operations, but `activeDelivery:false` prevents dispatch.

With `acceptanceMessageId`, capabilities temporarily permit only that exact message. The first valid acceptance consumes the local allowance after Host admission; ordinary messages before and after it are rejected before Host mutation. Repeating the already accepted message returns its memoized receipt without another Host call. Existing registration acceptance fields preserve the allowance semantics across reconnects.

`activationVerifiedAt` may be added only after the manual matrix in Section 11 passes for the same Host surface, exact visible session, project root, and Synloq protocol. Automated fakes, a successful `session/list`, a version string, or an accepted controlled test alone do not justify production activation.

## 10. Non-atomic active-to-cold race

The Web API has no compare-and-submit operation that proves the session is still active at the instant of prompt admission. `session/prompt` itself may resume an ordinary cold session.

The adapter never explicitly calls resume/create and requires `active:true` immediately before prompt. Nevertheless, an active-to-cold transition between the passive read and prompt can cause Harness to resume the exact already validated session. This residual race cannot be eliminated by polling and must be documented and exercised during live acceptance. It must not be described as an atomic idle guarantee. The exact session/project fence still prevents selecting or creating a replacement chat; queue mode still prevents steering a running turn.

If live evidence shows this race can affect a genuinely closed or replaced visible session in a way that violates Synloq semantics, production activation remains disabled and the adapter falls back to inbox/state reporting.

## 11. Testing and acceptance

### 11.1 Controlled tests

- Strict configuration, separate Host token loading, loopback enforcement, and activation-field exclusivity.
- `/connect` redirect/cookie handling, no token leakage, serialized re-authentication, timeouts, body limits, and RPC ID validation.
- Exact ordinary-session/project binding and rejection of absent, duplicate, subagent, wrong-cwd, and malformed rows.
- Every state mapping, stale idle, reconnect unknown, non-empty queue, pending input, and close behavior.
- No Host mutation without activation, exact one-message acceptance, production activation, wrong-session rejection, and fresh idle checks.
- Exact queue payload and stable request ID, memoized receipts, definite rejection, uncertain retry, and Host deduplication.
- Standalone composition with existing runner and registration, generation mismatch rejection, heartbeat, shutdown, and unchanged other adapters.
- Static proof that production code contains no create/fork/steer/cancel/updateQueue/approval/permission/model/history methods.
- Full `pnpm verify`, package-content inspection, and built CLI smoke checks.

### 11.2 Required live matrix

On an operator machine with a real `dsh web` Host:

1. Record Host version/surface, loopback URL, exact visible ordinary session ID, canonical cwd, and Synloq protocol. Keep launch/role tokens and evidence outside Git.
2. Start without activation. Verify state-only registration, all six MCP tools, durable inbox behavior, and zero Host prompt calls.
3. Exercise idle, running, queued input, approval/question pending, cold/reconnected, wrong-session, wrong-project, and Host restart observations.
4. Run one controlled acceptance message. Verify the exact visible chat displays the framed provenance, no busy turn is steered, and acceptance means admission rather than completion.
5. Repeat the same request ID after an induced uncertain response and inspect the visible log/queue for exactly one admission.
6. Exercise close/reconnect and the documented active-to-cold race without creating or replacing a chat. Record any unsupported wire shape as UNVERIFIED.
7. Only after all applicable checks pass, replace the acceptance field with the actual activation timestamp for the same binding. Otherwise keep active delivery disabled.

Live DeepSeek Harness remains UNVERIFIED until this procedure is actually executed. No automated test or successful controlled double upgrades that status.

## 12. Research basis

Checked on 2026-11-11:

- Official Session Controller contract: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md
- Official Session Controller implementation and types: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/api/session-controller/src
- Official Connection authentication and trust contract: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md
- Official SDK server boundary: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md
- Official first-plugin guide: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md
- Operational Desktop/API limitation discussion, not treated as a stable API guarantee: https://github.com/deepseek-ai/deepseek-harness/discussions/10956

Harness is a developer preview and warns about compatibility-breaking changes. Main-branch documentation and source describe the intended contract, not evidence about an installed operator release. Strict decoding and the live matrix are required.
