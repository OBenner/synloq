# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Relay HTTP authentication v2 (#1): mutually authenticated challenge/request/response
  MACs replace wire Bearer tokens. **Coordinated upgrade required:** update relay
  and all clients, regenerate MCP configs with trusted `project`/`agentId`, and
  restart channels. Old/new combinations fail closed without fallback. Manual
  relay commands resolve identity from `--project-root` (cwd by default) and
  `--synloq-home`. See [rollout](docs/security/transport-auth-v2.md).
- Credential-store SHA-256 values are authentication-equivalent secrets. Rotate
  every affected role/operator credential after a store leak. MACs do not encrypt
  plaintext against an active forwarding proxy. Final R1 review is tracked in backlog.

## [0.1.0] - 2026-11-16

Public alpha with active delivery, durable storage and hardened local security.
43 pull requests since 0.0.2; every entry references its PR and issue.

### Added

- **Active delivery / wake-up for push-less hosts** (#78, #67):
  - OpenCode: in-process delivery sidecar starts with the role MCP channel,
    owns its session exclusively and wakes the visible chat on incoming mail
    (#80). Live-verified 2026-11-16 (10/10 acceptance steps,
    `docs/testing/2026-11-16-opencode-mcp-sidecar-live-acceptance.md`).
  - Codex Desktop: opt-in, relay-owned CLI queue nudger — bounded, durable,
    honest (`queue accepted` is never claimed as delivery) (#88, #83).
    Live full-cycle acceptance 2026-11-16: nudge → wake → inbox → ack → reply.
    Delegation model and residual gaps documented (#89).
  - Claude Desktop: next-interaction injection through
    `UserPromptSubmit` hook `additionalContext` confirmed on the Desktop Code
    tab (live window W6); host has no autonomous wake — tracked upstream in
    anthropics/claude-code#110364 and openai/codex#61773.
- **Config provisioning** (#82, #58): `ConfigProvisioner` registry with scoped
  TOML subtree ownership for Codex Desktop (`synloq-<role>` table only, host
  edits preserved verbatim, fail-closed on ambiguous TOML), persisted claim
  state (`bound`/`configured`), optional per-role `placement` with state as the
  source of truth and fail-closed moves/overlap/redirects.
- **Per-stand customization**: gitignored `synloq.local.yaml` manifest overlay —
  per-field role overrides, local role additions, fail-loud on any error (#94, #37).
- **Storage retention and delivery ledger** (#85, #4): body-free 7-day dedup
  ledger; periodic sweep removes only acknowledged messages older than
  `retention.days` (default 7), quarantine-protected; forward-only schema v5
  migration with validation and full rollback on failure.
- **Relay hardening** (#93): relay-wide concurrent long-poll cap (32) on top of
  the per-identity cap, with audit-logged rejections that name the route.
- **MCP tool annotations** (#95, #72): all six participant tools declare
  explicit `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`;
  the three reported child-process sites audited — explicit `shell: false`,
  literal argv boundary tests, per-site decisions and an honest trust-boundary
  note (`docs/security/2026-11-16-tool-annotations-shell-outs.md`).
- Team scale-out: `staff1` (Codex Desktop) and `staff2` (generic) roles (#64);
  agent workspace layout convention (#63); per-host connection matrix and
  support status (#59).

### Fixed

- SQLite reliability (#75, #68): `busy_timeout=5000`, read-only connections for
  per-tick readers, migration write skipped on a current schema, underlying
  errnos surfaced inside `STORAGE_FAILURE`.
- Quarantine release could strip the marker of a submitted message whose
  one-message acceptance allowance was already consumed, permanently blocking
  the recipient's FIFO queue; the marker is now preserved on both release
  paths, including session re-registration (#91, #90).
- Standalone Claude channel no longer self-denies writes with `NOT_WRITER` —
  the writer-session proof is passed at registration (#87, #86).
- Manifest parsing tolerates additive fields from newer manifests and shows
  them as degraded diagnostics in doctor/status (#74, #69).
- Claim-code pin and supervisor election flakes under parallel load (#73, #76).
- All id-based message-store lookups are project-scoped (#57, #51).
- Adapter delivery failures produce timestamped, redacted diagnostics (#77, #39).

### Security

- Credential writers serialized through a cooperative per-project lock;
  atomic state writes sync and close before rename, with POSIX directory sync
  (#84, #15). Orphan-lock recovery documented; stale locks are never stolen.
- Codex Desktop provisioner attaches the security audit log to credential
  issuance/revocation (#81, #3); session registration events record the
  client-reported surface (#54, #53).
- Single-writer enforcement per role: a read-only second session is denied
  writes with `NOT_WRITER` (#60, #46).
- Unauthenticated health probe and fail-closed loopback URL validation shipped
  in 0.0.2 were re-verified with a live cross-channel denial (#27 remains a
  documented known limitation until hosts enforce per-conversation scoping).

### Docs

- `docs/adapters/codex-queue.md` (nudger contract + delegation model),
  `docs/runbooks/codex-queue-nudger.md` (live acceptance runbook),
  `docs/storage-retention.md`, `docs/storage-delivery.md` (quarantine
  boundaries), `docs/security/credential-durability-2026-11-16.md` (L2/L3
  closure evidence), active-delivery research (#78) and live acceptance
  records; add-role rolling-upgrade caveat and the CLI-claim norm (#70);
  M8ven Trust Index badge (#71).

## [0.0.2] - 2026-11-13

Second alpha: security hardening from the first review and the claim layer.

- Unauthenticated `/v1/health` marker probe before any credential is sent;
  fail-closed loopback-only URL validation for relay endpoints (H1/H2).
- `rotate-token` command and runbook; token reissue no longer leaves old
  tokens valid (M1).
- Claim codes for hosts without session provisioning (#42).
- Audit log baseline: auth failures, operator actions, credential lifecycle
  (M4-min).

## [0.0.1] - 2026-11-12

Initial public alpha: protocol v1 specification, a visible team of agent roles
on the Kimi Work host, per-role MCP channels over a supervised loopback relay.

[0.1.0]: https://github.com/OBenner/synloq/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/OBenner/synloq/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/OBenner/synloq/releases/tag/v0.0.1
