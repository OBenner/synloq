# Live runbook: OpenCode sidecar adapter evidence matrix (#31)

**Executor:** an agent running inside OpenCode on this machine (Windows).
**Stand:** the adopted project `open-code-synloq` (relay on
`http://127.0.0.1:4101`, roles `cto` + `arch`, sessions already bound).
**Goal:** execute the OpenCode rows of `test/e2e/real-clients.md` on the live
stand and collect evidence; the auditor (Synloq dev) validates everything
against the relay SQLite and the OpenCode server API afterwards.

## Path conventions

Commands use variables instead of absolute local paths. Set them before running:

```powershell
$SynloqRepo = "<path to this repository checkout>"  # the Synloq repo
$Stand      = "<path to the adopted stand project>" # project name: open-code-synloq
$SynloqHome = "$env:USERPROFILE\.synloq"
```

`<projectKey>` below means the relay project key (the subdirectory name under
`$SynloqHome\state\` created by init). Never commit real absolute paths or OS
user names — see the evidence hygiene rules in `CONTRIBUTING.md`.

## Hard rules

Same as `2026-11-13-opencode-live-dod.md`: Synloq repo read-only except
`pnpm build`; never call `synloq_*` MCP tools yourself; every command's output
to the evidence directory; unexpected error → STOP, save, report BLOCKED;
no deletions, no improvisation, no retries beyond what a step says.

Evidence directory: `$Stand\evidence-matrix\`

Known facts (verify, do not assume):

- cto session: `ses_e2be1a966ffe1Dkracq6CTDWgH` ("Synloq CTO")
- arch session: `ses_e2be1a8f4ffeeZo5ERRJjJUx9r` ("Synloq Architect")
- arch credential: `$SynloqHome\credentials\<projectKey>\arch.token`
- OpenCode service URL + password:
  `~/.local/state/opencode/service.json` (`url`, `password` fields)

## M0. Preconditions and versions

```powershell
Test-NetConnection 127.0.0.1 -Port 4101 2>&1 | Tee-Object $Stand\evidence-matrix\m0-relay.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Stand\evidence-matrix\m0-head.txt
pnpm build 2>&1 | Tee-Object $Stand\evidence-matrix\m0-build.txt
& "$env:APPDATA\ai.opencode.desktop\cli\2.2.7-x64\opencode-cli.exe" --version 2>&1 | Tee-Object $Stand\evidence-matrix\m0-opencode-version.txt
node -p "require('./node_modules/@opencode-ai/sdk/package.json').version" 2>&1 | Tee-Object $Stand\evidence-matrix\m0-sdk-version.txt
```

If the relay on 4101 is not listening, start it:
`node $SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4101`
(log to `m0-relay.log`), wait 3 s.

If the bundled CLI path differs, discover it: list
`$env:APPDATA\ai.opencode.desktop\cli\` and use the newest `*-x64` directory.

## M1. Start the sidecar adapter for arch

Create `$Stand\opencode-arch.json` (exactly this shape, note
`projectRoot: "."` — it resolves relative to the config file; substitute
`<synloqHome>`/`<projectKey>` with real values, do not commit the result):

```json
{
  "version": 1,
  "kind": "opencode",
  "project": "open-code-synloq",
  "projectRoot": ".",
  "agentId": "arch",
  "sessionId": "ses_e2be1a8f4ffeeZo5ERRJjJUx9r",
  "relayUrl": "http://127.0.0.1:4101",
  "credentialPath": "<synloqHome>/credentials/<projectKey>/arch.token",
  "protocolVersion": 1,
  "baseUrl": "<url from service.json>",
  "heartbeatIntervalMs": 1000
}
```

Start it (a visible console window is expected — that is the adapter):

```powershell
Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js adapter --config $Stand\opencode-arch.json" -RedirectStandardOutput $Stand\evidence-matrix\m1-adapter.log -RedirectStandardError $Stand\evidence-matrix\m1-adapter.err
Start-Sleep 5
```

Expect: no crash, the log/err files exist. A 401 or ECONNREFUSED in
`m1-adapter.err` = BLOCKED (save and stop).

## M2. Idle OpenCode row

1. Confirm arch is idle: `GET <baseUrl>/api/session/active` → save to
   `m2-active-before.json`; arch must NOT be listed.
2. Prompt the CTO session (do NOT prompt arch):
   `POST /api/session/ses_e2be1a966ffe1Dkracq6CTDWgH/prompt`
   `{"text": "Use synloq_send to send 'matrix idle M2' to arch with expectsReply=false, then report the returned JSON."}` → `m2-prompt-cto.json`
3. Wait up to 90 s. Evidence of success: the arch session starts a turn BY
   ITSELF (poll `GET /api/session/active` every 5 s → `m2-active-during.json`;
   arch appearing there without anyone prompting it is the admission), and its
   agent acks the message.
4. Save `GET /api/session/ses_e2be1a8f4ffeeZo5ERRJjJUx9r` after the turn →
   `m2-arch-after.json`. Record the message id reported by cto.

## M3. Busy OpenCode row

1. Make arch busy: `POST /api/session/ses_e2be1a8f4ffeeZo5ERRJjJUx9r/prompt`
   `{"text": "Reply with the numbers 1 to 200, one per line, no commentary."}`
2. While it is busy (confirm via `/api/session/active` → `m3-active-busy.json`),
   have cto send 'matrix busy M3' to arch (same as M2.2) → `m3-prompt-cto.json`.
3. Expected: NO new admission while busy — arch's busy turn is uninterrupted.
   When arch goes idle, the adapter admits exactly once, arch's agent acks.
   Poll `/api/session/active` every 5 s and save the sequence to
   `m3-active-timeline.txt` with timestamps. Record both message ids.

## M4. Reconnect row

1. Stop the adapter process (the node process running `adapter --config`),
   wait 5 s, restart it exactly as in M1 → `m4-adapter-restart.log`.
2. Have cto send 'matrix reconnect M4' to arch → `m4-prompt-cto.json`.
3. Expected: exactly one admission after restart; no duplicate prompt for the
   M3 message. Save `m4-arch-after.json` and record ids.

## M5. Uncertain-result row (operator-controlled)

Skip live fault injection — record in `m5-skip.txt`:
"Not executed live; covered by conformance tests (test/review/opencode-cancellation.test.ts,
test/review/runner-recovery.test.ts) and relay-side release semantics shipped in #28."
The auditor maps this row accordingly.

## M6. Wrap-up

Leave the adapter and the relay running (the operator decides when to stop).
Report: HEAD commit, opencode + SDK versions, all message ids with their
outcomes, the adapter log tails, and "done" or BLOCKED per row.

## Auditor checklist (not the executor's job)

- relay SQLite `<projectKey>`: every reported message id exists,
  `delivery_state=acked`, exactly one claim per message, empty quarantine;
- adapter log shows `delivery:"queue"` + `resume:true` admissions, none while
  busy, no duplicates after restart;
- OpenCode API: arch session turn times align with the reported admissions;
- then `test/e2e/real-clients.md` OpenCode rows move from UNVERIFIED to the
  recorded PASS values.
