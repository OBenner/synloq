# ADR 0004: Declarative role placement with a universal claim layer

- Status: proposed (identity signal for layer 3 to be fixed at acceptance — see Condition)
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
- **Codex Desktop, ZCode** offer no programmatic chat creation. A live probe
  (2026-11-14) confirmed Codex Desktop spawns per-conversation stdio MCP
  processes with `cwd` set to the thread's project directory, but provides no
  session-ID environment binding. ZCode API-created chats do not load the
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

## Condition for acceptance

The identity signal used by layer 3 on Codex Desktop is chosen by the outcome
of probes A/B (scripts/probe-cwd-mcp.mjs): if project-scope MCP configuration
loads in the current Desktop version → per-role project config; else if
`roots/list` carries the per-thread project directory → roots-based binding;
else → exact-match `cwd` binding with the D-11 requirements (no upward
search, realpath + case-fold, resolve-once-at-start, fail-closed). This ADR
moves to Accepted with the chosen signal recorded; the layer model and the
claim-token design do not depend on the probe outcomes.

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
- **Session/thread-ID env binding on Codex Desktop** — disproven by the live
  probe: no `CODEX_THREAD_ID`/`CODEX_HOME` is visible to spawned MCP
  processes.
- **Waiting for probe verdicts before writing this ADR** — rejected: the
  three-layer model and claim-token design are stable regardless of which
  identity signal wins; only the signal choice is conditional.
