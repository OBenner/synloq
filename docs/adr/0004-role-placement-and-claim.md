# ADR 0004: Declarative role placement with a universal claim layer

- Status: accepted (2026-11-14 — probe A/B verdicts received; identity signal
  recorded in Acceptance record)
- Date: 2026-11-14
- Deciders: Architect (proposal), CTO (convergence), operator (direction)
- Related: ADR 0001 (project boundaries); ADR 0003 (one relay per project);
  issue #32 W5 (add-role/remove-role UX); issue #36 (plugin update UX);
  `docs/research/2026-11-13-opencode-manual-stand.md`

## Context

Roles today are provisioned per host by `synloq init`, but the target
environment is not expressed in the manifest: `--host` is a global CLI flag,
and the live attempt to add a role under OpenCode surfaced the gap directly
(init overwrote the manifest instead of merging; mixed-host projects are not
expressible — gap G2 in issue #32 comments).

Hosts differ fundamentally in what tooling can do:

- **Kimi Work, OpenCode** expose APIs to create the visible session — init can
  fully provision the role (proven live: tester role, 2026-11-14).
- **Codex Desktop, ZCode** offer no programmatic chat creation. Live probes
  (2026-11-14) confirmed Codex Desktop loads project-scope MCP configuration
  from a trusted project's `.codex/config.toml` (Desktop 0.169.0-alpha.11.1)
  and provides no chat identity to spawned MCP processes (no thread/session
  env, empty `roots/list`). ZCode API-created chats do not load the
  workspace MCP configuration at all (blocked on the vendor).

The operator asked for two capabilities: declaring each role's target host in
`synloq.yaml`, and a pull model where a chat in any environment claims its
prepared role ("there is Synloq in this project — fetch your role").

## Decision

Three layers, all host-side — protocol v1 is untouched (no envelope, message
type, reason-code, or constant changes):

1. **Declarative placement.** `synloq.yaml` carries a per-role `host` field
   (`kimi-work`, `opencode`, `codex-desktop`, …). The manifest is the desired
   state; init is an idempotent reconcile loop toward it. Moving a role to
   another host is a manifest edit plus re-init (a binding replacement,
   following the `replace-session` discipline of ADR 0001).

2. **Capability-driven provisioning.** Each host adapter declares
   `canProvisionSessions`. Where true, init creates and binds the session
   itself. Where false, init prepares an _unclaimed role record_ (role,
   credential, instructions) and prints an explicit claim instruction plus a
   next-steps checklist for the manual host actions it cannot perform (trust
   dialogs, client restarts). Fallback is an explicit output step, never a
   silent degradation.

3. **Universal claim layer.** The operator pastes a one-time claim code into
   any chat; the chat claims the prepared role:
   - Code format: human-readable `synloq-claim-<role>-<6–8 base32 chars>`.
   - TTL 15 minutes; re-issue is one command; an expired code is operational
     noise, not a security event.
   - Consume-once; re-claiming a bound role fails with a pointer to
     `replace-session`.
   - Rotation/revocation reuses the existing token-rotation machinery.
   - Claim requires local access to the Synloq home (the operator's machine):
     the role credential file is picked up locally and is never transmitted
     through chat. Remote-machine roles are a noted future possibility, out of
     scope.
   - Every claim event goes to the security audit log.

## Acceptance record

The condition set at proposal time is fulfilled. Probes A/B
(`scripts/probe-cwd-mcp.mjs`, evidence `docs/local/codex-desktop-probe-2.jsonl`,
18 records) on Codex Desktop 0.169.0-alpha.11.1 returned:

- **Probe A: project-scope MCP configuration works.** A server declared in a
  trusted project's `.codex/config.toml` spawned (cwd = the project directory)
  with no user-scope entry present. openai/codex#13025 is an outdated report.
- **Probe B: no chat identity exists.** `initialize.params` carries only
  protocolVersion/capabilities/clientInfo; `roots/list` succeeds but is empty;
  the environment has no THREAD/SESSION/CHAT/CONVERSATION variable.

Chosen identity signal for Codex Desktop: **per-role project config** — a
per-role trusted project directory whose `.codex/config.toml` declares the
Synloq MCP server with that role's credential in args, plus AGENTS.md
instructions. Roots-based and cwd-based binding are closed as unnecessary.
Codex Desktop is therefore a provisionable host (init can write the project
config directly, including a next-steps checklist for trust dialogs); the
claim layer (#42) remains for hosts without config provisioning.

## Consequences

- Reproducible, version-controlled, init-validatable team topology across
  hosts; mixed-host projects become expressible.
- Honest UX: manual host actions are an explicit operator checklist produced
  by init, matching how the hosts actually behave (observed during the
  2026-11-14 maintenance window).
- Claim is the only honest answer for hosts without session APIs and for
  future multi-machine roles.
- Cost: init grows a capability matrix and an unclaimed-record lifecycle;
  claim codes add one operator step on API-less hosts.
- Isolation stays "by configuration" (same as today's Kimi Work stance): a
  role process can physically read other credentials from disk. A real
  boundary (ACLs or a relay-side broker) is a separate hardening track (#8).

## Alternatives considered

- **Pure declarative auto-provisioning** — impossible: several target hosts
  expose no session-creation API; pretending otherwise produces silent
  degradation (rejected together with "best-effort" wording).
- **Pure self-claim without a manifest** — no reproducibility, no reviewable
  desired state, no validation at init time.
- **Session/thread-ID env binding on Codex Desktop** — disproven by probe B:
  no thread/session identity is visible to spawned MCP processes.
- **Roots-based or cwd-based binding on Codex Desktop** — closed as
  unnecessary by probe A: project-scope MCP configuration loads, so the role
  is bound by its project config instead of by resolving a location signal.
- **Waiting for probe verdicts before writing this ADR** — rejected: the
  three-layer model and claim-token design are stable regardless of which
  identity signal wins; only the signal choice is conditional.

## Implementation status

- 2026-11-14: **layer 3 (universal claim) landed** (issue #42) — CLI
  `synloq claim` / `synloq claim-issue`, 15-minute consume-once codes stored
  as SHA-256 hashes in the team state, claim accept/deny events in the
  security audit log (expired codes are operational noise and are not
  recorded), token rotation/revocation voids outstanding codes. Runbook:
  `docs/add-role.md` → "Claiming a role on a host without session
  provisioning".
- Layers 1 and 2 landed with per-role `host` reconciliation (#43/#44).
- The config-provisioner increment (#58) adds `canProvisionConfig` and a
  `provision`/`inspect`/`remove` registry. Codex Desktop owns only its MCP table
  subtree in TOML; host/user settings outside it are preserved. `AGENTS.md`
  remains protected by its complete file hash.
- Optional manifest `placement` selects a config role directory; the existing
  runtime directory remains the default. Init persists the resolved location,
  rejects redirects/service paths and implicit moves, and doctor/remove read
  the recorded location. No project-specific folder layout is imposed.
- Successful claim persists `bound` (or `configured` for config hosts) in
  placement state. Doctor reports that state directly; re-init preserves a
  claimed role instead of manufacturing another claim code. Explicit
  `claim-issue` remains available when the operator intends to reissue a code.
