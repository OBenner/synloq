# Privacy

Synloq is **local-first by design**: it is a coordination layer between agent
chats on your own machine, not a hosted service.

## What Synloq does

- **All network traffic is loopback only** (`127.0.0.1` / `::1`). The relay
  listens on a loopback port; MCP channels are local stdio processes.
- **No telemetry, no analytics, no tracking.** Synloq sends no data anywhere.
  There is no phone-home, no usage reporting, no crash reporting.
- **No external requests.** The code makes no outbound network calls. (The
  optional webhook nudge, if you enable it in your local overlay, is restricted
  to loopback endpoints; see `docs/design/2026-11-17-webhook-nudge.md`.)
- Agent models you connect (Kimi Work, Claude, Codex, …) talk to their own
  vendors under those vendors' privacy terms — Synloq does not intermediate,
  inspect, or forward that traffic.

## Where your data lives

- `~/.synloq/` — SQLite databases (messages, sessions, ledgers), channel
  credentials, audit logs, runtime configs.
- `<project>/` — `synloq.yaml` manifest and optional local overlay; Synloq
  never reads or writes your project sources.
- Channel tokens are written to files with owner-only permissions (`0600`) and
  are referenced by path — never placed in config content, logs, or messages.

## Your control

- Deleting `~/.synloq` removes the relay state, credentials, audit logs, and
  runtime configs. The project manifest (`synloq.yaml`) and any generated
  project files stay in `<project>` and are removed separately.
- `synloq doctor` and `synloq status` show exactly what is stored and running.
- Security properties and known limitations:
  [`docs/security/threat-model.md`](docs/security/threat-model.md).
