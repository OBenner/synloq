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
