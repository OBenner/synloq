# Codex bridge (experimental)

> **Status: UNVERIFIED.** Live compatibility with a real Codex client has not been
> verified. Codex currently supports the authenticated MCP inbox and lifecycle state
> reporting only; active delivery is unsupported and always disabled. Generic
> `synloq adapter --config` rejects Codex instead of starting an active runner.

Use one Codex configuration scope, normally one `CODEX_HOME`, for one Synloq role. Do not place role tokens in `config.toml`, and do not configure several role credentials in one shared Codex/Desktop scope. Shared Desktop multi-role binding is unverified.

Create `/secure/codex-mcp.json` separately from the adapter/hook configuration:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
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
