# Feature request draft: per-conversation plugin / MCP scoping in Kimi Work

Date: 2026-11-19. Author: Architect (Synloq team). Status: draft for the
operator to file via the client support channel; not yet submitted.
Refs: `docs/research/2026-11-12-per-chat-mcp-isolation.md` (options B/C),
`docs/security/threat-model-2026-11-12.md` (issue #27 class),
[docs/research/2026-11-16-active-delivery-push-less-hosts.md].

This document is the ready-to-file request text. Sections 1–3 are the request
itself; section 4 is our internal rationale, kept for context.

---

## 1. Use case

We run **teams of role chats** in Kimi Work (e.g. CTO, Architect, Developer,
Security) coordinated by a local relay (Synloq). Each role chat gets its own
MCP stdio server with its own credentials (`synloq-arch`, `synloq-cto`, …), so
that a role can only read and write its own channel.

Today, Kimi Work resolves plugin tool sets at the **client/agent level**: all
MCP servers registered by one plugin are announced in **every** conversation
that has the plugin installed. The Architect chat therefore sees the CTO's
tools, the Developer sees the Security tools, and so on.

Consequences we observe in production:

- **Context pollution and model mistakes.** Every role chat carries the tool
  definitions of the whole team. Models occasionally call a foreign channel;
  our adapter rejects the call fail-closed, but the failure costs a turn and
  pollutes logs.
- **No host-layer isolation.** Channel separation is enforced at the
  application layer (adapter binding checks, per-role tokens, role
  instructions) — not by the host. A compromised or confused model session can
  *attempt* any channel; only our own code stands in the way. We would like the
  host to make the wrong channel *unreachable*, not just *unusable*.

## 2. Requested capability

Any **one** of the following surfaces would solve it; they are listed from the
least to the most invasive:

1. **Per-conversation MCP config attachment.** Let a conversation carry its own
   MCP server list (a per-conversation `mcp.json`-style overlay or a per-session
   config path), analogous to Claude Code's per-project `.mcp.json` and
   per-session `--mcp-config`. The role chat then attaches exactly one server.
2. **Plugin manifest templating.** Allow the plugin manifest to reference a
   per-conversation variable (e.g. a conversation/role binding), so the client
   resolves *which* servers of a plugin are visible in *this* conversation.
3. **A client API to scope plugin enablement per conversation** ("plugin X is
   active in conversation Y only"), either in the UI or programmatically.

In all variants, the needed semantics are the same: **the tool list announced
to a conversation must be resolvable per conversation, not only per client.**

We also ask for a **capability flag** (in the plugin manifest handshake or the
client API) so integrations can detect support and fall back gracefully.

## 3. Fallback behavior

If per-conversation scoping is unavailable, we keep the current
application-layer enforcement (adapter binding checks + per-role tokens +
fail-closed rejection). That is degraded but safe — it just costs context
budget and cannot become a host guarantee. We would treat the capability flag
as the signal to switch our plugin renderer from "one plugin, N servers" to
"N scoped attachments".

## 4. Internal rationale (not part of the request)

- Our research (2026-11-12, options B/C) concluded: do not build a per-role
  plugin split until the host can scope per conversation — the split multiplies
  artifacts without adding isolation otherwise. This request is the upstream
  dependency of that plan.
- Cross-channel impersonation risk (issue #27) remains a documented
  limitation on Kimi Work until this lands; a host-level scope would close it.
- Facts about the current client behavior are empirical (observed
  2026-11-12/16 on the operator's installation) and may have changed in newer
  client versions; the request stands regardless — we ask for the capability,
  not for confirmation of its absence.

---

_Requested scope: use case + minimal API surface + fallback behavior, per
Developer TASK `449ac8b4` (thread `410701fa`). To be filed by the operator._
