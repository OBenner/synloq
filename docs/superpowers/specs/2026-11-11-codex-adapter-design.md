# Codex fail-closed adapter design

- **Date:** 2026-11-11
- **Status:** approved design, pending implementation plan
- **Product:** Synloq
- **Initial scope:** MCP inbox, lifecycle hooks, and a read-only Codex app-server compatibility probe
- **Active delivery:** disabled and live-unverified

## 1. Purpose and constraints

Add Codex without weakening Synloq's core rule: messages may initiate work only in the intended idle visible session. Codex supports MCP configuration and lifecycle hooks, but those capabilities alone do not prove that a separate local process can inject a message into an already open Codex Desktop thread.

The first increment therefore provides durable inbox retrieval and fresh session-state evidence. It investigates app-server compatibility without submitting a turn. It must not create a hidden replacement chat, infer support from a client version, or represent hook/MCP activity as visible-message delivery.

## 2. Approaches considered

### 2.1 Fail-closed foundation — selected

Use the existing MCP stdio bridge, add a Codex hook command, and add a read-only app-server probe. Keep active delivery disabled until a real visible-session acceptance procedure proves a supported submission path.

This gives useful Codex interoperability with a small trusted surface and produces evidence for a later active adapter.

### 2.2 Immediate app-server active adapter — rejected for this increment

A separate app-server may be unable to resume a thread that Desktop has open. A successful `turn/start` in another runtime would not prove delivery to the intended visible chat. Implementing submission before resolving that binding risks acting in the wrong session or creating an unattended replacement.

### 2.3 MCP inbox only — rejected as incomplete

The existing MCP bridge already provides inbox tools. Documentation alone would be useful, but would not establish visible-session identity or idle/busy/closed state for a later safe adapter. The hook and probe work is required now.

## 3. Components

### 3.1 Existing MCP stdio bridge

Reuse `dist/mcp/stdio.js` and the existing six Synloq tools without a Codex-specific message protocol. Document `codex mcp add` configuration and the minimal external MCP JSON file. Credentials remain outside Git and are never inline in Codex configuration.

A Codex configuration scope must represent exactly one Synloq role. Multiple role credentials in one shared Codex configuration are not an approved multi-role setup: Codex thread identity is not assumed to be available to the MCP server. Separate CLI processes with distinct `CODEX_HOME` values may be evaluated as an isolation mechanism. Shared Desktop multi-role binding remains unverified until live evidence shows that each connection can be bound to its intended thread.

### 3.2 Codex hook configuration and command

Add a strict `kind: "codex"` adapter configuration using the existing common fields: project, project root, agent ID, visible Codex `session_id`, loopback relay URL, external credential path, and Synloq adapter protocol `1`.

Add:

```text
synloq codex-hook --config <path>
```

The command reads one JSON object of at most 64 KiB from stdin and writes no protocol or message content to stdout. It authenticates the configured credential and rejects a hook whose `session_id` differs from configuration before registration, heartbeat, or receipt activity. Oversized input is rejected before JSON parsing or relay activity.

On `SessionStart`, the command registers the exact session with these capabilities:

```text
activeDelivery: false
stateReporting: true
clientIdempotency: false
```

Registration returns a new generation on reconnect. Subsequent events heartbeat the mapped state. Duplicate visible sessions still require operator replacement. Generic `synloq adapter --config` rejects Codex configuration explicitly instead of silently starting an active runner.

### 3.3 Codex state mapper

Keep the mapper pure and separately tested:

| Codex observation                                           | Synloq state                 |
| ----------------------------------------------------------- | ---------------------------- |
| `SessionStart` with `startup`, `resume`, `clear`, or `fork` | `idle`                       |
| `SessionStart` with `compact`                               | `busy`                       |
| `UserPromptSubmit`                                          | `busy`                       |
| `PreModelRequest`                                           | `busy`                       |
| `Stop`                                                      | `idle`                       |
| `Interrupt`                                                 | `unknown`                    |
| `SessionEnd`                                                | `closed`                     |
| Valid but unsupported event or `SessionStart.source`        | `unknown`                    |
| Missing or malformed event envelope                         | reject before relay activity |

`Interrupt` is fail-closed because the hook does not prove that all turn cleanup has finished. `PostModelRequest` is not an idle signal because tool execution or another model attempt may follow. Subagent events do not independently make the parent session idle.

Heartbeat freshness remains bounded by the existing lease and state-freshness rules. Hooks alone never enable active delivery, so an idle observation cannot cause injection in this increment.

### 3.4 Read-only app-server probe

Add a script using Node 24 and the installed Codex executable, without new runtime dependencies. The probe reports the executable version, app-server help/schema availability, initialize result, negotiated capabilities, and explicit unsupported-method/error results.

Default behavior starts no model turn and resumes no thread. An operator may supply an exact thread ID to opt into read-only `thread/resume` and thread/status reads. The probe then records whether that exact thread can be attached and whether a visible-client writer conflict occurs.

The probe must never call `turn/start`, `turn/steer`, `codex exec`, or any prompt/submission method. It must not synthesize a thread, change approval policy, trust hooks, or modify Codex configuration. Each process or request phase has a five-second default timeout, with shorter durations injectable in tests. Stderr is drained continuously, every child is terminated and reaped during cleanup, and retained protocol frames are capped at 1 MiB each. Reports contain protocol metadata and sanitized error codes, not prompts, message bodies, credentials, account tokens, or full transcripts.

The report always contains:

```text
activeDeliveryClaim: false
reason: "visible-session-submission-not-verified"
```

Successful initialize, resume, schema generation, or status reads are compatibility evidence only, not active-delivery evidence.

## 4. Data flow

### 4.1 Send and inbox retrieval

```text
Visible Codex chat
  -> Codex MCP client
  -> Synloq stdio MCP bridge
  -> authenticated loopback relay
  -> SQLite / ordinary Synloq tools
```

The relay derives identity from the role credential. Codex-specific code adds no `from` parameter and no alternate storage path.

### 4.2 Lifecycle state

```text
Codex lifecycle event
  -> synloq codex-hook
  -> strict JSON and exact session_id validation
  -> SessionStart registration or heartbeat
  -> existing SessionStore lease and freshness rules
```

Malformed input, wrong sessions, wrong role credentials, stale generations, and relay failures produce no successful state claim. Hook stdout remains empty; diagnostics contain no prompt or message body.

### 4.3 Future active-delivery decision

A later implementation may consider active delivery only after all of the following are observed in one real client/runtime:

1. the exact intended visible thread is attached without a hidden replacement;
2. fresh idle state is available and a busy turn is never steered;
3. one controlled Synloq message is admitted with complete provenance;
4. duplicate submission is safely handled or the uncertain outcome is quarantined;
5. a client-generated admission artifact supports a generation-bound delivered receipt;
6. reconnect and shutdown cannot resurrect an old registration.

Until then, Codex registration keeps `activeDelivery: false`, doctor reports active delivery unsupported, and no production activation flag is introduced.

## 5. Testing and acceptance

### 5.1 Automated tests

- Strict Codex configuration, external credential authentication, and rejection by the generic active-adapter command.
- Pure state mapping for every documented event/source and ambiguous input.
- Hook registration on start, reconnect generation changes, wrong-session rejection before network mutation, heartbeat state updates, closed handling, empty stdout, and bounded input.
- Existing MCP stdio contract with a Codex configuration example; no Codex-specific tools or privilege changes.
- Probe fake-process tests for bounded lifecycle, stderr draining, malformed output, unsupported methods, writer-conflict reporting, explicit thread opt-in, and proof that no submission method is sent.
- Doctor reports registered Codex state while active delivery remains unsupported.
- Full `pnpm verify`, package-content inspection, and built CLI help smoke checks.

### 5.2 Required live procedure

No Codex executable is currently available in the implementation environment, so live support remains `UNVERIFIED`. On an operator machine:

1. Record Codex version, surface (CLI/Desktop), configuration scope, visible session ID, and Synloq protocol version.
2. Configure one role credential and verify all six MCP tools, authenticated send/reply/inbox/wait/ack, and durable retrieval after relay restart.
3. Trust the exact hooks through Codex's normal review flow. Observe startup, prompt/model activity, stop, interrupt, reconnect, and session end; verify wrong-session hooks are rejected.
4. Run the read-only probe without a thread ID, then with the exact visible thread ID. Save only metadata evidence.
5. If a future submission implementation exists, run a separate one-message controlled acceptance before enabling it. This increment provides no activation switch and cannot pass that delivery gate.

Automated fake-process tests and a successful probe do not upgrade live active-delivery status.

## 6. Explicit non-goals

- No hidden or replacement Codex chat.
- No `turn/start`, steering, interrupt-driven injection, or approval bypass.
- No parsing of transcript files as a delivery interface.
- No hook `additionalContext` used as a message-delivery channel.
- No assumption that shared Desktop MCP connections expose per-thread role identity.
- No dashboard, orchestrator, group channel, remote relay, new dependency, or publication workflow.
- No Codex production activation flag before a verified submission path exists.

## 7. Research basis

Checked on 2026-11-11:

- Codex hooks: https://developers.openai.com/codex/hooks
- Codex MCP configuration: https://developers.openai.com/codex/mcp
- Codex app-server protocol: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Visible Desktop writer/binding limitation report: https://github.com/openai/codex/issues/54683

The app-server main-branch schema may differ from an installed release. Runtime probing and the actual installed schema are required; documentation and version strings alone are not capability evidence.
