# Live runbook: OpenCode init DoD (#29) on the real stand

**Executor:** an agent running inside OpenCode on this machine (Windows).
**Auditor:** Synloq dev role — validates everything afterwards against the relay
SQLite, the files, and the OpenCode server API. Self-reports are not evidence;
saved raw outputs are.

## Path conventions

Commands use variables instead of absolute local paths. Set them before running:

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$NewStand   = "<path to the fresh test project>"     # project name: open-code-synloq-new
$Stand      = "<path to the adopted stand project>"  # project name: open-code-synloq
$SynloqHome = "$env:USERPROFILE\.synloq"
```

`<projectKey>` below means the relay project key (the subdirectory name under
`$SynloqHome\state\` created by init). Never commit real absolute paths or OS
user names — see the evidence hygiene rules in `CONTRIBUTING.md`.

## Hard rules (read first)

1. Work only in `$NewStand`, `$Stand`, and evidence files. The Synloq repo
   `$SynloqRepo` is **read-only except `pnpm build`** — do not edit, commit, or
   delete anything there.
2. **Never call any `synloq_*` MCP tool yourself.** Drive everything through
   shell commands and HTTP calls. The role sessions own their tools.
3. On any unexpected error: **STOP, save the full output to the evidence
   directory, and report BLOCKED with the error text.** Do not improvise fixes,
   do not retry more than once, do not delete or recreate anything unless a step
   explicitly says so.
4. Every command's full output goes to the evidence directory listed in the
   step. Use `2>&1 | Tee-Object -FilePath <file>` in PowerShell.
5. The OpenCode desktop app must be running. If a step fails with "OpenCode
   service is unavailable", ask the operator to start it, then retry once.

## Part A — fresh project DoD (`open-code-synloq-new`)

Evidence directory: `$NewStand\evidence\`

### A0. Preconditions

```powershell
node --version 2>&1 | Tee-Object -FilePath $NewStand\evidence\a0-node.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $NewStand\evidence\a0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $NewStand\evidence\a0-build.txt
```

Expect: build exits 0. Record the HEAD commit — the auditor compares it.

### A1. Init

```powershell
New-Item -ItemType Directory -Force $NewStand | Out-Null
node $SynloqRepo\dist\cli\main.js init --host opencode `
  --project-root $NewStand --project open-code-synloq-new `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4201 --non-interactive `
  2>&1 | Tee-Object $NewStand\evidence\a1-init.json
```

Expect: JSON with `roles[*].sessionId` filled (`ses_...`). Save the two
sessionIds — they are needed below. If `permissionsApplied: false` appears,
record it (known fail-soft, not a failure).

### A2. File checks

```powershell
Get-Content $NewStand\opencode.json | Tee-Object $NewStand\evidence\a2-opencode.json
Get-Content $NewStand\synloq.yaml | Tee-Object $NewStand\evidence\a2-manifest.yaml
```

### A3. Relay up

```powershell
Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $NewStand --host 127.0.0.1 --port 4201" -RedirectStandardOutput $NewStand\evidence\a3-relay.log -RedirectStandardError $NewStand\evidence\a3-relay.err
Start-Sleep 3
```

### A4. Visible sessions + message cycle

For each sessionId from A1 (call them `$CTO` and `$ARCH`):

1. Confirm existence via the OpenCode API (discover the base URL first with
   `opencode api get /api/info` — use `urls[0]`), e.g.:
   `curl http://127.0.0.1:<port>/api/session/$CTO` → save to `a4-session-cto.json`.
2. Post to the CTO session:
   `POST /api/session/$CTO/prompt` body `{"text": "Use your synloq_send tool to send 'stand check A4' to arch with expectsReply=false, then call synloq_list and report the raw JSON of both calls."}` → save response to `a4-prompt-cto.json`.
3. Wait ~60 s, then post to the ARCH session:
   `{"text": "Call synloq_inbox and synloq_ack for any pending message, then report the raw JSON."}` → save to `a4-prompt-arch.json`.
4. If the OpenCode UI asks the operator to approve the first MCP tool use in a
   session (G7), pause and ask the operator to approve, then continue.

Expect: cto reports a message id; arch's inbox contains that same id.
Save whatever the sessions return to `a4-result-cto.txt` / `a4-result-arch.txt`.

### A5. Re-run init (idempotency)

Repeat the A1 command exactly → `a5-init-rerun.json`.
Expect: identical `sessionId` values for both roles. Then:

```powershell
Get-FileHash $NewStand\opencode.json | Tee-Object $NewStand\evidence\a5-opencode-hash.txt
```

### A6. Wrap-up Part A

Stop the relay process started in A3 (find the node process with `--port 4201`
and stop it). Report: HEAD commit, both sessionIds, permissionsApplied flags,
message id from A4, and "Part A done" or BLOCKED with evidence.

## Part B — adopt the existing manual stand (`open-code-synloq`)

Evidence directory: `$Stand\evidence-dod\`
Known existing sessions (from the manual stand, 2026-11-13):

- CTO: `ses_e2be1a966ffe1Dkracq6CTDWgH`
- Architect: `ses_e2be1a8f4ffeeZo5ERRJjJUx9r`

### B0. Pre-checks

```powershell
Get-FileHash $Stand\opencode.json | Tee-Object $Stand\evidence-dod\b0-opencode-before.txt
```

If a relay is already listening on 4101 (`Test-NetConnection 127.0.0.1 -Port 4101`),
leave it running; otherwise start one like A3 but with
`--project-root $Stand --port 4101` and log to
`evidence-dod\b0-relay.log`.

Verify the two known sessions still exist via the API (`GET /api/session/ses_...`),
save to `b0-session-cto.json` / `b0-session-arch.json`. **If either returns
404: skip the `--conversation` flags in B1 entirely** (init will create fresh
sessions; record that this happened).

### B1. Adopting init

```powershell
node $SynloqRepo\dist\cli\main.js init --host opencode `
  --project-root $Stand --project open-code-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --conversation cto:ses_e2be1a966ffe1Dkracq6CTDWgH `
  --conversation arch:ses_e2be1a8f4ffeeZo5ERRJjJUx9r `
  --relay-url http://127.0.0.1:4101 --non-interactive `
  2>&1 | Tee-Object $Stand\evidence-dod\b1-init.json
```

Expect: JSON with `sessionId` equal to the two known ids (bind, not create).
A `SynloqError INVALID_INPUT ... does not exist` means the pre-check lied —
STOP and report BLOCKED.

### B2. Post-checks

```powershell
Get-Content $Stand\opencode.json | Tee-Object $Stand\evidence-dod\b2-opencode-after.json
Get-Content $SynloqHome\state\<projectKey>.json | Tee-Object $Stand\evidence-dod\b2-team-state.json
Get-Item $SynloqHome\credentials\<projectKey>\*.token | Select-Object Name,LastWriteTime | Tee-Object $Stand\evidence-dod\b2-credentials.txt
```

Expect: opencode.json `synloq-*` entries now use the generated command shape;
team state has `kind: "opencode"` entries bound to the known sessionIds;
credential token files were NOT rewritten (timestamps unchanged from before B1).

### B3. Live cycle on the adopted stand

Same as A4, but with the adopted sessionIds and port 4101; evidence files
`b3-*.json/txt`.

### B4. Wrap-up Part B

Report: whether the known sessions were bound or recreated, the B2 findings,
the B3 message id, and "Part B done" or BLOCKED with evidence.

## What the auditor checks afterwards (not the executor's job)

- relay SQLite per project (messages, acks, registrations, empty quarantine),
- team-state and opencode.json contents vs the saved evidence,
- `GET /api/session/{id}` for every recorded sessionId,
- byte-level idempotency of the A5 re-run,
- credentials reuse (timestamps) in B2.
