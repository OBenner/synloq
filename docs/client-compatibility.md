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

### Standalone composition

The visible Claude chat launches `node dist/cli/main.js adapter --config <path>` as its stdio channel child. The relay never launches a hidden replacement chat. That one channel connection exposes the six ordinary Synloq MCP tools and the Claude channel notification protocol. The standalone process authenticates its external per-role credential, verifies the configured project/role, registers the exact visible session after initialization, polls the ordinary HTTP delivery path, and closes its delivery loop and relay session on shutdown.

Hooks invoke `node dist/cli/main.js claude-hook --config <path>` with the same strict external JSON configuration. The config contains no inline token, permits only loopback HTTP URLs, and requires adapter protocol `1`. The README and `test/e2e/real-clients.md` give complete commands and examples.

### Activation gate

Active delivery starts disabled. Ordinary production submissions remain disabled unless all of these conditions hold:

1. The initialized exchange exposes both required experimental capabilities.
2. The operator-created adapter configuration has a non-empty `activationVerifiedAt`.
3. The configuration's `protocolVersion` is Synloq adapter protocol version `1`.
4. The submission's visible session ID exactly matches the configuration's `session_id` / `sessionId`.

For local development, the custom channel is explicitly selected as `server:synloq` with `--dangerously-load-development-channels server:synloq`. A bare flag or presence in `.mcp.json` is not activation evidence. Managed deployments require `channelsEnabled:true`, a packaged plugin in `allowedChannelPlugins`, and an explicit `--channels plugin:<name>@<marketplace>` selection. This MVP does not package Synloq as a managed plugin, so the managed path is also UNVERIFIED.

Setting `activationVerifiedAt` is an operator assertion that the required activation mechanism and live behavior were checked for that same Claude session and protocol version. It must not be inferred from a mock test, client name, or client version.

A separate controlled-acceptance field, `acceptanceMessageId`, resolves the evidence circularity without treating `activationVerifiedAt` as a bypass. When production verification is absent, the adapter permits only the configured message UUID and only once, while all capability, protocol, same-session, and fresh-idle requirements still apply. A successful notification write consumes the acceptance and disables further active delivery. Ordinary messages before or after that probe remain disabled. The strict external config rejects configurations containing both activation fields.

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

1. Record the actual Claude `session_id`, Synloq adapter protocol version, MCP protocol revision, client version, and activation mechanism. Start the intended visible session with the exact `server:synloq` development channel command, or separately verify a packaged managed plugin path.
2. Start with both activation fields absent. Complete MCP initialization, confirm both experimental capabilities and exactly six ordinary tools, register the same visible session, and confirm zero active injections with MCP inbox fallback.
3. While delivery is disabled, send one probe and record its relay-generated UUID. Stop the channel, set only `acceptanceMessageId` to that UUID, and restart the same visible session and channel.
4. Observe fresh idle state and confirm that exactly the configured notification is admitted once to that visible session without steering a running response. Confirm that a different message receives no injection.
5. Confirm that the notification write alone leaves the message `submitted`, and that only the matching `UserPromptSubmit` hook changes it to `delivered`.
6. Confirm that a permission request still follows the client's existing approval policy and receives no automatic decision from Synloq.
7. Repeat with activation disabled and with each capability absent; confirm zero injections and MCP inbox fallback.
8. Record the actual output and observed client behavior. Only after these checks pass, remove `acceptanceMessageId` and set `activationVerifiedAt` for that same session and protocol version.
9. Restart the same visible session with verified production configuration and repeat an ordinary submission. If evidence is missing or a check fails, remove both fields and leave support UNVERIFIED.

Until this evidence exists, Claude Code active delivery must remain disabled in ordinary operator configuration. The complete executable matrix is `test/e2e/real-clients.md`.

## Codex

**Support: authenticated MCP inbox plus lifecycle state reporting. Live verification status: UNVERIFIED. Active delivery: unsupported and disabled.** Automated tests use a mocked relay, fake hook input, and fake app-server processes. No Codex executable or visible Codex chat was launched in the implementation environment.

The existing stdio MCP bridge exposes exactly the six ordinary Synloq tools. One Codex configuration scope, normally one `CODEX_HOME`, represents exactly one Synloq role credential. Configuring several role servers in one shared Desktop/CLI scope is not an approved multi-role setup because per-thread role identity has not been demonstrated. Shared Desktop multi-role binding remains UNVERIFIED.

The separate strict adapter JSON uses `kind:"codex"`, the exact visible `session_id`, an external role credential, loopback relay URL, and protocol `1`. `synloq codex-hook --config <path>` rejects malformed or oversized input and a different session ID before relay mutation. On `SessionStart` it registers with `activeDelivery:false`, `stateReporting:true`, and `clientIdempotency:false`. Generic `synloq adapter --config` rejects Codex explicitly; there is no Codex active runner, production activation field, or active-delivery acceptance flag.

### Hook state reporting

| Codex observation                                           | Synloq state |
| ----------------------------------------------------------- | ------------ |
| `SessionStart` with `startup`, `resume`, `clear`, or `fork` | `idle`       |
| `SessionStart` with `compact`                               | `busy`       |
| `UserPromptSubmit`                                          | `busy`       |
| `PreModelRequest`                                           | `busy`       |
| `Stop`                                                      | `idle`       |
| `Interrupt`                                                 | `unknown`    |
| `SessionEnd`                                                | `closed`     |
| Valid but unsupported event or `SessionStart.source`        | `unknown`    |
| Missing or malformed event envelope                         | rejected     |

`Interrupt` does not prove that turn cleanup finished. `PostModelRequest` is not idle evidence because tools or another model attempt may follow. Subagent events do not make the parent idle. Hook stdout is empty: Synloq emits no `additionalContext`, continuation, permission decision, or message delivery. Existing lease and state-freshness rules still bound heartbeat freshness.

### Read-only app-server compatibility probe

Run from the Synloq repository with Node 24:

```bash
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path --thread-id REPLACE_WITH_VISIBLE_THREAD_ID
```

The first command collects executable version, app-server help/schema availability, and sanitized initialize metadata without resuming a thread. The second explicitly opts into only `thread/resume` and `thread/read` for the configured ID. A missing or mismatched resumed ID, writer conflict, or read failure is recorded without retry. No thread is synthesized and no prompt, turn, steering, approval, configuration, or one-shot exec method is called.

Metadata help/schema output is represented by byte count and SHA-256. Initialize data is recursively sanitized: prompt/text/turn/token/secret/account/auth keys are removed, strings and arrays are bounded, and depth is limited. Resume/read results are not embedded. Reports contain only the exact attached thread ID, status, and numeric error codes. Process/request phases default to five seconds, retained protocol frames are capped at 1 MiB, stderr is drained, and cleanup escalates from SIGTERM to SIGKILL rather than claiming a live child exited.

Every report contains `activeDeliveryClaim:false` and `reason:"visible-session-submission-not-verified"`. Successful initialize, schema generation, resume, or read is compatibility evidence only, never active-delivery evidence. Live MCP/hooks/probe status remains UNVERIFIED until the operator matrix in `test/e2e/real-clients.md` is completed; even a successful matrix does not enable active delivery in this increment.

## Kimi Code

**Support status: `inbox-only`. Live ACP verification status: UNVERIFIED.** `KimiFallbackAdapter` reports no active delivery, state reporting, or client idempotency. Session state is always `unknown`, submission always fails with `DELIVERY_UNCERTAIN` before client or network activity, and doctor therefore reports `active-delivery-unsupported`. MCP inbox retrieval and `synloq_wait` remain available through the normal Kimi MCP connection.

### Read-only ACP compatibility probe

The automated tests use fake child processes and protocol fixtures; no real Kimi Code process or model was launched. To collect a live compatibility report, an operator can run this exact command from the Synloq repository with Node 24:

```bash
node scripts/probe-kimi-acp.ts --cwd <absolute-project-path>
```

Node 24 executes the erasable TypeScript directly; `tsx` and other additional runtime dependencies are not required. The command starts `kimi acp` as a new subprocess, speaks NDJSON JSON-RPC over stdio, and sends `initialize` with protocol version 2 as the latest supported version. It preserves the raw initialize result in its JSON report and uses the returned protocol version to negotiate subsequent behavior:

- ACP v1 advertises resume with the `agentCapabilities.sessionCapabilities.resume` object marker.
- ACP v2 advertises the session baseline, including resume, by providing `capabilities.session`.
- Missing support or an unsupported negotiated version records a skip reason. The probe never falls back to the removed `session/load` method.

Resume is attempted only when the operator adds `--session-id <id>` and the negotiated capabilities advertise support. Its parameters are exactly `{ sessionId, cwd, mcpServers: [] }`. Without the explicit flag, the report records `session-id-not-provided` and no existing chat is resumed. Every request has a five-second timeout, and the child is terminated after success or failure.

The probe never sends `session/prompt` and never prompts an already open TUI. Its report always contains `activeDeliveryClaim: false` and `reason: "existing-tui-interaction-not-verified"`; a successful initialize or resume is not active-delivery evidence. Only the separate manual acceptance procedure may investigate prompting an already open TUI, and Kimi active delivery remains disabled unless that independent evidence supports a later implementation.

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
