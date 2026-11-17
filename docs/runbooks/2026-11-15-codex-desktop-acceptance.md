# Live acceptance: Codex Desktop per-role directories (#43) and non-Kimi two-role loop (#14)

> Auth-v2 update (#1): this dated acceptance record predates mutual relay authentication.
> Its health marker is discovery only. For new runs, update relay and all callers
> together and regenerate MCP configs with trusted `project`/`agentId`; manual CLI
> commands need the local project root/home. Use the [current rollout](../security/transport-auth-v2.md).
> Historical observations below do not certify auth-v2.

**Status: PASS, 2026-11-15.** Prepared by the CTO role from PR #50 (commit
`851899a`) and the dev checklist; executed by the operator on an isolated
stand. Duration ~30–45 minutes. Operator drove the Codex Desktop GUI;
cto/dev chats observed.

## Verdict and recorded evidence

All acceptance criteria passed on a dedicated stand with an isolated relay
on `127.0.0.1:4399` and the build from commit `851899a`:

- Channel isolation: each role directory's `.codex/config.toml` carried only
  its own `synloq-<role>` server; `AGENTS.md` files were correct; `doctor`
  reported `placement.state: configured` and `ok: true` for both roles
  before and after the Desktop restart.
- Full cycle without manual copying between chats: cto→arch send
  `7ccc61ce-…` (thread `4198792d-…`) → arch inbox/ack → reply `c253ecaf-…`
  → cto inbox/ack.
- Idempotency: re-send with the same key `codex-desktop-accept-1` returned
  the original message ID `7ccc61ce-…`; no duplicate.
- Cross-role ack (each role acking the other role's message) was rejected
  with `UNAUTHORIZED` and both denials were recorded in the stand's audit
  JSONL.
- Desktop restart: the full cycle was repeated (`b90c998b-…`, reply
  `2e1d18bf-…`), history and IDs were preserved, the arch inbox listed the
  old acked message and the new one together, no duplicates.

Known limits stay honest: no active delivery on this host (reactive inbox
pattern), no host-enforced isolation beyond the observed per-role project
configuration, and absolute launcher paths require re-init after relocating
the home/runtime directory.

## Preconditions

- The code under test comes from the PR branch (not merged main at the
  time). In the worktree: `pnpm install --frozen-lockfile && pnpm build`.
- Codex Desktop ≥ 0.169.0-alpha.11.1 (the version that passed probe A).
- A dedicated stand directory, NOT production: relay port 4399 (the
  production relay on 4100 is untouched).
- PowerShell terminal for commands; Desktop GUI for chats.

## Step 1. Raise the isolated stand (~5 min)

```powershell
$Stand = "<new empty directory>"
$Home2 = "$Stand\home"
node <branch>\dist\cli\main.js init --project-root $Stand --synloq-home $Home2 `
  --relay-url http://127.0.0.1:4399 --non-interactive   # manifest from the stand's synloq.yaml
```

Before init, place a `synloq.yaml` in `$Stand` with TWO roles cto/arch, both
declaring `host: codex-desktop`. Expected output: JSON with `desktop.roles`
(paths `$Home2\runtime\<key>\roles\cto|arch`) and `desktop.nextSteps`.

```powershell
node <branch>\dist\cli\main.js serve --project-root $Stand --synloq-home $Home2 --host 127.0.0.1 --port 4399
curl http://127.0.0.1:4399/v1/health   # {"service":"synloq-relay",...}
```

## Step 2. Static check of the generated files (~5 min)

- In `$Home2\runtime\<key>\roles\cto\.codex\config.toml`: only
  `[mcp_servers.synloq-cto]`, no `synloq-arch`; the TOML carries paths, never
  tokens. Same for arch.
- Both `AGENTS.md` files: channel name, reactive note ("check synloq_inbox
  when activated; there is no automatic wake-up"), source project path.
- `doctor --project-root $Stand --synloq-home $Home2` →
  `placement.state: configured`, `ok: true` for both roles.

## Step 3. Open the roles in Codex Desktop (~10 min)

1. Open `...\roles\cto` as a project in Codex Desktop → trust dialog
   (project + MCP config) → new chat. Repeat for `...\roles\arch`.
2. In each chat: exactly ONE `synloq-*` server visible (its own). Record
   with screenshots/notes. Also check the global Desktop configuration — no
   foreign synloq servers there.
3. Give each chat its starting instruction (picked up from AGENTS.md, but
   state it explicitly): "You are the cto/arch role of the project. Use only
   the synloq-<role> channel. Reactive mode: check synloq_inbox when
   activated."

## Step 4. Exchange through the relay (~10 min)

1. In the cto chat: `synloq_send` → arch, text "ping acceptance #43",
   `expectsReply: true`, idempotencyKey `codex-desktop-accept-1`. Record
   messageId/threadId.
2. Switch to the arch chat: `synloq_inbox` → the cto message is there with
   full provenance. `synloq_ack` it → ok.
3. arch: `synloq_reply` in the same thread, "pong", `expectsReply: false`.
4. In the cto chat: `synloq_inbox` → arch's reply is visible; ack it.
5. Idempotency: repeat step 4.1 verbatim in cto → the same message ID, no
   duplicate.
6. Cross-role: in the cto chat try acking arch's message (UUID from step
   4.2) → expect `UNAUTHORIZED`.

## Step 5. Restart Desktop and repeat (~10 min)

1. Fully close Codex Desktop. `doctor` → placement still `configured` (a GUI
   restart does not break the configs).
2. Reopen both projects, continue the chats.
3. Repeat the exchange (idempotencyKey `codex-desktop-accept-2`):
   inbox/reply/ack work, history and IDs preserved, pending messages neither
   lost nor duplicated.

## PASS criteria (all)

- [x] Each chat sees only its own `synloq-<role>` server (isolation, #14).
- [x] Full send → inbox → ack → reply → inbox → ack cycle without manual
      copying between chats (#14: non-Kimi two-role live loop).
- [x] Idempotent resend → same messageId.
- [x] Cross-role ack → `UNAUTHORIZED`.
- [x] Desktop restart: history and operability preserved.
- [x] `doctor` before/after: `configured`, `ok: true`.

## On any FAIL

Stop, keep the output/screenshots, report to the cto chat — triage through
dev/Codex, the PR stays draft. Do not improvise fixes on the stand.
