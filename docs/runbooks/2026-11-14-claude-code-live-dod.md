# Live runbook: Claude Code verification on the real stand

**Executor:** an agent running inside Claude Code on this machine (Windows).
**Auditor:** Synloq dev role — validates everything afterwards against the relay
SQLite, the files, and the saved evidence. Self-reports are not evidence; saved
raw outputs are.

This runbook instantiates `test/e2e/real-clients.md` sections 3–8 for a
stand-alone Claude Code stand (both roles are Claude sessions). The matrix file
owns the verdicts; this runbook produces the evidence.

## Path conventions

Commands use variables instead of absolute local paths. Set them before running:

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$Stand      = "<path to the claude-code-synloq stand>"
$SynloqHome = "$env:USERPROFILE\.synloq"
$Secure     = "$Stand\evidence"                      # stand-local, never committed to the Synloq repo
```

`<projectKey>` below means the relay project key (the subdirectory name under
`$SynloqHome\state\` created by init). Never commit real absolute paths or OS
user names — see the evidence hygiene rules in `CONTRIBUTING.md`.

## Hard rules (read first)

1. Work only in `$Stand`. The Synloq repo `$SynloqRepo` is **read-only except
   `pnpm build`**.
2. **Never call any `synloq_*` MCP tool from the executor session.** The two
   bound role sessions own their tools. Drive everything else through shell
   commands.
3. Use existing visible Claude sessions only. Never use `claude -p` or any
   one-shot subprocess as acceptance evidence (real-clients.md §1).
4. Do not enable `--dangerously-skip-permissions`, auto-approval, or steering.
5. On any unexpected error: **STOP, save the full output to `$Secure`, report
   BLOCKED with the error text.** Do not improvise fixes; do not retry more
   than once.
6. Every command's full output goes to `$Secure` (`2>&1 | Tee-Object`).
7. Tokens live only under `$SynloqHome\credentials\` — never in `$Stand` files
   that could be committed, never in the evidence text.

## C0. Preconditions

```powershell
node --version 2>&1 | Tee-Object $Secure\c0-node.txt
claude --version 2>&1 | Tee-Object $Secure\c0-claude-version.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Secure\c0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $Secure\c0-build.txt
```

Expect: build exits 0. Record the HEAD commit and the Claude Code version.

## C1. Init + relay

```powershell
New-Item -ItemType Directory -Force $Stand | Out-Null
node $SynloqRepo\dist\cli\main.js init `
  --project-root $Stand --project claude-code-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4301 --non-interactive `
  2>&1 | Tee-Object $Secure\c1-init.json
```

Expect: JSON with `roles[*].configPath` under `$SynloqHome\runtime\<projectKey>\mcp\`
and `credentialPath` under `$SynloqHome\credentials\<projectKey>\`. Save both.

```powershell
Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4301" -RedirectStandardOutput $Secure\c1-relay.log -RedirectStandardError $Secure\c1-relay.err
Start-Sleep 3
curl http://127.0.0.1:4301/v1/health 2>&1 | Tee-Object $Secure\c1-health.json
```

Expect: `{"service":"synloq-relay","protocolVersion":1}`.

## C2. Wire the visible Claude sessions

For EACH role (`cto`, then `arch` — call their session ids `$CTO` and `$ARCH`):

1. Open or resume an existing **visible** Claude session anchored at `$Stand`.
   Record its real session id (Claude shows it in `/status`; save to
   `c2-session-<role>.txt`). Do not create hidden sessions.
2. Create the channel adapter config `$Secure\claude-<role>.json` per
   real-clients.md §4 (`kind: "claude"`, project `claude-code-synloq`, the
   role's sessionId, relay `http://127.0.0.1:4301`, the role's credentialPath,
   `protocolVersion: 1`). No activation field yet.
3. Create `$Secure\claude-mcp-<role>.json` (server `synloq` →
   `node $SynloqRepo\dist\cli\main.js adapter --config $Secure\claude-<role>.json`)
   and `$Secure\claude-settings-<role>.json` with the six hooks
   (`SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`,
   `PreToolUse`) exactly as in real-clients.md §4.
4. Resume the same visible session:

   ```powershell
   claude --resume $<ROLE_SESSION> `
     --mcp-config $Secure\claude-mcp-<role>.json --strict-mcp-config `
     --settings $Secure\claude-settings-<role>.json `
     --dangerously-load-development-channels server:synloq `
     2>&1 | Tee-Object $Secure\c2-launch-<role>.txt
   ```

5. Record: startup warning, channel registration notice, negotiated MCP
   revision, both experimental capabilities. The tool list must be exactly
   `synloq_list`, `synloq_send`, `synloq_reply`, `synloq_inbox`,
   `synloq_wait`, `synloq_ack` — no registration or permission tools.
6. Run `node $SynloqRepo\dist\cli\main.js doctor --project-root $Stand` →
   `c2-doctor-<role>.txt`. Expect: protocol `1`, state reporting on, active
   delivery **disabled** (no `activationVerifiedAt`).

## C3. Acceptance resolution (per role)

Follow real-clients.md §5 exactly, per role:

1. With active delivery disabled, have the OTHER already-accepted role (or the
   operator via relay inspection) place one probe message to this role; record
   its relay UUID. For the FIRST role there is no accepted peer yet: the
   operator injects the probe by asking the other role's session to
   `synloq_send` (inbox path works without acceptance).
2. Close the session, add `"acceptanceMessageId": "<probe UUID>"` to
   `claude-<role>.json` (never `activationVerifiedAt` at this step), resume with
   the exact C2 command.
3. Confirm exactly one `notifications/claude/channel` admission for that UUID
   with full provenance; notification alone is `submitted`; only the matching
   `UserPromptSubmit` hook makes it `delivered`; a different message is NOT
   injected (one-message acceptance consumed).
4. Save evidence; only then remove `acceptanceMessageId` and set
   `activationVerifiedAt` to the actual timestamp; resume once more with the
   production configuration.

If any observation fails: remove both fields, leave the role UNVERIFIED, STOP.

## C4. Message cycle cto ↔ arch

Both roles accepted. In the visible `cto` session ask it to call
`synloq_send(to=arch, text="Please review the storage boundary",
expectsReply=true, idempotencyKey="claude-live-question-1")`.

Expect and record (`c4-*.json`):

- immediate message UUID with `stored` acceptance;
- one channel admission in the visible `arch` session once it is freshly idle
  (no human copies text between chats);
- `arch` replies via `synloq_reply` (same threadId, `inReplyTo` = question
  UUID, `expectsReply=false`);
- each role acks only its own incoming message; a cross-role `synloq_ack`
  attempt must fail `UNAUTHORIZED` (record the error);
- idempotency: repeat the same `synloq_send` verbatim → same message UUID, no
  duplicate visible entry; same key with different text →
  `IDEMPOTENCY_CONFLICT`.

## C5. Busy / idle / reconnect / relay restart

Execute the Claude rows of the real-clients.md §8 matrix:

- **Busy:** start a long response in `arch`, send from `cto` before `Stop` →
  no channel injection while busy, message stays pending.
- **Idle:** let the response finish; fresh `Stop` hook releases exactly one
  FIFO notification; hook supplies delivered evidence.
- **Reconnect:** close and resume the `arch` session with the same configs →
  same-session registration, no duplicate visible message.
- **Relay restart:** stop the `serve` process, restart the exact same command
  (do NOT delete SQLite), reconnect both sessions → IDs and history retained,
  pending count returns to zero. Capture `doctor` before and after
  (`c5-doctor-before.txt` / `c5-doctor-after.txt`).

Do not use sleeps as proof; observe a fresh hook/event per row.

## C6. Wrap-up

Report: HEAD commit, Claude version, both session ids, both acceptance
timestamps, the C4 message/thread UUIDs, per-row PASS/FAIL for C5, and
"done" or BLOCKED with evidence. Leave the relay running for the auditor
unless told otherwise.

## What the auditor checks afterwards (not the executor's job)

- relay SQLite for `claude-code-synloq`: messages, acks, registrations, empty
  quarantine, no duplicate deliveries;
- `$Secure` completeness: every step has its file, no tokens in evidence;
- `doctor` output vs the matrix rows;
- only then update the Claude rows in `test/e2e/real-clients.md` and
  `docs/client-compatibility.md` (separate commit, VERIFIED with message IDs).
