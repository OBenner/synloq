# OpenCode adapter (experimental)

> **Status: verified live on 2026-11-13 against the OpenCode desktop service
> 2.2.7.** The idle, busy-suppression, and reconnect rows of the evidence
> matrix (`test/e2e/real-clients.md`) were executed on a real stand (runbook
> `docs/runbooks/2026-11-13-opencode-adapter-matrix.md`, runs r3/r3b).
>
> See also `docs/research/2026-11-13-opencode-manual-stand.md`: the manual six-tool
> MCP path and the session/prompt API primitives this adapter relies on were verified
> live on 2026-11-13.

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

`baseUrl` is the existing visible OpenCode server's loopback API, not the Synloq relay. The adapter authenticates to the desktop service with HTTP Basic: the password is read automatically from the service registration file (`<state-home>/opencode/service.json`, legacy `<config-home>` mirror); set the optional `servicePassword` field only to override that resolution. The adapter registers the exact session, subscribes to events, heartbeats fresh state, and submits only with `delivery: "queue"` and `resume: true` (`resume: false` admits into the session inbox without scheduling execution — verified live on 2.2.7). It has no steering path. EOF or reconnect invalidates state until a fresh matching status arrives. Shutdown aborts event/heartbeat/delivery loops and closes the relay session.

See [README.md](README.md) for shared adapter configuration rules and the process topology.

## Generic init (host: opencode)

`synloq init --host opencode` automates the manual bootstrap verified in
`docs/research/2026-11-13-opencode-manual-stand.md`:

- writes the manifest and per-role credentials (reused on re-run),
- writes MCP configs (`{relayUrl, credentialPath, synloqHome, opencode}`) under
  the Synloq home — the `opencode` binding (`{projectRoot, agentId, sessionId}`)
  lets each role channel host the relay itself,
- merges `mcp.servers["synloq-<role>"]` into the project `opencode.json`
  non-destructively (foreign keys preserved, broken JSON fails loud),
- discovers the running OpenCode desktop/service (bundled versioned CLI, then
  PATH, `OPENCODE_EXECUTABLE` override wins) and creates one visible session per
  role via `POST /api/session`, with a permission ruleset denying the other
  roles' tools, then posts the role prompt,
- authenticates to the desktop service with HTTP Basic (username `opencode`,
  password from the service registration file
  `<state-home>/opencode/service.json`, legacy mirror
  `<config-home>/opencode/service.json`; unauthenticated servers keep working),
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

## Relay auto-start

No manual `synloq serve` is needed: the generated MCP configs carry an
`opencode` binding, and the first role channel to start elects itself as the
relay host (the same supervisor election the Kimi Work channels use). If the
configured port is already served by a relay of a different project, startup
fails with `Synloq relay at <url> serves a different project` — one relay serves one
project on one port; pick another port via `--relay-url` at init time.
