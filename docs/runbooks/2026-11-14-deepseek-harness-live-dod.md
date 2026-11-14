# Live runbook: DeepSeek Harness (dsh) verification on the real stand

**Executor:** an agent running inside DeepSeek Harness on this machine
(Windows). **Auditor:** Synloq dev role — validates everything afterwards
against the relay SQLite, the files, and the saved evidence. Self-reports are
not evidence; saved raw outputs are.

DeepSeek Harness (`dsh`, `@deepseek-ai/dsh`) is DeepSeek's open-source agent
runtime (Cordis-based, MIT, developer preview). It connects external MCP servers
through the official `@deepseek-ai/dsh-mcp-client` plugin (one plugin row per
server; tools surface as `mcp__<serverName>__<tool>`). **There is no Synloq
adapter for dsh**: this runbook verifies the MCP inbox profile only. Active
delivery is UNSUPPORTED; role state stays `unknown`. Expect config churn — dsh
is a developer preview; record exact versions.

## Path conventions

```powershell
$SynloqRepo = "<path to this repository checkout>"   # the Synloq repo
$Stand      = "<path to the deepseek-harness-synloq stand>"
$SynloqHome = "$env:USERPROFILE\.synloq"
$Secure     = "$Stand\evidence"                      # stand-local, never committed to the Synloq repo
```

`<projectKey>` = relay project key under `$SynloqHome\state\`. Never commit real
absolute paths or OS user names — see `CONTRIBUTING.md` evidence hygiene.

## Hard rules (read first)

1. Work only in `$Stand`. `$SynloqRepo` is **read-only except `pnpm build`**.
2. **Never call any `synloq_*`/`mcp__synloq-*__*` tool from the executor
   session.** The bound role sessions own their tools.
3. Acceptance evidence comes only from **visible sessions in the dsh Web UI**.
   Never use `dsh --profile <name> "one-shot task"` / headless runs as
   acceptance evidence (same rule as `opencode run` / `claude -p`).
4. On unexpected error: STOP, save output to `$Secure`, report BLOCKED. No
   improvised fixes, at most one retry.
5. Every command's full output goes to `$Secure` (`2>&1 | Tee-Object`).
6. Tokens stay under `$SynloqHome\credentials\`; dsh profile configs must
   reference only `command`/`args` — never token values.
7. dsh can execute code with the harness's own tools; keep the stand's
   permission policy default-deny and do not auto-approve anything.

## H0. Preconditions

```powershell
node --version 2>&1 | Tee-Object $Secure\h0-node.txt
dsh --version 2>&1 | Tee-Object $Secure\h0-dsh-version.txt
# if dsh is not on PATH: npx @deepseek-ai/dsh --version | Tee-Object $Secure\h0-dsh-version.txt
cd $SynloqRepo
git log --oneline -1 2>&1 | Tee-Object $Secure\h0-synloq-head.txt
pnpm build 2>&1 | Tee-Object $Secure\h0-build.txt
```

Record the dsh version exactly (release candidate suffix included) and the
installed `@deepseek-ai/dsh-mcp-client` version once added in H2.

## H1. Init + relay

```powershell
New-Item -ItemType Directory -Force $Stand | Out-Null
node $SynloqRepo\dist\cli\main.js init --host generic `
  --project-root $Stand --project deepseek-harness-synloq `
  --role "cto:CTO:Technical strategy, task decomposition, and coordination" `
  --role "arch:Architect:Architecture review, risks, and verification" `
  --relay-url http://127.0.0.1:4304 --non-interactive `
  2>&1 | Tee-Object $Secure\h1-init.json

Start-Process node -ArgumentList "$SynloqRepo\dist\cli\main.js serve --project-root $Stand --host 127.0.0.1 --port 4304" -RedirectStandardOutput $Secure\h1-relay.log -RedirectStandardError $Secure\h1-relay.err
Start-Sleep 3
curl http://127.0.0.1:4304/v1/health 2>&1 | Tee-Object $Secure\h1-health.json
```

Save `roles[*].configPath` from the init JSON.

## H2. Wire MCP into dsh (one profile per role)

Roles must not see each other's credentials, so use TWO dsh profiles, anchored
at `$Stand` (e.g. `cto` and `arch`). In each profile's plugin configuration,
add one MCP client row (adjust the exact file/keys to the installed dsh
version — record any deviation):

```yaml
- id: mcp-synloq-<role>
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: synloq-<role>
    transport: stdio
    command: node
    args: ["<SynloqRepo>\\dist\\mcp\\stdio.js", "<role configPath from H1>"]
```

Then:

1. Start the Web UI (`dsh web` / `npx @deepseek-ai/dsh web`) and open or create
   one **visible** session per profile; record both session ids
   (`h2-sessions.txt`).
2. In each session, ask the agent to list its available tools. Expect the six
   Synloq tools namespaced as `mcp__synloq-<role>__synloq_list`, `..._send`,
   `..._reply`, `..._inbox`, `..._wait`, `..._ack` — and the OTHER role's
   server absent (`h2-tools-<role>.txt`).

## H3. Message cycle cto → arch (inbox profile)

1. In the `cto` session, ask the agent to call
   `mcp__synloq-cto__synloq_send(to=arch, text="Please review the storage
boundary", expectsReply=true, idempotencyKey="dsh-live-question-1")`. Save
   the JSON (`h3-send.json`): immediate UUID, `stored`.
2. **There is no active delivery** — switch to the `arch` session yourself and
   ask its agent for `synloq_inbox` (optionally bounded `synloq_wait`). Save
   (`h3-inbox.json`): exact message, project `deepseek-harness-synloq`, from
   `cto`, full thread/UUID provenance.
3. In `arch`: `synloq_ack`, then
   `synloq_reply(inReplyTo=<UUID>, text="The storage boundary is approved",
expectsReply=false, idempotencyKey="dsh-live-reply-1")` (`h3-reply.json`).
4. Back in `cto`: the reply is retrievable via `synloq_inbox` with the original
   threadId; `synloq_ack` it (`h3-cto-inbox.json`).
5. Cross-role ack attempt → rejection (`h3-cross-ack.txt`).
6. Idempotency: repeat the exact send → same UUID, no duplicate; same key +
   different text → `IDEMPOTENCY_CONFLICT` (`h3-idempotency.json`).

## H4. Relay restart durability

Stop `serve`, restart the exact same command (do NOT delete SQLite). Reconnect
both sessions. Verify history, no loss/duplicates, original idempotency key
returns the original message (`h4-*.json`). Capture `doctor` before/after
(`h4-doctor-before.txt` / `h4-doctor-after.txt`). Role state stays `unknown` —
the honest inbox-only profile.

## H5. Wrap-up

Report: HEAD commit, dsh + plugin versions, both session ids, the H3
message/thread UUIDs, PASS/FAIL per step, "done" or BLOCKED. Verdict ceiling:
**MCP INBOX VERIFIED — active delivery UNSUPPORTED, state always `unknown`.**

Open research item (record, do not implement): dsh's append-only typed event
log and Cordis plugin lifecycle may allow a future state/adapter integration —
note what the installed version exposes, nothing more.

## What the auditor checks afterwards (not the executor's job)

- relay SQLite for `deepseek-harness-synloq` (messages, acks, empty quarantine);
- `$Secure` completeness, no tokens in evidence or profile configs;
- only then add the dsh rows to `test/e2e/real-clients.md` and
  `docs/client-compatibility.md` (separate commit, inbox-only verdict).
