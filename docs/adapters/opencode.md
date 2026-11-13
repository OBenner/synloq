# OpenCode adapter (experimental)

> **Status: UNVERIFIED.** Active delivery has not been verified against a live
> OpenCode server. It stays disabled until the manual evidence matrix
> (`test/e2e/real-clients.md`) is executed with an operator.
>
> See also `docs/research/2026-11-13-opencode-manual-stand.md`: the manual six-tool
> MCP path and the session/prompt API primitives this adapter relies on were verified
> live on 2026-11-13; the adapter itself remains unverified.

The visible OpenCode chat uses the ordinary `synloq mcp` stdio command for the six tools. Run active delivery as a separate, operator-configured process:

```bash
node /absolute/path/to/synloq/dist/cli/main.js adapter \
  --config /secure/opencode-arch.json
```

Example `/secure/opencode-arch.json`:

```json
{
  "version": 1,
  "kind": "opencode",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "arch",
  "sessionId": "the-visible-opencode-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/arch.token",
  "protocolVersion": 1,
  "baseUrl": "http://127.0.0.1:4096",
  "heartbeatIntervalMs": 1000
}
```

`baseUrl` is the existing visible OpenCode server's loopback API, not the Synloq relay. The adapter registers the exact session, subscribes to events, heartbeats fresh state, and submits only with `delivery: "queue"` and `resume: false`. It has no steering path. EOF or reconnect invalidates state until a fresh matching status arrives. Shutdown aborts event/heartbeat/delivery loops and closes the relay session.

See [README.md](README.md) for shared adapter configuration rules and the process topology.
