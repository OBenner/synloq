# Adding a role to an existing project

This guide covers the supported way to extend a team after the initial
`synloq init` — for example adding a `qa` or `dev2` role to a project that
already runs other roles.

## Steps

### Choosing a host per role

Each role may declare `host` in `synloq.yaml`. Omitted `host` means
`kimi-work`. Supported values are `kimi-work`, `opencode`, `codex-desktop`,
`zcode`, and the manual `generic` profile:

```yaml
version: 1
project: example
agents:
  dev:
    title: Developer
    role: Implement scoped changes
    host: opencode
  arch:
    title: Architect
    role: Review architecture
    host: codex-desktop
```

Run `synloq init --project-root <project> --synloq-home <home>` to reconcile
the entire manifest. Kimi Work and OpenCode can provision visible sessions;
ZCode and generic prepare unclaimed role records,
credentials, instructions, and MCP config paths. The JSON output contains a
`roles` capability summary, host-specific `kimi`/`opencode` results, and
`manual.roles` claim codes plus `manual.nextSteps`. Manual steps include
wiring the channel, trusting configuration, and restarting the client.
A manual-only stand also needs its own running relay on the configured port.
Codex Desktop uses generated per-role directories instead of claim codes;
follow `desktop.nextSteps` and the Desktop-first section in
`docs/adapters/codex.md`. Its state is `configured`, not a verified chat binding.

For legacy single-host setup, `--host` selects that host. When used with a
placement manifest it explicitly overrides all desired targets; omit it to
preserve mixed placement. Re-init preserves existing API session bindings
and credentials, and reissues 15-minute claim codes for manual hosts, as in
the generic profile. Each host sees only its own generated role set. The
relay's participant API and protocol messages contain no host metadata.

`synloq doctor --project-root <project> --synloq-home <home>` reports each
role's desired `host` and `placement` consistency. A prepared manual role is
`unclaimed` while a claim code is outstanding and `manual` afterwards;
`manual` does not assert a verified chat binding or live delivery.

Init rejects a changed host for an already prepared/bound role before
writing files or calling host APIs. Moving a live role requires an explicit
operator migration (including `replace-session` and corresponding local
host configuration/state reconciliation); simply editing `host` cannot
silently replace a session. Automated host migration is outside #44.

### Extending the roster

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

   A successful claim persists the placement as `bound` (`configured` for a
   config-provisionable host). Doctor reads this state directly. Re-running init
   preserves a claimed role; it does not issue another claim code automatically.

   Prefer this CLI path over pasting the code into a chat: a code pasted
   into an _existing_ chat is read as plain text and does not claim the
   role. If a chat-based claim is ever used, the code must go into a _new_
   chat of that role's project.

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
  Caveat: hot-reload holds only while the running relay understands the
  current manifest schema. After upgrading Synloq itself to a version that
  extends the schema (a new field in `synloq.yaml`), restart the host once
  before adding roles — otherwise the old process rejects the newer manifest
  and new roles stay unreachable (`UNKNOWN_RECIPIENT`) until the restart
  (issue #69).
- **Role tokens.** Credentials are re-read on every request; a rotated or
  newly issued token works as soon as the channel using it restarts.

## If something looks wrong

- `synloq doctor` reports a `plugin` section for Kimi Work projects:
  `stale: true` means the installed plugin copy is older than the generated
  source — press Install/Update. `note: "not-installed"` means the plugin was
  never installed from this source.
- A role chat that stays empty after Install/Update usually means the client
  needs a restart so the new MCP channel is spawned.
- A freshly added role that can send but whose incoming messages fail with
  `UNKNOWN_RECIPIENT` means the running relay rejected the updated manifest:
  check for a `directory`/`degraded` event in the audit log
  (`<synloq-home>/data/<project-key>-audit.jsonl`) and restart the host once
  (rolling-upgrade caveat above, issue #69).
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
- Mixed-host init reconciles declared roles and add-role merges the manifest
  on any host, preserving per-role placement. Role removal and other
  lifecycle commands have their own host support limits; consult their
  runbooks before removing a bound role.
