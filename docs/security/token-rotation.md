# Token Rotation Runbook

- Status: accepted (interface confirmed by dev, 2026-11-12, thread `20674686`)
- Date: 2026-11-12
- Author: Security

This runbook covers role/operator credential lifecycle for a Synloq project:
rotation, revocation, and diagnosing authentication failures. It follows the
`synloq rotate-token` / `synloq revoke-token` CLI contract confirmed by the
implementer; the audit-log steps use the M4-min audit scope (issue #3, landed
2026-11-14).

## Concepts

- Each project role (and `operator`) authenticates with auth-v2 MAC proofs derived
  from its token; the token is not sent over relay HTTP.
- Tokens are stored as plaintext files at
  `<synloqHome>/credentials/<project-key>/<agentId>.token` (mode `0600`); the relay
  keeps SHA-256 hashes in `<synloqHome>/credentials/<project-key>.json`. These are
  **authentication-equivalent secrets**, not safe-to-disclose verifiers. A store
  leak requires rotating every affected role, including `operator`. Treat copies
  and backups as credential leaks too; never print or commit the hashes.
- **Rotation replaces** all previously issued hashes of the role: every older token
  becomes invalid immediately. Re-issuing without rotation (lost state, fresh init)
  is _not_ revocation — old tokens keep working while their hashes remain in the
  credential store. Rotation changes V/kid, so outstanding challenges fail closed;
  an already admitted operation may finish using its verified request context.
- MCP channels re-read their token files for each request. A fresh request can
  self-heal after rotation; an in-flight request may fail. Static-token CLI/adapter
  clients require reloading/restarting. Restart the affected channel if failures
  persist, and check its credential path. The relay re-reads the store at challenge
  issuance and request verification; no relay restart is needed for rotation.
- Both commands are idempotent in their own sense: repeating `revoke-token` succeeds
  with an "already absent" note; repeating `rotate-token` performs a new rotation.

## When to rotate

Credential writers serialize through a per-project `.json.lock`, and state writes
sync their temporary file before rename. If a writer crashes, the lock deliberately
requires operator recovery after stopping all project writers. See
[credential durability and lock recovery](credential-durability-2026-11-16.md)
for the procedure, checks and platform limits.

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
5. Records the rotation in the persistent security audit log
   (`<synloqHome>/data/<project-key>-audit.jsonl`): an `accept` event with
   `action: "rotate"`, the role, and the timestamp (M4-min, issue #3). The
   last events are readable via `synloq doctor --project-root <path>` under
   the `audit` section.

Afterwards: verify the next authenticated operation. MCP channels re-read the
token file on each request; a request already in flight may fail during rotation.
Static-token adapters need a restart. If the MCP channel continues to report
`UNAUTHORIZED`, verify its credential path and restart it before retrying.

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
role) or a `synloq doctor --repair` run, which re-issues missing or stale
token files and re-renders the generated channel configs from the saved team
state. Note that `rotate-token` refuses a role with no stored hashes ("no
existing credential to rotate"), so rotation alone cannot recover a revoked
role. Use `revoke-token` when a leak is suspected and the replacement channel
is not ready yet.

## Diagnosing 401 / UNAUTHORIZED after init or rotation

Fresh credential issuance during init is audited for every supported host,
including Codex Desktop's operator and role credentials. Re-running init with
valid credentials reuses them and does not append another `issue` event. These
events use the same project audit file and doctor readout as `rotate` and
`revoke`; token values and hashes are never included.

0. Run `synloq doctor --project-root <path>` first: every Kimi Work-bound role
   carries a `credential` section (`ok` / `missing` / `stale`) — a `stale` or
   `missing` status is exactly the post-rotation/post-revoke state. `synloq
doctor --repair` fixes both by re-issuing the token file and re-rendering
   the role's channel config from the saved team state; it is idempotent and
   changes nothing on a healthy setup. Repair does not update the installed
   plugin copy — a `plugin.stale` flag still requires Install/Update in the
   host.
1. If this follows a rotation: retry a fresh request after checking the token file.
   Restart static-token adapters or a channel whose authentication failures persist.
   Auth-v2 outstanding challenges for the old credential are invalidated.
2. Confirm which token file the channel's MCP configuration points to
   (`credentialPath` in the role's MCP JSON under
   `<synloqHome>/runtime/mcp/<agentId>.json`).
3. Confirm the file content matches the credential store: rotate the role once —
   this rewrites both sides consistently.
4. If all roles fail at once, check that `--synloq-home` (or `SYNLOQ_HOME`) resolves
   to the same home the credentials were issued into; a moved project root also
   changes the project key and orphans the old state.
5. Check the audit log for rotation/revocation events affecting the role:
   `synloq doctor --project-root <path>` prints the `audit` section (the last
   events from `<synloqHome>/data/<project-key>-audit.jsonl`); `issue`,
   `rotate`, and `revoke` entries carry the role and the timestamp.

## If tokens reached the git history

1. Rotate **every** role and the operator token immediately (hashes in the store are
   replaced, published tokens die).
2. Purge the history (force-push is a publication-time decision of the operator —
   see the production plan), but treat rotation, not history rewriting, as the
   actual containment.
3. Review the audit log (`synloq doctor` → `audit` section, or the jsonl file
   directly) and the message traffic of the affected window for misuse.

## What rotation does not protect against

- An attacker who still has local code execution as your OS user (they can read the
  new token file too) — remove the foothold first.
- Messages already delivered before revocation — they remain in the recipients'
  inboxes.
