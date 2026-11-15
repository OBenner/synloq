# Live runbook: Claude Desktop (Code tab) verification on the real stand

> **Status: EXECUTED 2026-11-15 — verdict: MCP INBOX VERIFIED, active delivery
> UNSUPPORTED (disabled).** Audited by the Synloq dev role against the relay
> SQLite and saved evidence. Audit outcome and doc updates:
> `docs/client-compatibility.md` § Claude Desktop (Code tab),
> `docs/adapters/claude-code.md` § Claude Desktop (Code tab). Remaining
> GUI-only evidence (E3 pickup screenshots, E3.5 isolation, cross-role ack) is
> tracked as a follow-up operator window.

**Executor:** an agent running inside Claude Desktop (the **Code** tab) on this
machine (Windows).
**Auditor:** Synloq dev role — validates everything afterwards against the relay
SQLite, the files, and the saved evidence. Self-reports are not evidence; saved
raw outputs are.

This runbook instantiates `test/e2e/real-clients.md` for Claude Desktop. It does
NOT reuse the Claude Code CLI runbook (`2026-11-14-claude-code-live-dod.md`):
Desktop has no `--resume --mcp-config --strict-mcp-config --settings` launch
control, and `--dangerously-load-development-channels` /
`notifications/claude/channel` support is not confirmed on this surface.
**Verdict ceiling: MCP INBOX VERIFIED — active delivery stays DISABLED** unless
the E5 probes produce positive hook evidence, and even then the full C3/C5
matrix of the CLI runbook must pass separately before `activationVerifiedAt`.

## Path conventions

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$Stand      = "<path to the claude-desktop-synloq stand>"
$SynloqHome = "$env:USERPROFILE\.synloq"
$Secure     = "$Stand\evidence"                      # stand-local, never committed to the Synloq repo
$RoleCto    = "$Stand\role-cto"                      # per-role project dir (ADR-0004 placement)
$RoleArch   = "$Stand\role-arch"
```

`<projectKey>` = relay project key under `$SynloqHome\state\`. Never commit real
absolute paths or OS user names — see `CONTRIBUTING.md` evidence hygiene.

## Hard rules (read first)

1. Work only in `$Stand`. `$SynloqRepo` is **read-only except `pnpm build`**
   and the two documentation rows the auditor updates at the end.
2. **Never call any `synloq_*` MCP tool from the executor session.** The bound
   role sessions own their tools. Drive everything else through shell commands
   and curl against the relay.
3. Use visible Desktop Code-tab sessions only; no `claude -p`, no headless or
   one-shot evidence (real-clients.md §1).
4. Do not enable Bypass permissions mode, auto-approval, or steering.
5. On any unexpected error: **STOP, save the full output to `$Secure`, report
   BLOCKED with the error text.** No improvised fixes, at most one retry.
6. Every command's full output goes to `$Secure` (`2>&1 | Tee-Object`).
   Screenshots go to `$Secure` too and must not show tokens.
7. Tokens live only under `$SynloqHome\credentials\` — never in `$Stand` files
   that could be committed, never in the evidence text.
8. Do not assume config locations from other Claude-family installs on the
   machine (wrappers, third-party UIs). Discover the paths this Desktop build
   actually reads in E0/E3 and record the evidence.

## E0. Preconditions and surface discovery

```powershell
node --version 2>&1 | Tee-Object $Secure\e0-node.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Secure\e0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $Secure\e0-build.txt
```

Then record the Desktop surface itself:

1. Desktop version (Help/About or the app's settings page) →
   `e0-desktop-version.txt`.
2. Which config tree this build reads. Check, in order, and save listings
   (names only, never file contents that may hold tokens):
   - `$env:APPDATA\Claude\` (classic Desktop config, incl.
     `claude_desktop_config.json` — chat connectors);
   - `$env:USERPROFILE\.claude.json` and `$env:USERPROFILE\.claude\` (Claude
     Code harness: user settings, `projects\` session store).
     Save to `e0-config-tree.txt`. If neither exists, STOP: the Code tab harness
     config is undiscoverable and role binding cannot be evidenced.
3. Record how a Code-tab session exposes its session id (title bar, session
   details panel, or the newest `*.jsonl` under
   `~\.claude\projects\<folder-slug>\` after starting a throwaway session in
   `$Stand`) → `e0-session-id-source.txt`. This source is needed in E3.

## E1. Init + relay

```powershell
New-Item -ItemType Directory -Force $Stand, $RoleCto, $RoleArch | Out-Null
node $SynloqRepo\dist\cli\main.js init --host generic `
  --project-root $Stand --project claude-desktop-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4303 --non-interactive `
  2>&1 | Tee-Object $Secure\e1-init.json

Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4303" -RedirectStandardOutput $Secure\e1-relay.log -RedirectStandardError $Secure\e1-relay.err
Start-Sleep 3
curl http://127.0.0.1:4303/v1/health 2>&1 | Tee-Object $Secure\e1-health.json
```

Expect: `{"service":"synloq-relay","protocolVersion":1}`. Save from the init
JSON: `roles[*].configPath` and `roles[*].credentialPath`.

Note: `--host generic` is required (no host bindings, `registrationRequired:
false`); see the Codex runbook D1 for the rationale.

## E2. Automated layer (no Desktop)

1. `pnpm verify` in `$SynloqRepo` → `e2-verify.txt`. Expect all green.
2. SDK handshake per role, without any Desktop involvement: connect to
   `node $SynloqRepo\dist\cli\main.js adapter --config $Secure\claude-<role>.json`
   with the official MCP SDK stdio client (already in repo dependencies). Save
   a script `e2-sdk-handshake.mjs` under `$Secure` that:
   - starts the adapter as a child process with the role config
     (`kind: "claude"`, project `claude-desktop-synloq`, the role's
     credentialPath, relay `http://127.0.0.1:4303`, `protocolVersion: 1`, NO
     activation fields — delivery disabled);
   - performs initialize and `tools/list`;
   - asserts the tool list is exactly `synloq_list`, `synloq_send`,
     `synloq_reply`, `synloq_inbox`, `synloq_wait`, `synloq_ack` — no
     registration or permission tools;
   - writes the raw handshake and tool list to `e2-handshake-<role>.json`.

## E3. Per-role project wiring (ADR-0004 placement)

One Desktop Code-tab session per role project folder. The binding mechanism is
**project-scope MCP config** — the same signal ADR-0004 selected for Codex
Desktop. For EACH role:

1. Write `$Role<X>\.mcp.json` registering ONLY this role's server:

   ```json
   {
     "mcpServers": {
       "synloq-cto": {
         "command": "node",
         "args": [
           "<SynloqRepo>\\dist\\cli\\main.js",
           "adapter",
           "--config",
           "<Secure>\\claude-cto.json"
         ]
       }
     }
   }
   ```

   (Server name `synloq-arch` and `claude-arch.json` for the other role.)

2. Write `$Role<X>\CLAUDE.md`: role name and charter, the exact MCP server
   name to use, the reactive rule (poll `synloq_inbox` / bounded
   `synloq_wait`; active delivery is disabled on this surface), protocol rules
   (ack after reading, RESULT/BLOCKED prefixes), evidence hygiene.
3. Create the adapter config `$Secure\claude-<role>.json` per
   `docs/adapters/claude-code.md` with the role's session id discovered via the
   E0 source. No `acceptanceMessageId`, no `activationVerifiedAt`.
4. Open a NEW visible Desktop Code-tab session with project folder `$Role<X>`.
   Record: whether the `.mcp.json` server is detected (approval prompt or
   server list) → screenshot/log to `e3-mcp-pickup-<role>.*`; the real session
   id → `e3-session-<role>.txt`; the visible tool list (must be exactly the six
   `synloq_*` tools of THIS role's server) → `e3-tools-<role>.txt`.
5. **Isolation check (the shared-config risk).** In the cto session confirm the
   arch server is NOT visible, and vice versa. If project-scope config is not
   honored (both servers appear in every session, or none appear), STOP the
   two-role Desktop topology and fall back to the cross-client variant:
   one role in Desktop, the other in Claude Code CLI or OpenCode per
   real-clients.md §7. Record whichever topology was evidenced.
6. If `.mcp.json` is not picked up at all, try the user-scope harness config
   discovered in E0 (per-project section in `.claude.json`) as a second
   mechanism, record both attempts. If neither binds a server to a specific
   project folder, report BLOCKED with evidence — do not register both roles in
   one shared scope.

## E4. Six-tool exercise and message cycle

In the visible Desktop sessions (no human copies text between chats), save
JSON per call (`e4-*.json`):

- `synloq_list` → both roles, no registration/permission tools;
- `synloq_send` cto→arch (`"Please review the storage boundary"`,
  `expectsReply: true`, `idempotencyKey: "claude-desktop-live-question-1"`) →
  immediate UUID, `stored`;
- `synloq_inbox` + bounded `synloq_wait` in arch → exact message, full
  provenance (a bounded wait timeout is normal on an inbox-only surface);
- `synloq_reply` arch→cto → same threadId, `inReplyTo` = question UUID,
  `expectsReply: false`;
- each role acks only its own incoming message; a cross-role `synloq_ack`
  attempt must fail `UNAUTHORIZED` (record the error);
- idempotency: repeat the same `synloq_send` verbatim → same message UUID, no
  duplicate; same key with different text → `IDEMPOTENCY_CONFLICT`.

## E5. Capability probes (no verdict change without positive evidence)

1. **Hooks.** Write `$RoleCto\.claude\settings.json` with `SessionStart` and
   `Stop` command hooks appending one line to `$Secure\hooks.log`; start and
   stop the cto session; save the log. Hooks firing means the busy/idle signal
   MIGHT be feasible on this surface — record raw results only. Active
   delivery stays disabled regardless: the CLI runbook's C3/C5 matrix must
   pass on Desktop before any activation is considered.
2. **Channels.** Record whether this Desktop build exposes any equivalent of
   `--dangerously-load-development-channels` / `notifications/claude/channel`
   (expected: none) → `e5-channels.txt`.
3. **Busy behavior.** Send a message to arch while arch is mid-response;
   record that it stays pending in the relay and is retrieved via inbox after
   the response finishes. No injection is expected on this surface.

## E6. Relay restart durability and wrap-up

Stop `serve`, restart the exact same command (do NOT delete SQLite), reconnect
both Desktop sessions (close/reopen the sessions in the same project folders).
`doctor` + `synloq_inbox` before and after (`e6-*.txt`): IDs and history
survive; pending messages neither disappear nor duplicate; the original
idempotency key returns the original message.

Report: HEAD commit, Desktop version, config tree actually read, both session
ids, per-step PASS/FAIL, probe results, "done" or BLOCKED. Verdict
recommendation: **MCP INBOX VERIFIED — active delivery UNSUPPORTED** unless E5
produced positive hook evidence, in which case the CLI runbook C3/C5 matrix is
the separate gate.

## What the auditor checks afterwards (not the executor's job)

- relay SQLite for `claude-desktop-synloq` (messages, acks, registrations,
  empty quarantine, no duplicate deliveries);
- `$Secure` completeness: every step has its file, no tokens, no screenshots
  with secrets;
- the topology actually evidenced (per-role project dirs vs cross-client
  fallback) matches what E3 recorded;
- only then update `docs/client-compatibility.md` (new Claude Desktop row) and
  `docs/adapters/claude-code.md` (Desktop section) — separate commit, VERIFIED
  rows only with message IDs.
