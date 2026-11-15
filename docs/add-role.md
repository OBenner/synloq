# Adding a role to an existing project

This guide covers the supported way to extend a team after the initial
`synloq init` — for example adding a `qa` or `dev2` role to a project that
already runs other roles.

## Steps

1. **Add the role to `synloq.yaml`** in the project root:

   ```yaml
   agents:
     # ...existing roles...
     qa:
       title: QA
       role: Verify outcomes, run tests, report defects
   ```

2. **Re-run init** for the project:

   ```bash
   npx synloq@latest init
   ```

   Init reuses existing chats and credentials, creates what is missing, and
   re-renders the plugin. Read the `nextStep` field of the JSON result:

   - `channelsChanged: true` — the plugin channel set changed (a role was
     added or removed). Press **Install/Update** for the Synloq plugin in
     Kimi Work; the updated channels start automatically.
   - `channelsChanged: false` — nothing about the channels changed; no
     Install/Update needed.

3. **Press Install/Update once** in the Kimi Work plugin UI when
   `channelsChanged` is true. This is the only manual step: the host owns the
   plugin lifecycle, and a channel for a new role can only appear after the
   host reloads the plugin.

## Adding a role with an explicit role list (any host)

Passing `--role` extends the existing manifest instead of replacing it
(issue #32, gap G1) — roles from previous runs are never dropped:

```bash
npx synloq@latest init --host opencode --role qa:QA:"Verify outcomes" --non-interactive
```

On OpenCode this also creates the session with a deny-tools matrix built
from the full merged roster (not just the roles of this invocation), posts
the role prompt, and merges `opencode.json` non-destructively. The running
relay picks the new role up from the manifest — no relay restart needed.

## Removing a role

```bash
npx synloq@latest remove-role --project-root <path> --role qa --credential <operator-token-file>
```

The command, in order: validates the operator credential (no irreversible
effect runs before this check), deletes the OpenCode session when the role
lives there (`DELETE /api/session/{id}`; skipped with a note when the service
is unreachable), revokes the credential through the operator-gated path
(which also voids any outstanding claim code), removes the role from
`synloq.yaml`, its `opencode.json` server entry, and the team-state binding.
Kimi Work chats cannot be deleted programmatically — the result tells you to
close the chat manually. Afterwards restart the relay so the removed role
leaves the in-memory participant registry.

## Claiming a role on a host without session provisioning

Hosts without a session-creation API (`synloq init --host generic`) cannot
bind a chat automatically. Init prepares each role (manifest, credential, MCP
config) and prints a one-time claim code per role
(`synloq-claim-<role>-<8 base32>`, valid 15 minutes) plus a next-steps
checklist.

1. On the machine that holds the Synloq home, run:

   ```bash
   synloq claim --project-root <path> --code synloq-claim-<role>-xxxxxxxx
   ```

   The command consumes the code and prints the role's credential path and
   MCP config path. The credential file is picked up locally and is never
   transmitted through chat.

2. Wire the printed config path into the host's MCP configuration, approve
   the host's trust dialogs, and restart the host client so the channel
   starts.
3. An expired code is operational noise, not an incident — re-issue one:

   ```bash
   synloq claim-issue --project-root <path> --role <id>
   ```

Claiming a role with no outstanding code (already claimed, or re-issued)
fails with a pointer to `synloq replace-session`. Rotating or revoking the
role's token (`synloq rotate-token` / `synloq revoke-token`) voids any
outstanding code. Claim accepts and refusals are recorded in the security
audit log (`<synloq-home>/data/<project-key>-audit.jsonl`); expired codes are
not recorded.

## What does NOT need a restart

- **The relay.** The participant registry is hot-reloaded from `synloq.yaml`:
  a newly added role is accepted by the running relay as soon as the manifest
  changes. A manifest that fails to parse is ignored — the relay keeps the
  last good registry and records a `directory`/`degraded` event in the
  security audit log (`<synloq-home>/data/<project>-audit.jsonl`).
- **Role tokens.** Credentials are re-read on every request; a rotated or
  newly issued token works as soon as the channel using it restarts.

## If something looks wrong

- `synloq doctor` reports a `plugin` section for Kimi Work projects:
  `stale: true` means the installed plugin copy is older than the generated
  source — press Install/Update. `note: "not-installed"` means the plugin was
  never installed from this source.
- A role chat that stays empty after Install/Update usually means the client
  needs a restart so the new MCP channel is spawned.
- For OpenCode-bound roles, `synloq doctor` shows a `hostCheck` section:
  whether the `opencode.json` MCP entry is present and the credential file is
  healthy. Add `--check-host` to also probe the OpenCode service for session
  liveness (`alive` / `dead`; `unknown` with a note when the service is
  unreachable). Without the flag doctor never touches the network.
- Removing a role is heavier than adding one: restart the relay afterwards so
  its in-memory state for the removed role is dropped.

## Known limits

- The plugin channel set (`mcpServers`) cannot hot-reload without the host;
  that is an upstream Kimi Work feature request tracked in issue #36.
- Mixed-host projects (some roles in Kimi Work, some in OpenCode) are
  supported by the relay, and add-role merges the manifest on any host — but
  declaring each role's host in `synloq.yaml` (ADR-0004 layers 1–2) is a
  separate task; until then the host is chosen per init invocation.
