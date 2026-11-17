# Synloq documentation

Everything beyond the README lives here. The README stays short: what Synloq is,
how to start, the host matrix, and links.

## Start here

- [Installation and initialization](guide/installation.md) — requirements,
  `synloq init`, the generated Kimi Work plugin, automatic relay lifecycle, the
  six agent-facing MCP tools, manual MCP configuration.
- [Operator guide](guide/operator.md) — replace-session, the single-writer rule,
  pause/resume, token rotation and revocation, `doctor`/`status`, nudges,
  diagnostics and the audit log, runtime paths.
- [Adding a role to a live project](add-role.md).
- [FAQ and troubleshooting](faq.md).

## Hosts

- [Adapter model and shared configuration rules](adapters/README.md).
- **Kimi Work** — quickstart in the README; embedded visible delivery details in
  the [installation guide](guide/installation.md).
- [OpenCode](adapters/opencode.md).
- [Codex Desktop](adapters/codex.md) and the opt-in
  [queue nudger](adapters/codex-queue.md)
  ([acceptance runbook](runbooks/codex-queue-nudger.md)).
- [Claude Code / Claude Desktop](adapters/claude-code.md).
- Support matrix: [README](../README.md#how-each-host-connects) and
  [client-compatibility.md](client-compatibility.md).

## Protocol and architecture

- [Protocol v1](protocol/v1.md) — Accepted, errata 2026-11-12.
- [Architecture decision records](adr/).
- [Research notes](research/).
- [Team and project conventions](conventions/).

## Operations

- [Runbooks](runbooks/) — live acceptance windows and evidence procedures.
- [Live evidence matrix](../test/e2e/real-clients.md).
- [Storage, retention, migrations](storage-retention.md) and
  [delivery semantics](storage-delivery.md).

## Security

- [Threat model](security/threat-model.md) — the source of truth for security
  boundaries and known limitations.
- [Token rotation runbook](security/token-rotation.md).
- [Security reviews and audits](security/).

## Project

- [Backlog](backlog.md) · [production plan](production-plan.md).
- For AI agents working in this repository: [AGENTS.md](../AGENTS.md).
