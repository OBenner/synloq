# Changelog

All notable changes to Synloq are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-11-13

### Changed

- README quickstart switched to `npx synloq@latest init`; all command
  examples now use the installed `synloq` bin (checkout form documented as a
  contributor note).

## [0.0.1] - 2026-11-12

First public release.

### Added

- Local relay with SQLite-backed durable messaging, idempotency keys, and
  delivery state machine (protocol v1, `docs/protocol/v1.md`).
- Kimi Work plugin with per-role MCP channels (`synloq_send`, `synloq_reply`,
  `synloq_inbox`, `synloq_wait`, `synloq_ack`, `synloq_list`) and generic
  `synloq init` for arbitrary role sets.
- Relay-side security enforcement (P1.1): role-token ↔ conversationKey
  binding, append-only security audit log for denials and auth failures,
  cross-channel conformance suite, threat model.
- Runner recovery: heartbeat carries session generation, UNAUTHORIZED
  triggers single-flight re-registration, outstanding operations survive
  recovery.
- Tag-gated npm distribution with SLSA provenance and GitHub Releases.
- Experimental adapters for Claude Code, OpenCode, and Codex (unverified
  against live clients).

[0.0.2]: https://github.com/OBenner/synloq/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/OBenner/synloq/releases/tag/v0.0.1
