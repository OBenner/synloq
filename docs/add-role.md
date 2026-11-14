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
- Removing a role is heavier than adding one: restart the relay afterwards so
  its in-memory state for the removed role is dropped.

## Known limits

- The plugin channel set (`mcpServers`) cannot hot-reload without the host;
  that is an upstream Kimi Work feature request tracked in issue #36.
- Mixed-host projects (some roles in Kimi Work, some in OpenCode) are
  supported by the relay, but full add-role UX for them lands with issue #32.
