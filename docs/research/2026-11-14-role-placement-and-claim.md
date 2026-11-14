# Research: role placement across hosts — push, claim by marker, claim by code

- Date: 2026-11-14
- Author: Architect
- Status: captured; layer model promoted to ADR 0004 (proposed)
- Related: ADR 0004; issue #32 (W5 add-role); issue #36; probe evidence from
  `scripts/probe-cwd-mcp.mjs` runs (2026-11-14)

## Question

How does a role declared in `synloq.yaml` end up as a live chat in a given
host (Kimi Work / OpenCode / Codex Desktop / ZCode / …) — and who creates it?
Two operator prompts drove this: a per-role `host` field in the manifest with
automatic provisioning, and a pull model where any chat claims its prepared
role.

## Host capability matrix (verified 2026-11-14)

| Host          | Programmatic session creation | Per-chat MCP scope            | Identity signal available to the MCP process                |
| ------------- | ----------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Kimi Work     | yes (client API)              | per-channel via plugin config | conversation binding at init                                |
| OpenCode      | yes (server API)              | project config merge          | session id from API                                         |
| Codex CLI     | n/a (terminal)                | project config (trusted)      | hooks + per-role CODEX_HOME                                 |
| Codex Desktop | no                            | user scope only (#13025)      | cwd = thread project dir (probe-verified); no thread env id |
| ZCode         | partial (API sessions exist)  | not loaded for API chats      | none confirmed (blocked, awaits manual UI retry)            |

## Decision tree

For a role with target host H:

1. **Push by API** — H exposes session creation (Kimi Work, OpenCode):
   init creates the visible session, binds it, issues the credential, done.
   Fully automatic.
2. **Claim by marker** — H has no session API but the MCP process receives a
   trustworthy per-thread location signal (Codex Desktop: cwd; possibly
   `roots/list`): init stages an unclaimed role record plus a marker file
   (`.synloq/role.json`) in a per-role directory; the MCP process resolves
   its role from that signal at startup (exact match, realpath + case-fold,
   resolve-once, fail-closed — ADR 0004 / D-11 requirements).
3. **Claim by code** — no usable signal at all (ZCode today): init issues a
   one-time human-readable claim code (`synloq-claim-<role>-XXXXXX`,
   TTL 15 min, consume-once, audited); the operator pastes it into the chat;
   the chat claims the role through its channel.

Each layer is the fallback of the previous one. The manifest stays the single
desired-state declaration regardless of which layer provisions the role.

## Open questions

- **Claim idempotency.** Re-entering the same chat after a restart must not
  fork the role identity: claim binds (role, host session); a re-entered chat
  re-resolves to the same binding or fails closed.
- **Unclaim / move.** Symmetric operation: release the binding, role returns
  to unclaimed. Reuses `replace-session` semantics (ADR 0001).
- **Claim-code hygiene.** Codes are single-use, short-lived, single-role;
  the role credential itself never travels through the chat (picked up from
  the local Synloq home).
- **Drift on host-mutated config.** Codex Desktop rewrites
  `~/.codex/config.toml` on its own; any merge logic must re-read before
  writing and tolerate foreign edits (observed live 2026-11-14).
- **Remote roles.** Claim-by-code is the natural future path to roles on
  other machines if the relay ever leaves loopback; out of scope now.

## Status

Layer model and claim-token design: promoted to ADR 0004 (proposed), pending
probe A/B verdicts only for the identity-signal choice in layer 2. This note
keeps the broader context and the host matrix for backlog planning.
