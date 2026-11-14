# Live runbook: ZCode (Z.ai) verification on the real stand

**Executor:** an agent running inside ZCode on this machine (Windows).
**Auditor:** Synloq dev role — validates everything afterwards against the relay
SQLite, the files, and the saved evidence. Self-reports are not evidence; saved
raw outputs are.

ZCode (zcode.z.ai) supports stdio/HTTP/SSE MCP servers and workspace-scope MCP
config at `<project root>\.zcode\config.json` (`mcp.servers`), auto-connected at
session start. **There is no Synloq adapter for ZCode**: this runbook verifies
the MCP inbox profile only (like the Kimi inbox-only boundary). Active delivery
is UNSUPPORTED; role state stays `unknown`. Do not claim more.

## Path conventions

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$Stand      = "<path to the z-code-synloq stand>"
$SynloqHome = "$env:USERPROFILE\.synloq"
$Secure     = "$Stand\evidence"                      # stand-local, never committed to the Synloq repo
```

`<projectKey>` = relay project key under `$SynloqHome\state\`. Never commit real
absolute paths or OS user names — see `CONTRIBUTING.md` evidence hygiene.

## Hard rules (read first)

1. Work only in `$Stand`. `$SynloqRepo` is **read-only except `pnpm build`**.
2. **Never call any `synloq_*` MCP tool from the executor session.** The bound
   role sessions own their tools.
3. Use existing visible ZCode chats only; no headless/one-shot evidence.
4. On unexpected error: STOP, save output to `$Secure`, report BLOCKED. No
   improvised fixes, at most one retry.
5. Every command's full output goes to `$Secure` (`2>&1 | Tee-Object`).
6. Tokens stay under `$SynloqHome\credentials\`; `.zcode\config.json` must
   contain only `command`/`args` — never token values.

## Z0. Preconditions

```powershell
node --version 2>&1 | Tee-Object $Secure\z0-node.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Secure\z0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $Secure\z0-build.txt
```

Record the ZCode version/build from the app (About or settings page) into
`z0-zcode-version.txt`. If a `zcode` CLI exists on PATH, record
`zcode --version` too; if not, record "no CLI on PATH" — that is not a failure.

## Z1. Init + relay

```powershell
New-Item -ItemType Directory -Force $Stand | Out-Null
node $SynloqRepo\dist\cli\main.js init `
  --project-root $Stand --project z-code-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4303 --non-interactive `
  2>&1 | Tee-Object $Secure\z1-init.json

Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4303" -RedirectStandardOutput $Secure\z1-relay.log -RedirectStandardError $Secure\z1-relay.err
Start-Sleep 3
curl http://127.0.0.1:4303/v1/health 2>&1 | Tee-Object $Secure\z1-health.json
```

Save `roles[*].configPath` from the init JSON.

## Z2. Wire MCP into ZCode (workspace scope)

Create `$Stand\.zcode\config.json` (workspace scope wins for this stand; the
file may be committed to the stand repo — it holds no secrets):

```json
{
  "mcp": {
    "servers": {
      "synloq-cto": {
        "command": "node",
        "args": ["<SynloqRepo>\\dist\\mcp\\stdio.js", "<cto configPath from Z1>"]
      },
      "synloq-arch": {
        "command": "node",
        "args": ["<SynloqRepo>\\dist\\mcp\\stdio.js", "<arch configPath from Z1>"]
      }
    }
  }
}
```

Then:

1. Open the stand workspace in ZCode. Workspace MCP servers connect
   automatically at session start.
2. Open TWO visible chats; designate one `cto`, one `arch`. In each chat,
   disable the OTHER role's server (Settings → MCP Servers → toggle), so each
   chat sees exactly its own role's tools. Record the final enabled state
   (`z2-mcp-state.txt`, screenshot or `/mcp`-equivalent list output).
3. In each chat, ask the agent to list its synloq tools. Expect exactly
   `synloq_list`, `synloq_send`, `synloq_reply`, `synloq_inbox`,
   `synloq_wait`, `synloq_ack` (`z2-tools-<role>.txt`).

## Z3. Message cycle cto → arch (inbox profile)

1. In the `cto` chat, ask the agent to call
   `synloq_send(to=arch, text="Please review the storage boundary",
expectsReply=true, idempotencyKey="zcode-live-question-1")`. Save the JSON
   (`z3-send.json`): immediate UUID, `stored`.
2. **There is no active delivery** — switch to the `arch` chat yourself and ask
   its agent to call `synloq_inbox` (optionally bounded `synloq_wait`). Save
   (`z3-inbox.json`): exact message, project `z-code-synloq`, from `cto`, full
   thread/UUID provenance.
3. In `arch`, `synloq_ack` the message, then
   `synloq_reply(inReplyTo=<UUID>, text="The storage boundary is approved",
expectsReply=false, idempotencyKey="zcode-live-reply-1")` (`z3-reply.json`).
4. Back in `cto`: `synloq_inbox` shows the reply with the original threadId.
   `synloq_ack` it (`z3-cto-inbox.json`).
5. Cross-role ack: in `cto`, attempt to ack arch's message UUID again after
   arch already acked — expect rejection (`z3-cross-ack.txt`).
6. Idempotency: repeat the exact `synloq_send` from step 1 → same UUID, no
   duplicate; same key + different text → `IDEMPOTENCY_CONFLICT`
   (`z3-idempotency.json`).

## Z4. Relay restart durability

Stop `serve`, restart the exact same command (do NOT delete SQLite). Reconnect
both chats (new session start reconnects workspace MCP). Verify via
`synloq_inbox` in both roles: history intact, no loss, no duplicates; the old
idempotency key still returns the original message (`z4-*.json`). Capture
`node $SynloqRepo\dist\cli\main.js doctor --project-root $Stand` before/after
(`z4-doctor-before.txt` / `z4-doctor-after.txt`). Expect role state `unknown`
throughout — that is the honest inbox-only profile.

## Z5. Wrap-up

Report: HEAD commit, ZCode version, both chats' tool lists, the Z3
message/thread UUIDs, PASS/FAIL per step, "done" or BLOCKED. Verdict ceiling:
**MCP INBOX VERIFIED — active delivery UNSUPPORTED, state always `unknown`.**

Open research item (record, do not implement): whether ZCode exposes lifecycle
hooks or plugin events usable for busy/idle state reporting.

## What the auditor checks afterwards (not the executor's job)

- relay SQLite for `z-code-synloq` (messages, acks, empty quarantine);
- `$Secure` completeness, no tokens, `.zcode\config.json` contains no secrets;
- only then add the ZCode rows to `test/e2e/real-clients.md` and
  `docs/client-compatibility.md` (separate commit, inbox-only verdict).
