# Live runbook: Codex verification on the real stand

**Executor:** an agent running inside Codex on this machine (Windows).
**Auditor:** Synloq dev role — validates everything afterwards against the relay
SQLite, the files, and the saved evidence. Self-reports are not evidence; saved
raw outputs are.

This runbook instantiates `test/e2e/real-clients.md` section 10 (Codex MCP
inbox, lifecycle hooks, read-only probe). **Codex active delivery is UNSUPPORTED
and stays UNSUPPORTED after this runbook** — the best achievable verdict is
MCP/HOOKS/PROBE VERIFIED.

## Path conventions

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$Stand      = "<path to the codex-code-synloq stand>"
$SynloqHome = "$env:USERPROFILE\.synloq"
$Secure     = "$Stand\evidence"                      # stand-local, never committed to the Synloq repo
$env:CODEX_HOME = "$Secure\codex-home"               # isolated Codex scope for this stand
```

`<projectKey>` = relay project key under `$SynloqHome\state\`. Never commit real
absolute paths or OS user names — see `CONTRIBUTING.md` evidence hygiene.

## Hard rules (read first)

1. Work only in `$Stand`. `$SynloqRepo` is **read-only except `pnpm build`**.
2. **Never call any `synloq_*` MCP tool from the executor session.** The bound
   role sessions own their tools.
3. Use existing visible Codex chats only; no one-shot/headless evidence.
4. One `CODEX_HOME` per role. Do not put both roles' credentials into one
   scope. No token in `config.toml` or on any command line.
5. On unexpected error: STOP, save output to `$Secure`, report BLOCKED. No
   improvised fixes, at most one retry.
6. Every command's full output goes to `$Secure` (`2>&1 | Tee-Object`).
7. **Codex sandbox.** The Codex CLI sandbox denies writes outside the
   workspace — `init`/`serve` write state under `$SynloqHome` and fail with
   `EPERM: ... .synloq\credentials\...tmp` otherwise. Run the shell with
   escalated sandbox (`codex --sandbox danger-full-access`, or approve the
   escalation prompt for these commands). Found live 2026-11-14 (D1 BLOCKED);
   a fail-loud error + full `--synloq-home` support in `serve` is tracked
   separately — until it lands, escalation is the supported path.

## D0. Preconditions

```powershell
node --version 2>&1 | Tee-Object $Secure\d0-node.txt
codex --version 2>&1 | Tee-Object $Secure\d0-codex-version.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Secure\d0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $Secure\d0-build.txt
New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
```

Record whether the surface is CLI or Desktop; record it in the evidence.

## D1. Init + relay

```powershell
New-Item -ItemType Directory -Force $Stand | Out-Null
node $SynloqRepo\dist\cli\main.js init --host generic `
  --project-root $Stand --project codex-code-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4302 --non-interactive `
  2>&1 | Tee-Object $Secure\d1-init.json

Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4302" -RedirectStandardOutput $Secure\d1-relay.log -RedirectStandardError $Secure\d1-relay.err
Start-Sleep 3
curl http://127.0.0.1:4302/v1/health 2>&1 | Tee-Object $Secure\d1-health.json
```

Save from the init JSON: `roles[*].configPath` (under
`$SynloqHome\runtime\<projectKey>\mcp\`).

Note: `--host generic` is required. Without `--host`, init defaults to
`kimi-work` and fails on a machine without the Kimi Work local control API
(`synloq: Kimi Work local-control status is unavailable`). The `generic` mode
writes only the manifest, credentials, and runtime MCP configs — no host
bindings, no visible chats, `registrationRequired: false`.

## D2. Wire the visible Codex sessions (per role)

Create the per-role homes FIRST — `codex mcp add` fails with
`failed to resolve CODEX_HOME` if the directory does not exist (found live
2026-11-14, D2 BLOCKED on arch):

```powershell
New-Item -ItemType Directory -Force $Secure\codex-home-cto, $Secure\codex-home-arch | Out-Null
```

For EACH role (`cto`, then `arch`), with the role's own `CODEX_HOME`
(`$Secure\codex-home-cto` / `$Secure\codex-home-arch` — set
`$env:CODEX_HOME` to the role's home before that role's commands):

1. Register the MCP server (uses the role config written by init):

   ```powershell
   codex mcp add synloq-<role> -- node $SynloqRepo\dist\mcp\stdio.js <role configPath>
   codex mcp list 2>&1 | Tee-Object $Secure\d2-mcp-list-<role>.txt
   ```

2. Generate `hooks.json` into the role's `CODEX_HOME` with the six events
   (`SessionStart`, `UserPromptSubmit`, `PreModelRequest`, `Stop`,
   `Interrupt`, `SessionEnd`) exactly as in real-clients.md §10 step 3
   (handler: `node $SynloqRepo\dist\cli\main.js codex-hook --config
$Secure\codex-<role>.json`). First create `$Secure\codex-<role>.json`
   (`kind: "codex"`, project `codex-code-synloq`, the role's sessionId, relay
   URL, credentialPath, `protocolVersion: 1`) per §10 step 2.
3. Start or select the intended **visible** chat under this exact `CODEX_HOME`;
   record the real session id. Trust the project hooks via `/hooks` — review
   output to `d2-hooks-review-<role>.txt`. No bypass flags.

## D3. Six-tool exercise

In the visible sessions, exercise and save each tool JSON (`d3-*.json`):

- `synloq_list` → both roles listed, no registration/permission tools;
- `synloq_send` cto→arch (`idempotencyKey: "codex-live-question-1"`) →
  immediate UUID, `stored`;
- `synloq_inbox` + bounded `synloq_wait` in arch → exact message, full
  provenance (wait timeout is normal and bounded);
- `synloq_reply` arch→cto → same thread, `inReplyTo` = question UUID;
- `synloq_inbox` in cto → reply retrievable without human copying;
- `synloq_ack` per role → own message succeeds; cross-role ack rejected.

## D4. Hook states, wrong-session rejection, probes

Per real-clients.md §10 steps 6–7:

- Hook state mapping: `idle` for SessionStart startup/resume/clear/fork and
  Stop; `busy` for compact/prompt/model-request; `unknown` for Interrupt;
  `closed` for SessionEnd. Run `doctor` after each observation
  (`d4-doctor-*.txt`). Interrupt must never read as fresh idle.
- Wrong-session rejection: pipe a `SessionStart` payload with a foreign
  `session_id` into `codex-hook` → exit 1, empty stdout, non-secret error, no
  session/heartbeat mutation (`d4-wrong-session-*.txt`).
- `node $SynloqRepo\dist\cli\main.js adapter --config $Secure\codex-<role>.json`
  must REFUSE to start active delivery for Codex (`d4-adapter-refusal.txt`).
- Read-only probes:

  ```powershell
  node $SynloqRepo\scripts\probe-codex-app-server.ts --cwd $Stand > $Secure\d4-probe.json
  node $SynloqRepo\scripts\probe-codex-app-server.ts --cwd $Stand --thread-id <CODEX_SESSION> > $Secure\d4-probe-resume.json
  ```

  Required: first run records `thread-id-not-provided`; both reports say
  `activeDeliveryClaim:false` with `visible-session-submission-not-verified`;
  initialize payloads contain no prompt/text/token/secret fields.

## D5. Relay restart durability

Stop `serve`, restart the exact same command (do NOT delete SQLite), reconnect
both visible sessions. `doctor` + inbox before/after (`d5-*.txt`): IDs and
history survive; pending messages neither disappear nor duplicate; the original
idempotency key returns the original message.

## D6. Wrap-up

Report: HEAD commit, Codex version + surface, both session ids, per-step
PASS/FAIL, probe report paths, "done" or BLOCKED. Verdict ceiling:
**MCP/HOOKS/PROBE VERIFIED — active delivery UNSUPPORTED.**

## What the auditor checks afterwards (not the executor's job)

- relay SQLite for `codex-code-synloq` (messages, acks, registrations, empty
  quarantine);
- `$Secure` completeness, no tokens in evidence, nothing under
  `$Stand\evidence` committed anywhere public;
- hook-state and wrong-session evidence vs §10 requirements;
- only then update the Codex rows in `test/e2e/real-clients.md` and
  `docs/client-compatibility.md` (separate commit).
