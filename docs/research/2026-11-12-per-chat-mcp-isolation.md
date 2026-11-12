# P1 Research: Per-chat MCP isolation

Date: 2026-11-12. Author: Architect. Per Developer TASK `b1da52af-7e67-4878-9b70-f11154cf5620` (thread `9437ac41-5995-46b4-b290-68d6825d3a4a`).
Status: research only, no implementation. Team: 4 roles (cto, arch, security, dev), relay on :4100, protocol v1 accepted (`docs/protocol/v1.md`).

---

## 1. Status quo (verified against code and a live session)

**Role channels.** Each role gets a dedicated MCP stdio server `synloq-<role>`
(`src/init/plugin-renderer.ts:95-107`): its own config `~/.synloq/runtime/<hash>/mcp/<role>.json`
(relayUrl + credentialPath + kimiWork binding) and its own token `~/.synloq/credentials/<hash>/<role>`.
The actual layout on the operator's machine was confirmed: `mcp/{arch,cto,dev,security}.json`.

**Channel visibility.** All role servers are registered in ONE plugin (`kimi.plugin.json`,
`mcpServers`). Empirically confirmed consequence: in the Architect chat the host announces
the tools of all four channels (`synloq-arch`, `synloq-cto`, `synloq-dev`, `synloq-security`).
There is NO host-level isolation today — any project chat can technically see other channels.

**Where the real barrier stands.** The Kimi Work adapter is fail-closed on chat binding
(`src/adapters/kimi-work.ts`):

- `state()` returns `unknown` for a foreign sessionId (line 140);
- `submitDelivery()` throws `UNAUTHORIZED` on conversationKey mismatch (191–192);
- `assertMetadata()` checks conversationKey/sessionKey/origin/workspacePath/kernelSessionId (273–280);
- `assertAdmission()` checks conversationKey/kernelSessionId of the send result (289–296).

Plus per-role tokens (the relay will not serve another role's inbox to a foreign token) and the role
instruction "use only the Synloq MCP channel assigned to this role" (`plugin-renderer.ts:35`).

**Status-quo conclusion:** isolation is application-layer (binding + token + prompt), not host-layer.
This is a working defense against accidental cross-ups and against a "misbehaving" model (a foreign
channel simply rejects the call), but not against compromise of the role token itself.

## 2. Isolation options

### A. Application-layer, status quo (hardened)

One plugin, all channels visible in every chat; authorization at the adapter and relay.

- ✅ Already implemented, zero host changes; covered by tests (446 PASS).
- Risk: visibility of foreign tools provokes model mistakes (calling the wrong channel) —
  absorbed by fail-closed, but pollutes context and logs.
- Risk: the role token sits in `~/.synloq/credentials/<hash>/` and is readable by any process
  of the user — token compromise = role compromise. A limitation of any local scheme.

### B. Separate plugin instance per role

Generate N plugins (`synloq-arch`, `synloq-cto`, …) instead of one, each carrying only its
own role's `mcpServers` server.

- ✅ Technically feasible on top of the current `renderKimiWorkPlugin` (parameterize per role).
- ❌ Blocker: in current Kimi Work, plugin enablement is at the agent/client level, not per
  conversation. If the host cannot express "only plugin X is active in this chat", the option
  provides no isolation — it only multiplies entities (N plugins × updates).
- Verdict: postpone until per-conversation plugin resolution exists in the host. Requires
  capability confirmation from the Kimi Work developers.

### C. Per-conversation MCP configs (scoping by conversationKey)

The host resolves `mcpServers` separately per chat: the arch role's chat gets only
`synloq-arch` attached. This is the "proper" host-layer isolation.

- ❌ Not supported in the observed Kimi Work version: the plugin manifest is static, the server
  list is shared. Empirical confirmation: mixed channel visibility (§1).
- Host requirement: a configuration template with a conversation/role variable, or an
  "enable plugin for conversation" API. To be filed as an upstream feature request.
- Promising in other hosts: Claude Code supports per-project `.mcp.json` and per-session
  `--mcp-config` — option C is feasible there today (a separate config per role launch). For P2
  adapters this is an argument to design the role config as a self-contained artifact that a
  host can attach selectively.

### D. Relay-side enforcement (hardening inside our own code)

Independent of the host: the relay binds (role token ↔ bound conversationKey) and rejects
delivery/ack when the calling session does not match the role's binding.

- ✅ Partially present already (assertMetadata/assertAdmission). Hardening: a single deny log,
  metrics for cross-channel call attempts, a test "foreign channel = BLOCKED/UNAUTHORIZED".
- ✅ Host-independent, portable to future adapters.
- ❌ Does not remove the visibility noise of foreign tools.

## 3. Recommendation (Architect position)

1. **v1: A + D.** Accept that Kimi Work currently has no host-layer isolation; close the risks
   on our side: fail-closed is already in place, add deny logging and conformance tests for
   cross-channel calls. This is cheap and not blocked on the host.
2. **Feature request to Kimi Work:** per-conversation scoping of plugins/MCP servers
   (option C). Until it arrives, do not build option B — it multiplies artifacts without gain.
3. **For P2 adapters** (Claude Code etc.), design role launch as a separate process with its
   own `.mcp.json` — option C is achievable there immediately, and the Synloq architecture
   already allows it (the role config is self-contained: relayUrl + token + binding).

## 4. Position for the joint review: simplicity and maintainability

**Simplicity for the mass user (install → init → roles).**

- Today: the init wizard creates the team, renders the plugin, writes runtime configs — one
  pass, state in `~/.synloq` isolated per projectKey (path sha256). A good foundation.
- The main simplicity risk is manual assembly of role chats in the client. Keep the rule:
  everything that can be generated (manifest, role instructions, configs) IS generated; the
  user performs only irreversible/trusted steps (plugin installation, role confirmation).
- Do not multiply entities unnecessarily: option B would double the plugins for isolation the
  host does not provide anyway — an anti-example for mass UX.

**Ease of maintenance across updates.**

- State/credentials: the versioned ownership marker `.synloq-owner.json` already exists
  (`version: 1`, `plugin-renderer.ts:20-22`) — use the same approach for migrations:
  a `version` field in `state/<key>.json` and `credentials/<key>.json`, forward-only
  migrations, fail-loud on an unknown version (same semantics as `unsupported_version` in
  the protocol).
- Plugin ↔ protocol compatibility: protocol v1 already carries a mandatory `version` and
  rejection instead of a silent drop — plugin regeneration on update MUST preserve the
  projectKey (otherwise the manifest digest changes and the host sees a "new" plugin);
  `plugin-renderer.ts:117-121` already accounts for this.
- Rule for future changes: any field the on-disk format depends on ships with a migration
  and an "old state → new binary" test.

## 5. Open questions

- Confirm with the Kimi Work developers: is per-conversation plugin/MCP scoping planned?
  (blocker for options B and C on this host)
- Is per-role token rotation needed (today the token is perpetual and file-resident)?
- Reserving the sender ids `relay`/`operator` — agreed to be fixed during P1/P2
  implementation (participant registry in config).

---

_Research without code changes. Committed as `cef7c7c`; translated to English for the public contour._
