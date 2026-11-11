# Synloq generic initialization live acceptance — 2026-11-11

## Scope

This record covers generic `synloq init` with arbitrary roles on the installed local Kimi Work host. The isolated stand used the `synloq-acceptance` project, the arbitrary roles `product` and `reviewer`, a separate Synloq home, and generated plugin version `0.1.0+local.20261111-225823`.

The acceptance plugin and its test-only relay port were isolated from the existing CTO/Architect stand. No production plugin source, production relay, credentials, or role configuration was changed. Credentials, local-control tokens, private runtime paths, and full conversation transcripts are intentionally omitted.

This is evidence for one local Kimi Work installation. It is not evidence for Kimi Code CLI, Claude Code, OpenCode, Codex, DeepSeek, Gemini CLI, Cursor, or host-enforced per-chat MCP isolation.

## Initialization and visible conversations — PASS

The real non-interactive CLI created two ordinary visible client conversations:

| Role     | Conversation key                                                    |
| -------- | ------------------------------------------------------------------- |
| product  | `agent:main:main:conversation:26c3925c-85b9-4f93-95b4-718f760efe47` |
| reviewer | `agent:main:main:conversation:48843fca-17e1-4412-b70e-cea703222065` |

Host metadata returned exactly these two conversations in the isolated workspace, both with `origin: "client"` and the configured role instructions. Creation used `activate: false`; the accepting chat remained the controller. No independent host `getActive` probe was performed, so this record does not claim a separately verified active-conversation invariant.

A repeated generic init returned the same exact conversation bindings and created no duplicates. Credential files were compared by SHA-256 before and after reconciliation and were byte-identical. Tokens were not printed or copied into generated plugin source.

## Generated plugin defects fixed during acceptance

Two real installation defects were found and fixed in the generator:

1. Generated role channels were missing from `locales/zh-CN.json → mcpOverrides`. The renderer now emits the same channel metadata there, with regression assertions.
2. The generated MCP command used the current host executable path. Kimi Work discarded those channels. The renderer now emits the portable command `node`, with regression assertions.

The generated isolated plugin source passed `validate_plugin.py` with zero errors and zero warnings after these fixes. After the supported Install/Update action, both generated channels became available:

- `synloq-acceptance:synloq-product`;
- `synloq-acceptance:synloq-reviewer`.

Each visible role successfully called `synloq_list` through its own channel and returned the two configured participants. No standalone `synloq serve` process was started.

## Live question, visible reply, and acknowledgement — PASS

The visible Product conversation used `synloq_send` itself:

- message ID: `43bb393d-035a-4eb1-8d0b-f86ae5122afb`;
- thread ID: `c1bda586-f8e5-4e4a-94f9-a47487056b02`;
- idempotency key: `acceptance-live-question-1`;
- created at: `2026-11-11T19:01:28.994Z`;
- `expectsReply: true`.

Reviewer host history then contained exactly one framed user turn carrying that message ID and registration generation `4`. Reviewer autonomously called its own `synloq_ack` after reading and used `synloq_reply` in the original thread.

The reply was:

- message ID: `4946566a-e74f-4630-96c5-3997782df647`;
- the same thread ID;
- `inReplyTo: 43bb393d-035a-4eb1-8d0b-f86ae5122afb`;
- created at: `2026-11-11T19:02:10.547Z`;
- text prefix `NOTICE`.

Product host history contained that reply as one framed user turn with registration generation `3`. Product read and acknowledged it through its own channel. Independent read-only inbox checks after the turn returned `deliveryState: "acked"` for both the question and reply.

The first response was a `NOTICE`, not a `RESULT`; this is recorded as observed rather than relabelled. A second post-recovery cycle explicitly produced a `RESULT` and is recorded in the relay lifecycle acceptance.

## Limits

- `delivered` means admission of a visible user turn, not model completion, reading, acknowledgement, or task completion. The visible histories and subsequent `acked` states are separate evidence for those steps.
- This run did not repeat idempotent-resend or busy-deferral probes; those remain verified by the earlier CTO/Architect acceptance, not by this generic-role stand.
- Kimi Work exposed several role channels to the controlling chat and did not enforce one-role-only MCP visibility. Roles followed instructions to use their own channels, but that is not host enforcement.
- The test-only relay endpoint was changed to an isolated nonzero loopback port after generation to avoid the existing production stand. This manual test override is not part of the generic user workflow.
- Reconciliation was checked against the same generated project and home. Broad multi-project routing and credential isolation across arbitrary project roots remain unverified.
