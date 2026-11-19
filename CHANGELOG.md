# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-19

Alpha follow-up with the formal Claude live proof, an operator dashboard, and
recovery/diagnostics hardening.

### Added

- **Read-only operator dashboard** (#79, #157): the relay serves a self-contained
  loopback HTML dashboard with auth-v2 operator proofs, role/session state,
  pending and aging summaries, recent delivery metadata, and an audit tail. No
  write routes; message bodies are excluded by default and require the explicit
  operator-only `includeText=1` option. A human-friendly login form followed in
  #160.
- **Role memory convention** (#21, #156): generated Kimi Work and OpenCode
  instructions now include per-role read/write discipline; a versioned template
  covers dated decisions, incidents, handoffs, and open loops. Agent definitions
  participate in the Kimi plugin digest so changed instructions trigger
  Install/Update.
- **Privacy policy and package homepage** (#155): factual local-first data and
  network policy, credential/storage locations, deletion boundaries, and links
  to the threat model.

### Fixed

- **Claude nudge-ledger recovery** (#146, #150): unresolved reservations are
  scoped to the target session instead of deadlocking the whole role. Historical
  uncertain attempts can be re-verified with append-only corrections; the
  original outcome remains intact.
- **Claude Code 2.1.326+ transcripts** (#158, #159): UUID-linked
  `system/turn_duration` service nodes are accepted without relaxing ancestry,
  same-session, fork, cycle, foreign-node, or marker-evidence guards.
- **Audit-denial flood control** (#114, #148): repeated denials are aggregated by
  action and role with bounded counts and intact reason/detail evidence.
- **Network filesystem diagnostics** (#112, #149): doctor warns when SQLite state
  is on NFS/CIFS/SSHFS/UNC storage, where WAL durability is not assured.

### Security and protocol

- **Hermetic-test guard** (#35, #153): CONTRIBUTING now treats test output as a
  secret-disclosure channel; a zero-dependency `pnpm verify` guard rejects
  high-signal real-home/credential access patterns in tests.
- **Protocol v1.1 documentation** (#152): reserved sender ids `relay`/`operator`
  and the `sender_reserved` reason code are specified; the Kimi Work
  per-conversation scoping request is drafted for upstream submission.

### Validation

- **Formal Claude live proof1 PASS** (#126, clean-room R2): independent evidence
  replay reports success/proof=1, latency 16.937 s, integrity OK; final SQLite
  has one successful attempt, zero corrections, an acknowledged seed, and no
  open sessions; all 41 SHA256-indexed evidence files match.

## [0.2.0] - 2026-11-17

Second alpha wave: mutual relay authentication, per-role memory, and resilient
local operations. 22 pull requests since 0.1.0; every entry references its PR
and issue.

### Added

- **Per-role memory notes** (#106, #22): `synloq_note_read` / `synloq_note_write`
  MCP tools, scoped by (project, role, key) with the role taken from the
  authenticated identity — never from the request. Bounds: key ≤128 chars,
  body ≤64 KiB, 256 keys per role; schema v6 additive migration. Retention does
  not touch notes (memory outlives messages); doctor reports aggregate stats
  only. M1 markdown→notes mapping for the migration path.
- **Webhook nudge channel** (#117, #133): opt-in operator-owned receiver
  notifications on pending mail. Fixed-schema identifier-only payload (no
  message text ever), one HTTP attempt per event (no retries), numeric
  loopback-only endpoint validation (DNS, IPv4 aliases, redirects, credentials,
  link-local/metadata all rejected), bounded audit, 5-minute debounce per role
  with epoch semantics. Config only in gitignored `synloq.local.yaml`; the
  committed manifest rejects the `webhooks` field.
- **Claude persisted-session nudger** (#126, #134): opt-in relay-owned service
  resumes an existing persisted Claude Code conversation (no replacement
  chats). Process-local allowlist inbox+ack only; exclusive transcript
  ownership (realpath + exclusive lock, never steal); typed result
  classification; transcript proof with parent-chain verification and an
  independent SQLite ACK arbiter. Live functional evidence: nudge →
  inbox+ACK → marker in 19.8 s → SQLite acked. Formal proof1 of the nudger is
  a clean-room acceptance of the ledger guard fix in 0.2.1 (see #146).
- **Codex nudge preview** (#104, #121): the queue reminder now carries a
  bounded read preview (sender + ≤200 code points, surrogate-safe, 600-unit
  Windows CLI budget). Sensitive-looking content is omitted entirely
  (`[preview omitted]`) instead of clipped. Preview is ephemeral — re-read
  from the store each attempt, never stored in the ledger. Delegation model
  updated in the same PR.
- **Frame formatting v2** (#105, #109): human-readable header
  (`📬 Synloq · from → to · thread · expectsReply`), body, and the machine
  envelope verbatim in a fenced code block. Envelope-based matching keeps
  rolling upgrades compatible in both directions (tests pin both).
- **Version telemetry** (#115, #119): doctor and status embed a copy-pasteable
  `versions` block (synloq/node/protocol/schema/hosts), fail-soft everywhere,
  including degraded report paths.
- **Smooth update** (#116, #118): `synloq doctor --upgrade-check` — read-only
  preview of pending migrations (fresh/current/pending/newer/unreadable) with
  the 3-command upgrade path (install → upgrade-check → init). `init` is the
  single upgrade command.
- **Contact cards + notes** (#108, #120): derived per-role reachability card
  (push / queue-nudge / next-interaction) from host capabilities and nudger
  constants — rendered in role instructions (before the charter) and in
  `synloq_list`. Optional manifest `notes` (≤500 chars) in tolerant+strict
  schemas and the overlay, shown only in `synloq_list`.
- **Process titles** (#140, #145): recognizable `synloq-relay (port N)` /
  `synloq-mcp: <role>` / `synloq-adapter: <role>` / `synloq-hook: <host>` in OS
  process monitors; best-effort, never throws, never writes to stdout.

### Fixed

- **Claude startup registration race** (#124, #132): SessionStart hook retries
  a typed NOT_FOUND heartbeat with a bounded backoff (100–1000 ms, 6 attempts,
  5 s budget) when the MCP child has not registered yet. Other errors fail
  closed; only the MCP child registers. `--host-timeout-ms` validated against
  the host limit. Live resume-startup PASS in the re-init window.
- **Transcript proof ancestry** (#138, #143): the verifier now projects known
  same-session service nodes (attachments, `stop_hook_summary`) onto
  conversational ancestry instead of rejecting the graph. Fail-closed on
  unknown types, cycles, forks, foreign sessions and UUID reuse; service nodes
  never supply evidence. Replay of the saved live turn: old verifier false,
  new verifier true.
- **Relay resilience** (#141, #144): a crashed relay's serve lock is recovered
  via a SQLite sidecar mutex with ESRCH-only steal (EPERM/unknown never steal);
  release compares the full owner record; OS releases the mutex on a killed
  process. Connection failures become structured STORAGE_FAILURE results with
  an actionable reason, never leaking private exception text. Supervisor
  exhaustion logs the failure category, not private details.
- **Claude nudge deny-list** (#137, #142): the launch deny list is derived from
  the shared MCP name catalog minus inbox/ack — note tools and future catalog
  additions are denied automatically; an SDK tools/list regression guards
  surface drift. A final-answer-then-timeout remains `uncertain` by design.
- **Migration race guard** (#136): the v5 rebuild transaction skips when a
  racing migrator already committed CURRENT (not just v5) — a concurrent open
  no longer fails with `unsupported user_version`. Reproduced and pinned.
- **Sender registration** (#10, #123): protocol v1.1 §2.5 — a message whose
  `from` is not a registered participant is rejected synchronously at
  acceptance (`UNKNOWN_SENDER`, HTTP 404, audit deny), before any dedup/replay
  effect and before any write. Reserved ids cannot originate participant
  messages; the operator is exempt. Conformance reproduces the 2026-11-12
  incident exactly.
- **OpenCode MCP state in doctor** (#92, #128): the last per-server MCP state
  from the backend log (connected/failed with exit code) is surfaced with
  restart guidance; raw error payloads never leave the parser. Offline-safe.
- **Advisory serve lock** (#110, #129): exactly one `synloq serve` per project
  database; a second serve fails with ALREADY_RUNNING naming the owning PID and
  lock path. No auto-steal on age heuristics; the operator removes a stale lock
  explicitly. `ensureRelay` re-probes a racing winner instead of failing.
- **Node version gate** (#111, #130): `serve` and `init` refuse Node < 24 with
  an actionable message before any write (nothing is written on refusal).
- **DB downgrade message** (#113, #131): a newer database on an older binary
  fails with both versions named and the escape hatch (upgrade or export).

### Security

- Relay HTTP authentication v2 (#1, #122): mutually authenticated
  challenge/request/response MACs replace wire Bearer tokens. **Coordinated
  upgrade required:** update relay and all clients, regenerate MCP configs with
  trusted `project`/`agentId`, and restart channels. Old/new combinations fail
  closed without fallback. Manual relay commands resolve identity from
  `--project-root` (cwd by default) and `--synloq-home`. See
  [rollout](docs/security/transport-auth-v2.md).
- Credential-store SHA-256 values are authentication-equivalent secrets. Rotate
  every affected role/operator credential after a store leak. MACs do not encrypt
  plaintext against an active forwarding proxy. Final R1 review is tracked in backlog.

### Docs

- `docs/guide/update.md` (upgrade flow), `docs/design/2026-11-17-webhook-nudge.md`
  and `docs/design/2026-11-17-claude-nudge.md` (nudger contracts),
  `docs/security/transport-auth-v2.md` (rollout), `docs/storage-notes.md`
  (memory notes), `docs/research/2026-11-17-token-economics.md` (honest cost
  model: measured / estimated / bounded-by-design).
- Live acceptance: Claude Code W7 inbox/lifecycle/dedup/restart (#125) and the
  re-init window (#139) — resume-startup PASS, nudger functional PASS,
  migration v5→v6 live, negative permissions PASS.

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

[0.2.0]: https://github.com/OBenner/synloq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/OBenner/synloq/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/OBenner/synloq/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/OBenner/synloq/releases/tag/v0.0.1
