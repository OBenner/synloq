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

## Generic init (host: opencode)

`synloq init --host opencode` automates the manual bootstrap verified in
`docs/research/2026-11-13-opencode-manual-stand.md`:

- writes the manifest and per-role credentials (reused on re-run),
- writes legacy MCP configs (`{relayUrl, credentialPath}`) under the Synloq home,
- merges `mcp.servers["synloq-<role>"]` into the project `opencode.json`
  non-destructively (foreign keys preserved, broken JSON fails loud),
- discovers the running OpenCode desktop/service (bundled versioned CLI, then
  PATH, `OPENCODE_EXECUTABLE` override wins) and creates one visible session per
  role via `POST /api/session`, with a permission ruleset denying the other
  roles' tools, then posts the role prompt,
- persists `conversations[role] = {kind: "opencode", sessionId, directory}` in
  team state; Kimi Work entries keep parsing as before (no `kind` field).

Re-running init is a no-op for live sessions (`GET /api/session/{id}` reconcile);
a missing session is recreated. `--conversation <role>:<sessionId>` binds an
existing session instead of creating one. `--relay-url` selects a non-default
loopback relay port when several projects run side by side.

Known limitations on this host:

- **G7** — the first MCP tool use inside a newly created session may require an
  interactive approval in the OpenCode UI.
- The permissions ruleset grammar (`action`/`resource`/`effect` with wildcards)
  is narrowly verified; when the service rejects it, init fails soft and creates
  the session without host-level tool denies (the result reports
  `permissionsApplied: false`). Role separation then rests on prompt discipline
  only.
- Relay auto-start for OpenCode MCP configs is not part of init yet; run
  `synloq serve` separately (tracked as the W3 issue).
