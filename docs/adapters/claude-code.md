# Claude Code adapter (experimental)

> **Status: UNVERIFIED.** Active delivery has not been verified against a live Claude
> Code client. It stays disabled until the manual evidence matrix
> (`test/e2e/real-clients.md`) is executed with an operator. Controlled transports and
> fake SDK clients are contract evidence, not live-client evidence.

The visible Claude chat must launch the stdio channel as its child. The same channel connection exposes the six ordinary tools and Claude channel notifications:

```bash
node /absolute/path/to/synloq/dist/cli/main.js adapter \
  --config /secure/claude-cto.json
```

Default-disabled `/secure/claude-cto.json`:

```json
{
  "version": 1,
  "kind": "claude",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "cto",
  "sessionId": "the-visible-claude-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token",
  "protocolVersion": 1
}
```

With neither activation field present, active delivery is disabled. Do not infer activation from a client name or version.

For controlled acceptance only, add one exact message UUID and restart the same visible channel:

```json
"acceptanceMessageId": "69d2065f-46a4-4b2f-9482-f9a64f349e26"
```

This permits one notification for that UUID, once, only when the same session, protocol, idle state, and both channel capabilities are valid. It is consumed after a successful notification write and is not production verification. Ordinary messages still require verified activation. Send the probe while delivery is disabled first so its relay-generated UUID is known. `acceptanceMessageId` and `activationVerifiedAt` are mutually exclusive.

Only after the manual matrix supplies observed evidence, remove `acceptanceMessageId` and instead set:

```json
"activationVerifiedAt": "2026-11-10T12:00:00.000Z"
```

This is an operator assertion for the same visible session and protocol, not a bypass flag. Keep the existing Claude approval policy; Synloq never auto-approves permissions.

Configure these visible-session hook events to invoke the public hook command with the same Claude config: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`, and `PreToolUse` (or another unknown event for fail-closed unknown state).

```bash
node /absolute/path/to/synloq/dist/cli/main.js claude-hook \
  --config /secure/claude-cto.json
```

Hook stdout is empty: no injected context or permission decision is emitted. Channel notification success is only `submitted`; a matching `UserPromptSubmit` hook with exact Synloq provenance supplies `delivered` evidence.

### Startup registration race (#124)

The MCP child is the only registration owner. If `SessionStart` runs before its
registration, the hook retries a typed `NOT_FOUND` heartbeat with delays of
100, 200, 400, 800 and 1000 ms (at most six attempts). The entire startup heartbeat
sequence has a 5000 ms budget, including request time; each HTTP request receives
only the remaining budget. Authentication, permission, invalid-input and transport
errors fail immediately, and other hook events are never retried. The hook never
registers a session or invents negotiated capabilities.

Configure the host hook timeout to allow this budget plus CLI startup/shutdown
margin (at least 6 seconds for the default). For a shorter timeout, explicitly
declare the host limit to the hook, for example for a 3-second host timeout:

```bash
node /absolute/path/to/synloq/dist/cli/main.js claude-hook \
  --config /secure/claude-cto.json --host-timeout-ms 3000
```

The startup budget then becomes `min(5000, hostTimeoutMs - 1000)`. The host limit
is not inferred from hook input; this flag must match the host configuration and
must be an integer greater than 1000 ms. An absent MCP registration still fails
after the bounded attempts; no background retry or success acknowledgement is
fabricated.

This addresses initial missing registration only. A heartbeat against an older
registration followed by re-registration can still reset the observed state to
`unknown`; that generation-ordering race is outside this fix. The recorded W7A
startup failure remains historical FAIL until a coordinated live re-test on the
updated relay and callers supplies new evidence. Do not mix pre-auth-v2 runtime
with newly generated auth-v2 configurations.

See [README.md](README.md) for shared adapter configuration rules and the process topology.

## Claude Desktop (Code tab)

**Live status 2026-11-15: MCP inbox VERIFIED, active delivery UNSUPPORTED (disabled), per-role server isolation UNVERIFIED.** Executed runbook: `docs/runbooks/2026-11-15-claude-desktop-live-dod.md`; audited against the relay database.

Desktop differs from the CLI: there are no launch flags and no development-channel loading, so the channel protocol and the activation gate above do not apply. What works is the MCP inbox pattern on per-role project folders:

- One folder per role with its own `.mcp.json` declaring exactly one `synloq-<role>` server (the ADR-0004 per-role project config signal, confirmed on this second host).
- The stdio channel configuration (`claude-<role>.json`) keeps the credential in an external token file and requires loopback relay URLs; the visible session id comes from the host's own session tool (`get_session`), never invented.
- Roles are reactive: the chat polls `synloq_inbox` when the operator activates it. A message sent to a busy role stays `stored` until the role reads it — no injection, no loss (verified with probe `508adc44-…`).
- Hooks (`SessionStart`, `Stop`) execute from `.claude/settings.json`; their connection to relay busy/idle state is UNVERIFIED.

Open follow-ups needing a GUI window: MCP pickup screenshots, cross-server isolation (E3.5), cross-role ack rejection (`UNAUTHORIZED`).
