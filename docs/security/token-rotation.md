# Token Rotation Runbook

- Status: accepted (interface confirmed by dev, 2026-11-12, thread `20674686`)
- Date: 2026-11-12
- Author: Security

This runbook covers role/operator credential lifecycle for a Synloq project:
rotation, revocation, and diagnosing authentication failures. It follows the
`synloq rotate-token` / `synloq revoke-token` CLI contract confirmed by the
implementer; the audit-log steps assume the M4-min audit scope (see notes below).

## Concepts

- Each project role (and `operator`) authenticates to the relay with a bearer token.
- Tokens are stored as plaintext files at
  `<synloqHome>/credentials/<project-key>/<agentId>.token` (mode `0600`); the relay
  keeps only SHA-256 hashes in `<synloqHome>/credentials/<project-key>.json`.
- **Rotation replaces** all previously issued hashes of the role: every older token
  becomes invalid immediately. Re-issuing without rotation (lost state, fresh init)
  is _not_ revocation — old tokens keep working while their hashes remain in the
  credential store.
- Running MCP channel processes hold their token in memory. After rotation the
  affected role's channels must be restarted (close/reopen the chat's MCP server or
  the client conversation); the relay itself does not need a restart — it
  authenticates against the credential store on every request, so a rotated token
  works as soon as the channel reloads it. A `401` after rotation almost always
  means the channel was not restarted.
- Both commands are idempotent in their own sense: repeating `revoke-token` succeeds
  with an "already absent" note; repeating `rotate-token` performs a new rotation.

## When to rotate

- Suspected leak: token file committed, pasted, synced, or exposed in logs/evidence.
- A machine or backup that held the Synloq home changed hands.
- Routine hygiene after a security incident affecting the local user account.
- Offboarding a role from the project (rotate, or revoke if the role is removed).

## Rotate a role token

```bash
node dist/cli/main.js rotate-token \
  --project-root /absolute/path/to/project \
  --agent-id reviewer
```

Behavior:

1. Generates a new 256-bit token.
2. Replaces all stored hashes of `<agentId>` in the credential store (older tokens
   are invalid from this moment).
3. Atomically rewrites the role's token file.
4. Prints the token **file path** only — never the token itself.
5. Calls the audit hook (credential rotation, actor, timestamp). The persistent
   `audit_log` table ships with the M4-min audit scope; until then the call is a
   no-op behind the interface.

Afterwards: restart the role's MCP channels. Generated Kimi Work channels re-read
the token file on process start, so restarting the channel (or letting the host
respawn it) is sufficient. A `401`/`UNAUTHORIZED` from a channel that was not
restarted is expected, not a malfunction.

For the operator credential use `--agent-id operator` and then update every manual
CLI invocation that references the old operator token file contents.

## Revoke without re-issue (isolate first, re-issue later)

```bash
node dist/cli/main.js revoke-token \
  --project-root /absolute/path/to/project \
  --agent-id reviewer
```

Removes the role's hashes without issuing a new token: the role is locked out
until the next `init` (`ensureCredential` re-issues a token for a hash-less
role). Note that `rotate-token` refuses a role with no stored hashes ("no
existing credential to rotate"), so rotation alone cannot recover a revoked
role. Use `revoke-token` when a leak is suspected and the replacement channel
is not ready yet.

## Diagnosing 401 / UNAUTHORIZED after init or rotation

1. If this follows a rotation: restart the role's MCP channels first — running
   channels hold the old token in memory, and the relay already rejects it.
2. Confirm which token file the channel's MCP configuration points to
   (`credentialPath` in the role's MCP JSON under
   `<synloqHome>/runtime/mcp/<agentId>.json`).
3. Confirm the file content matches the credential store: rotate the role once —
   this rewrites both sides consistently.
4. If all roles fail at once, check that `--synloq-home` (or `SYNLOQ_HOME`) resolves
   to the same home the credentials were issued into; a moved project root also
   changes the project key and orphans the old state.
5. Check the audit log for rotation/revocation events affecting the role (available
   once M4-min lands).

## If tokens reached the git history

1. Rotate **every** role and the operator token immediately (hashes in the store are
   replaced, published tokens die).
2. Purge the history (force-push is a publication-time decision of the operator —
   see the production plan), but treat rotation, not history rewriting, as the
   actual containment.
3. Review the audit log (once M4-min lands) and the message traffic of the
   affected window for misuse.

## What rotation does not protect against

- An attacker who still has local code execution as your OS user (they can read the
  new token file too) — remove the foothold first.
- Messages already delivered before revocation — they remain in the recipients'
  inboxes.
