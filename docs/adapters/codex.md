# Codex bridge (experimental)

## Desktop-first role directories

Declare `host: codex-desktop` for each role in `synloq.yaml`, then run init
against the source project with an explicit Synloq home and relay URL:

```bash
synloq init --project-root <source-project> --synloq-home <home> --relay-url http://127.0.0.1:4399 --non-interactive
```

The `desktop.roles` result lists directories under
`<home>/runtime/<project-key>/roles/<role>` by default. A role may opt into a
different directory with `placement` in `synloq.yaml`:

```yaml
agents:
  arch:
    title: Architect
    role: Design
    host: codex-desktop
    placement: role-projects/arch
```

Relative placement paths resolve against the source project; absolute paths are
also accepted. No project-local layout is imposed by default. Init saves the
resolved path in team state, which doctor and remove-role use even if the manifest
later changes. Re-init refuses a placement move until the operator performs an
explicit migration. Project-root/ancestor paths, Synloq service directories,
redirected paths (including symlinks/junctions), and overlapping role directories
are refused. The standard generated directory is the service-path exception.

Open each returned directory as a separate
trusted Codex Desktop project and start a chat, following `desktop.nextSteps`.
Synloq owns only `[mcp_servers.synloq-<role>]` and its child tables in
`.codex/config.toml`; other settings and server tables are preserved verbatim.
`AGENTS.md` contains
the shared role prompt and source-project location. Credentials stay in the
Synloq home; the runtime JSON uses `relativeHomePaths`. The TOML contains
paths, never tokens. Re-run init after relocating the home/runtime binary
because the Desktop launcher arguments contain absolute paths.

Desktop configuration provisioning does not create a chat, report session
state, or wake an inactive model. `canProvisionSessions` remains false;
`canProvisionConfig` is true. Config-only hosts dispatch through the
`ConfigProvisioner` registry (`provision`, `inspect`, `remove`).
Desktop roles do not require claim codes; generic/ZCode roles retain the
existing claim flow. The role is reactive: activate it to check its inbox.
An optional [relay-side CLI queue nudger](codex-queue.md) can enqueue an
identifier-only inbox reminder. It does not guarantee activation, particularly
for unloaded chats, and never enables the active-delivery adapter.
A manual-only stand requires an operator-started relay on its configured
port (or an existing compatible relay supervised by another host).

`doctor` reports the saved placement state (`configured` for Desktop), with
`ok` reflecting inspection; this is configuration evidence, not a live chat
binding. Missing directories/files, an edited owned table, or an edited
`AGENTS.md` produce a failed placement check. Host additions outside the owned
table no longer count as drift. Re-init preserves credentials and refuses to
overwrite drifted owned content. Ambiguous TOML (duplicate owned headers,
overlapping inline definitions, or unsupported lexical forms) fails closed
instead of being reserialized. `AGENTS.md` still uses a full-file SHA-256 hash.
Back up deliberate edits and resolve drift before re-init. `remove-role`
uses the existing operator authorization/revocation path and removes only
unchanged generated content; the owned TOML table is removed while other tables
and settings remain. Modified or additional user files are retained
with a diagnostic. Close Desktop chats manually after removal.

Live acceptance: **VERIFIED 2026-11-15** on an isolated stand (relay
`127.0.0.1:4399`, Codex Desktop ≥ 0.169.0-alpha.11.1) per the runbook
`docs/runbooks/2026-11-15-codex-desktop-acceptance.md`: each chat saw only
its own `synloq-<role>` server, the full send/inbox/ack/reply cycle worked in
both directions, idempotent resend returned the original message ID,
cross-role ack was rejected with `UNAUTHORIZED`, and a Desktop restart
preserved history and operability. This is observed configuration isolation,
not host-enforced isolation: nothing stops an operator from registering
another role's server manually. There is no active delivery on this host —
roles are reactive and check their inbox when activated.

## CLI reference: hooks and lifecycle reporting

> **Status: UNVERIFIED.** Live compatibility with a real Codex client has not been
> verified. Codex currently supports the authenticated MCP inbox and lifecycle state
> reporting only; active delivery is unsupported and always disabled. Generic
> `synloq adapter --config` rejects Codex instead of starting an active runner.

Use one Codex configuration scope, normally one `CODEX_HOME`, for one Synloq role. Do not place role tokens in `config.toml`, and do not configure several role credentials in one shared Codex/Desktop scope. Shared Desktop multi-role binding is unverified.

Create `/secure/codex-mcp.json` separately from the adapter/hook configuration:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "project": "verdicta",
  "agentId": "cto",
  "credentialPath": "./cto.token"
}
```

Register the existing stdio bridge, substituting absolute paths:

```bash
codex mcp add synloq-cto -- node /absolute/path/to/synloq/dist/mcp/stdio.js /secure/codex-mcp.json
```

Create `/secure/codex-cto.json` with the exact visible Codex session ID and the same role credential:

```json
{
  "version": 1,
  "kind": "codex",
  "project": "verdicta",
  "projectRoot": "/absolute/path/to/project",
  "agentId": "cto",
  "sessionId": "the-visible-codex-session-id",
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/cto.token",
  "protocolVersion": 1
}
```

Configure these events in the same scope's `hooks.json`. Project-local hooks require a trusted project. Review and trust the exact definitions through Codex `/hooks`; changed hooks must be reviewed again. Do not bypass the trust flow.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 15
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "PreModelRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 10
          }
        ]
      }
    ],
    "Interrupt": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 3
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/codex-cto.json",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Every handler reads one hook JSON object, limited to 64 KiB, from stdin. Synloq writes no protocol output, `additionalContext`, continuation, permission decision, or message content to stdout. `SessionStart` registers `activeDelivery:false`, `stateReporting:true`, and `clientIdempotency:false`; subsequent events heartbeat state. A different `session_id` fails before relay mutation.

The 3-second caps for `Interrupt` and `SessionEnd` are matched inside the handler: those events carry a 2-second relay request budget (the RelayHttpClient default is 5 s), so the host timeout cannot kill the hook mid-write and the `unknown`/`closed` states still reach the relay. If you raise the hook timeouts, keep at least ~1 s of headroom above the relay budget for process startup and stdin.

The read-only compatibility probe uses the installed executable without creating a chat or submitting work:

```bash
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path --thread-id REPLACE_WITH_VISIBLE_THREAD_ID
```

Without `--thread-id`, no resume occurs. With it, the probe permits only `thread/resume` and `thread/read` for that exact ID and records sanitized metadata. Neither command is active-delivery evidence. See `docs/client-compatibility.md` and `test/e2e/real-clients.md` for limits and acceptance evidence.

See [README.md](README.md) for shared adapter configuration rules and the process topology.
