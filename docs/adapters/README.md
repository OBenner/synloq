# Experimental host adapters

> **Status: experimental.** None of the adapters in this directory have been verified
> against live clients. The only live-verified host is Kimi Work (see the project
> README). Do not rely on these paths in production until the manual evidence matrix
> in `test/e2e/real-clients.md` has been executed for the specific host.

Active delivery is optional everywhere: MCP inbox retrieval (`synloq mcp` with the
six tools) works without it.

## Adapters

| Host        | Document                          | Live status |
| ----------- | --------------------------------- | ----------- |
| Claude Code | [claude-code.md](claude-code.md)  | UNVERIFIED  |
| OpenCode    | [opencode.md](opencode.md)        | UNVERIFIED  |
| Codex       | [codex.md](codex.md) (inbox-only) | UNVERIFIED  |

## Shared configuration rules

Adapter JSON is strict: unknown fields, inline tokens, non-loopback URLs,
unsupported protocol versions, and mismatched role credentials fail startup.
`projectRoot`, `agentId`, `sessionId`, and the credential must describe the same
visible role binding. Adapter protocol version is exactly `1`.

Every adapter config keeps tokens in separate files referenced by `credentialPath` —
never inline a token in JSON or on a command line. Keep adapter JSON outside Git.

## Process topology

```text
visible Claude chat
  └─ child stdio: synloq adapter --config claude-cto.json
       ├─ six MCP tools + Claude channel
       └─ HTTP to relay with cto credential
visible Claude hooks ── synloq claude-hook --config claude-cto.json

visible OpenCode chat
  └─ child stdio: synloq mcp --config arch-mcp.json (six tools)
separate OpenCode adapter: synloq adapter --config opencode-arch.json
       ├─ queue/events/status at the existing OpenCode server
       └─ HTTP to relay with arch credential

generated Kimi Work role MCP (SUPPORTED)
  ├─ six tools + embedded visible-delivery runner
  └─ supervised relay ownership or authenticated reuse

standalone synloq serve (advanced) ── one loopback HTTP relay and one project SQLite writer
```
