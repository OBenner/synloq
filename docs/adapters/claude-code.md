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

See [README.md](README.md) for shared adapter configuration rules and the process topology.
