# OpenCode adapter (experimental)

> **Status: verified live on 2026-11-13 against the OpenCode desktop service
> 2.2.7.** The idle, busy-suppression, and reconnect rows of the evidence
> matrix (`test/e2e/real-clients.md`) were executed on a real stand (runbook
> `docs/runbooks/2026-11-13-opencode-adapter-matrix.md`, runs r3/r3b).
>
> See also `docs/research/2026-11-13-opencode-manual-stand.md`: the manual six-tool
> MCP path and the session/prompt API primitives this adapter relies on were verified
> live on 2026-11-13.

The visible OpenCode chat uses the ordinary `synloq mcp` stdio command for the six tools. With a generated `opencode` binding containing `sessionId`, the MCP child also starts its own in-process delivery adapter and runner after exclusive relay registration. It discovers the running desktop endpoint and service authentication using the same discovery as init. A separate process is no longer required. This automatic lifecycle (#67) is automated-test verified; its operator live window is pending, separate from the existing 2.2.7 prompt API evidence above.

The manual sidecar remains available and has priority over automatic MCP registration:

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
- writes MCP configs (`{project, agentId, relayUrl, credentialPath, synloqHome, opencode}`) under
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

The MCP child registers with optional `ownership: "exclusive"`. The relay
atomically refuses registration while any owner of the role has an unexpired
lease, including the same visible session ID. Expired leases allow registration;
manual CLI registration keeps its existing behavior. A conflict leaves MCP tools
available with their normal writer checks, but disables the child's delivery and
stored-ping transport. No replacement is attempted automatically.

Both heartbeat and close carry the registered generation. A takeover rejection
stops the child sidecar permanently for that process. Transport failures use the
existing runner backoff and retain its outstanding receipt/failure tracker; relay
supervisor recovery does not create a new registration for a running sidecar.
Startup has five attempts with exponential backoff (200 ms initial delay).
After exhausted retries or an ownership conflict, resolve the cause and restart
the MCP child. Stop the prior transport first and wait for its lease to expire
(currently 15 seconds from its last heartbeat or close); a live or stuck owner
requires an operator's explicit `replace-session`. A binding without `sessionId`
remains inbox-only until init supplies the exact visible session.

`doctor` exposes `participants[].openCodeRegistration`: the last MCP registration
outcome (`registered` or `blocked`), timestamp, and reason code from the audit log,
even beyond its display tail. This is historical registration evidence, not
current host liveness. Read it together with `adapterConnected`, heartbeat time,
and the optional host check. The audit surface is `opencode-mcp`; manual sidecars
retain `opencode`.

See the [operator checklist](../testing/opencode-mcp-sidecar.md) for the pending
automatic-lifecycle live window.

No manual `synloq serve` is needed: the generated MCP configs carry an
`opencode` binding, and the first role channel to start elects itself as the
relay host (the same supervisor election the Kimi Work channels use). If the
configured port is already served by a relay of a different project, startup
fails with `Synloq relay at <url> serves a different project` — one relay serves one
project on one port; pick another port via `--relay-url` at init time.
