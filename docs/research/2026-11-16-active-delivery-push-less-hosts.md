# Delivery and wake-up mechanisms by host (#67)

Date: 2026-11-16. Status: research recommendation for dev review, not an
implementation or a new live-support verdict. Source baseline: Synloq
`6c246f9`. This stage changes only this note. README and compatibility
claims should change with the approved implementation and its evidence.

## Distinguish the outcomes

- **Autonomous wake:** a message arriving starts work in the exact existing
  visible role session without the operator activating that session.
- **Next-interaction injection:** a hook adds an inbox reminder when the
  operator next interacts with that same session. This cannot wake an idle
  session on its own; interaction with another chat is not sufficient.
- **Human notification:** a toast asks the operator to open the role. It
  does not constitute model execution, message delivery, or acknowledgement.

Instructions to check the inbox on activation already exist. A long poll
can help an already running agent, but does not by itself start a stopped
turn. Neither is evidence of autonomous wake.

## Recommended decisions

| Host / surface                    | Recommendation for the next approved stage                                                                                                                                  | Autonomous wake status                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OpenCode desktop service          | Reuse the existing sidecar runner and queued prompt API; diagnose missing runtime wiring on the nine-role stand before adding another mechanism                             | Previously verified on desktop 2.2.7 with a sidecar; automatic MCP-only bootstrap does not start it |
| Codex Desktop                     | Probe `codex queue --thread <exact UUID> --message <reminder> --resume` against the server owning that visible chat; require positive execution evidence before integration | Candidate supported by local CLI help; Desktop wake and receipt semantics unverified                |
| Generic / Claude Desktop Code tab | Prototype SessionStart/UserPromptSubmit inbox reminders only after Desktop context-injection conformance; retain manual inbox fallback                                      | Next-interaction only; no autonomous wake established                                               |
| Other generic clients             | Do not infer Claude hook support from the generic label; offer opt-in human notification only if requested                                                                  | No portable autonomous wake contract                                                                |

An OS watcher is a fallback product choice, not a delivery implementation.
It needs an interactive user-session owner, content-free counts, deduplication,
rate limiting and quiet hours. A background relay/service may have no usable
desktop notification session. Do not enable a global watcher as a side effect
of this research.

## OpenCode: capability versus deployed runtime

The premise that OpenCode has no push API is contradicted by repository
evidence:

1. [Host capabilities](../../src/config/hosts.ts) marks OpenCode
   `hasPush: true`. [OpenCodeAdapter](../../src/adapters/opencode.ts)
   advertises active delivery and sends
   `POST /api/session/<sessionId>/prompt` with
   `delivery: "queue", resume: true`. It validates the admission against
   the intended session/message. Merely queueing without resume is not
   equivalent to scheduling execution.
2. [Recorded conformance](../../test/e2e/real-clients.md) reports an idle
   self-admission about three seconds after send on 2026-11-13 (r3 M2),
   busy suppression followed by admission (r3b), and restart recovery
   (r3 M4). These are prior recorded observations, not tests rerun today.
3. [The adapter guide](../adapters/opencode.md) explicitly requires a
   separate operator-configured adapter process. Its
   [runbook](../runbooks/2026-11-13-opencode-adapter-matrix.md) starts that
   sidecar before the idle/busy tests.
4. [OpenCode init](../../src/init/opencode-host.ts) provisions sessions and
   MCP configuration, but does not start a delivery sidecar.
   [MCP stdio](../../src/mcp/stdio.ts) starts relay supervision for an
   OpenCode binding; its delivery lifecycle is conditional on
   `configuration.kimiWork`. The
   [OpenCode MCP test](../../test/mcp/stdio-opencode-relay.test.ts)
   explicitly covers starting the relay without a Kimi lifecycle.
   [Standalone adapter composition](../../src/cli/adapter.ts) is the path
   that actually constructs the OpenCode HttpAdapterRunner and stored-ping
   watcher.

**Established conclusion:** host capability does not imply a running adapter.
Fresh dist with only the generated OpenCode MCP configuration can be
inbox-only. This is a runtime/provisioning gap, not proof that the prompt API
cannot reach the visible session. Do not flip the host flag to false merely
because the sidecar is absent.

**Incident attribution remains open:** the 2026-11-15 liveness observation
does not include a process inventory, adapter configuration, service version,
loaded build identity or request trace. It cannot establish whether tester
had no sidecar, stale code, wrong binding, failed authentication, stale state,
or an admission failure. No production process, credential or database was
inspected in this research stage.

The [official OpenCode server documentation](https://opencode.ai/v1/docs/server/)
describes programmatic session access, but is explicitly V1 documentation.
It does not prove the desktop 2.2.7 wire format; use the repository's
versioned service evidence for the latter.

Recommended live discrimination, through dev's operator window:

- Record versions and the loaded build of relay, MCP child and sidecar;
  record whether a sidecar exists for the intended role, without exposing
  credentials or full process command lines.
- Compare the adapter's exact session binding with the visible role and
  relay registration/generation; verify a fresh idle state.
- Send a synthetic message from the source role without touching the target.
  Correlate claim, authorization, prompt request, admission and target turn.
  A successful HTTP response alone is insufficient.
- If no sidecar exists, enable the existing documented sidecar in the
  isolated test stand, then repeat. If it exists, classify the first failed
  boundary before proposing a separate bug fix. Verify
  `delivery: "queue", resume: true` rather than assuming stale dist.

## Codex Desktop: a concrete candidate, not a blanket API absence

On this machine, read-only help probes returned
`codex-cli 0.169.0-alpha.11.1` and documented `codex queue` with an exact
thread selector, `--resume`, and optional `--remote`. The help invocations
also warned about sandbox denial for temporary PATH-alias setup; their help
output succeeded. No message was queued and no daemon or chat was started.

The [official command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
describes queueing text to an existing session. With `--resume`, the command
tries to load the session on a local daemon or selected server. A resume
failure can still return success, so exit code zero is not wake-up evidence.
This is the first candidate to test, ahead of inventing a hook-based wake.

The [app-server protocol](https://learn.chatgpt.com/docs/app-server)
also documents `turn/start` for generation and `thread/inject_items`
for history insertion without starting a turn. Protocol availability does
not establish access to the server owning an existing Desktop chat.
Spawning an independent app-server and resuming a rollout is not proof of
delivery into that visible chat.

The [existing Desktop acceptance](../runbooks/2026-11-15-codex-desktop-acceptance.md)
verified per-role MCP inbox access, not autonomous wake. Its verdict remains
valid for the tested topology. Neither a new CLI help probe nor a successful
thread read supersedes that verdict.

Recommended gate: on an isolated operator-bound role, establish the owning
server and exact thread UUID; queue a synthetic inbox reminder while the
target is idle and not manually activated. Observe a new turn in that same
visible thread and correlate it with the relay message read/ack. Repeat busy,
unloaded-thread, restart and wrong-thread cases. Inspect warnings even when
the command exits zero. Do not steer an active turn, spawn a replacement
chat, loosen approvals, or substitute an ambiguous session name.

If the owning Desktop endpoint cannot be reached through the supported
interface, retain inbox-only support and prepare an upstream request for
authenticated, exact-thread wake with admission identifiers, busy queuing
and reconnect semantics. Hooks remain a possible next-interaction fallback,
not an answer to autonomous wake.

## Claude Desktop and generic clients

[Desktop evidence](../runbooks/2026-11-15-claude-desktop-live-dod.md) for
Claude Desktop 5.11492.5.0 records inbox access and SessionStart/Stop hook
execution. It does not establish context injection, UserPromptSubmit
handling on that build, or channel activation.

The [Claude Code hook reference](https://code.claude.com/docs/en/hooks)
documents context output and lifecycle events. That supports a reference
design for an inbox reminder but does not prove Desktop honors the same
output. The proposed hook would return a small, content-free pending-mail
reminder for the bound role, with a bounded read and no automatic ack.
SessionStart and UserPromptSubmit run because a host interaction occurs;
they do not listen for incoming relay messages.

Recommendation: next-interaction injection is the limited improvement to
validate for Desktop Code tab. On an approved stand, send to the idle
target and first observe no autonomous action; then perform a normal
interaction in that target session without manually asking for an inbox
check. Record hook execution, model-visible reminder and subsequent
inbox/ack. If only hook execution is observable, context injection remains
unverified. A hook implementation requires dev approval and a live window.

The generic host category can contain clients with no hooks at all. Do not
provision Claude-specific configuration globally or enable Claude Code
channel flags on Desktop based on CLI documentation.

## Review gates and follow-up documentation

This docs-only stage recommends mechanisms; it does not activate them.
Dev must approve the mechanism and separate implementation scope, then
coordinate the live window. Proposed order: OpenCode runtime diagnosis
(30–45 minutes), Codex exact-thread queue probe (30–45 minutes), Desktop
hook output probe (30–45 minutes). These are planning estimates, not a
promise that a missing host API can be implemented in that time.

For each live row preserve host/build versions, source and target roles,
synthetic message identifiers, timestamps, visible execution evidence,
busy behavior and negative cases. Keep credentials, message bodies,
real session identifiers and raw logs outside Git.

After conformance, update README and client-compatibility with separate
columns for capability, required runtime and observed delivery mode.
OpenCode should distinguish sidecar-enabled delivery from MCP-only inbox.
Codex should remain inbox-only until the queue candidate passes. Claude
Desktop should distinguish next-interaction reminders from autonomous
delivery. Also reconcile the older UNVERIFIED OpenCode paragraph in
client-compatibility with the later version-specific adapter evidence;
do not retrospectively rewrite dated runbooks.
