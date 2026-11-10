# Client compatibility

## Claude Code

**Live verification status: UNVERIFIED.** The automated tests use an in-memory mock MCP client, a mock channel transport, and fake hooks. They verify Synloq's protocol and state handling, not support in any released Claude Code version. No real Claude Code session was launched or activated for this implementation.

### Channel protocol

The low-level MCP server declares both experimental capabilities during `initialize`:

- `claude/channel`
- `claude/channel/permission`

After activation, submission writes `notifications/claude/channel` with this shape:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<synloq project=\"verdicta\" from=\"cto\" message=\"<uuid>\" thread=\"<thread-id>\">\nmessage text\n</synloq>",
    "meta": {
      "project": "verdicta",
      "from": "cto",
      "message": "<uuid>",
      "thread": "<thread-id>"
    }
  }
}
```

A successful notification write produces only `submitted`. It is not visible-session delivery evidence. Only a `UserPromptSubmit` hook for the same configured Claude `session_id`, containing a valid Synloq envelope and its message UUID, produces the `delivered` receipt.

The adapter does not answer permission notifications, auto-approve permission requests, inject hook context, or expand Claude Code's approval policy.

### Activation gate

Active delivery starts disabled. It remains disabled unless all of these conditions hold:

1. The initialized exchange exposes both required experimental capabilities.
2. The operator-created adapter configuration has a non-empty `activationVerifiedAt`.
3. The configuration's `protocolVersion` is Synloq adapter protocol version `1`.
4. The submission's visible session ID exactly matches the configuration's `session_id` / `sessionId`.

The operator must use one of these exact Claude Code activation mechanisms:

- local development: `--dangerously-load-development-channels`;
- managed deployments: the `allowedChannelPlugins` allowlist.

Setting `activationVerifiedAt` is an operator assertion that the required activation mechanism and live behavior were checked for that same Claude session and protocol version. It must not be inferred from a mock test, client name, or client version.

If activation, either capability, or the same-session/protocol check fails, the adapter performs no channel injection. MCP inbox retrieval remains the fallback; it does not claim active delivery.

### Hook state reporting

| Claude hook event                       | Synloq state |
| --------------------------------------- | ------------ |
| `SessionStart`                          | `idle`       |
| `UserPromptSubmit`                      | `busy`       |
| `Stop`                                  | `idle`       |
| `StopFailure`                           | `idle`       |
| `SessionEnd`                            | `closed`     |
| Any other event, including `PreToolUse` | `unknown`    |

Every accepted hook heartbeats its mapped state. Hooks for a different visible session are rejected before heartbeat or receipt reporting. Unknown state is fail-closed for dispatch.

### Required live acceptance procedure

This procedure has **not** been executed as part of the mock-tested implementation:

1. Start the intended Claude Code version with local `--dangerously-load-development-channels`, or configure managed `allowedChannelPlugins` for the Synloq channel server.
2. Record the actual Claude `session_id`, Synloq protocol version, client version, and activation mechanism.
3. Complete MCP initialization and confirm that both experimental capabilities are present.
4. Register the same visible session, observe `SessionStart`, and send one Synloq message while it is freshly `idle`.
5. Confirm that the exact channel notification is admitted to that visible session without steering a running response.
6. Confirm that the notification write alone leaves the message `submitted`, and that only the matching `UserPromptSubmit` hook changes it to `delivered`.
7. Confirm that a permission request still follows the client's existing approval policy and receives no automatic decision from Synloq.
8. Repeat with activation disabled and with each capability absent; confirm zero injections and MCP inbox fallback.
9. Only after these checks pass, record the evidence and set `activationVerifiedAt` for that same session and protocol version.

Until this evidence exists, Claude Code active delivery must remain disabled in operator configuration.

## OpenCode

**Live verification status: UNVERIFIED.** The automated tests use fake normal and v2 SDK clients with controllable event streams. They verify Synloq's queued request, response validation, event handling, reconnect, receipt, and lifecycle behavior against `@opencode-ai/sdk` 1.19.5 types. No real OpenCode server or visible session was launched, and these tests do not establish support in any released OpenCode version.

### Queued prompt admission

Submission calls `v2.session.prompt` with the bound `sessionID`, Synloq-framed prompt text, `delivery: "queue"`, and `resume: false`. There is no steering call path. A successful HTTP exchange alone is not delivery evidence: the response must contain a new `SessionInputAdmitted` inbox entry whose session ID, complete framed prompt, and queued delivery mode match the submission.

A matching entry produces `delivered` with the admitted OpenCode entry ID as `clientMessageId`. The receipt is cached by the Synloq message UUID, so a repeated known message ID returns the original receipt without another prompt. Receipts are created only after response validation, never before the request.

A post-transmission exception, malformed admission response, or response for another session produces `DELIVERY_UNCERTAIN` and disables `clientIdempotency`. The uncertain message cannot be blindly reposted. The dispatcher durably quarantines it as `submitted`, pauses that participant, and requires operator inspection. Known pre-transmission domain rejections remain ordinary retryable failures.

### State, reconnect, and shutdown

| OpenCode observation                      | Synloq state |
| ----------------------------------------- | ------------ |
| Matching `session.status` with `busy`     | `busy`       |
| Matching `session.status` with `idle`     | `idle`       |
| Matching `session.idle`                   | `idle`       |
| Matching `session.deleted`                | `closed`     |
| Initial state, EOF, or unsupported status | `unknown`    |

Only the bound session's status, idle, and deletion events are tracked. EOF invalidates the prior state. Initial subscription, stream reconnect, and `server.connected` require a fresh `session.status({})` read containing the bound session before any idle or busy event is accepted. A missing matching status leaves the session `unknown`, even if a buffered idle event arrives.

`start` runs event and relay-heartbeat loops with exponential backoff bounded between 200 ms and 30 seconds. `close` aborts both loops, reports `closed`, and closes the relay session.

### Required live acceptance procedure

This procedure has **not** been executed as part of the fake-SDK-tested implementation:

1. Record the actual OpenCode version, SDK version, loopback server URL, visible session ID, and Synloq protocol version.
2. Start the adapter against that server and confirm initial status plus matching busy, idle, and deletion observations without accepting another session's events.
3. While the visible session is freshly idle, submit one Synloq message and record the exact queued request with `resume: false` and the returned `SessionInputAdmitted` entry.
4. Confirm that the entry appears in the intended visible session with complete provenance and that the admitted entry ID produces exactly one delivered receipt on repeated submission.
5. While a response is running, confirm that Synloq performs no submission and never steers it; after a fresh idle observation, confirm that queued admission drains in FIFO order.
6. Interrupt and reconnect the event stream. Confirm `unknown` state and zero delivery until a fresh status read contains the bound session; repeat with `server.connected`.
7. Inject a post-transmission transport failure. Confirm `DELIVERY_UNCERTAIN`, durable quarantine and participant pause, disabled client idempotency, no automatic repost, and the need for operator inspection.
8. Close the adapter and confirm that event and heartbeat activity stops and the relay session becomes `closed`.

Until equivalent evidence is recorded, OpenCode support must remain described as mock-tested and live-unverified.
