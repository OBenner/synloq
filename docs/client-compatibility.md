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

### Activation gate

Active delivery starts disabled. It remains disabled unless all of these conditions hold:

1. The initialized exchange exposes both required experimental capabilities.
2. The operator-created adapter configuration has a non-empty `activationVerifiedAt`.
3. The configuration's `protocolVersion` is Synloq adapter protocol version `1`.
4. The submission's visible session ID exactly matches the configuration's `session_id` / `sessionId`.

The operator must use one of these exact Claude Code activation mechanisms:

- local development: `--dangerously-load-development-channels`;
- managed deployments: the `allowedChannelPlugins` allowlist.

Setting `activationVerifiedAt` is an operator assertion that the required activation mechanism and live behavior were checked for that same Claude session and protocol version. It must not be inferred from a mock test, client name, or client version.

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

1. Start the intended Claude Code version with local `--dangerously-load-development-channels`, or configure managed `allowedChannelPlugins` for the Synloq channel server.
2. Record the actual Claude `session_id`, Synloq protocol version, client version, and activation mechanism.
3. Complete MCP initialization and confirm that both experimental capabilities are present.
4. Register the same visible session, observe `SessionStart`, and send one Synloq message while it is freshly `idle`.
5. Confirm that the exact channel notification is admitted to that visible session without steering a running response.
6. Confirm that the notification write alone leaves the message `submitted`, and that only the matching `UserPromptSubmit` hook changes it to `delivered`.
7. Confirm that a permission request still follows the client's existing approval policy and receives no automatic decision from Synloq.
8. Repeat with activation disabled and with each capability absent; confirm zero injections and MCP inbox fallback.
9. Only after these checks pass, record the evidence and set `activationVerifiedAt` for that same session and protocol version.

Until this evidence exists, Claude Code active delivery must remain disabled in operator configuration.
