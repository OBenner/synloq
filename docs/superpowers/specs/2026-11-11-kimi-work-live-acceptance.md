# Kimi Work live acceptance — 2026-11-11

## Scope

This record covers the installed local Kimi Work host and the two existing visible client conversations bound to the Synloq `cto` and `arch` roles. It does not cover Kimi Code CLI, generic chat creation, other hosts, or host-enforced per-chat MCP isolation.

The stand used Synloq plugin version `0.1.0+local.20261111-visible1`, relay `http://127.0.0.1:4100`, and project workspace `I:\git\Synloq`. Credentials and local-control tokens are intentionally omitted.

| Role      | Conversation key                                                    | Kernel session                  |
| --------- | ------------------------------------------------------------------- | ------------------------------- |
| CTO       | `agent:main:main:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb` | `conv-94589cc56c91c4be0e824f15` |
| Architect | `agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138` | `conv-587ed547d4b9851e059afe14` |

## Fixed defect and regression evidence

The MCP child process received the correct role credential, and the relay accepted it. However, `defaultKimiWorkFactory` repeated authentication against a local `CredentialStore`. The child did not inherit `SYNLOQ_HOME`, so this second lookup used an empty store and visible-delivery startup stopped silently while the six inbox tools remained available.

The binding now declares the Synloq `agentId` explicitly. The relay remains the authentication and authorization boundary: adapter registration validates the token's project, role, and session binding. `workAgentId` remains a separate Kimi Work host identifier.

TDD evidence:

1. `test/mcp/stdio-default-kimi-work.test.ts` initially failed for the intended reason: `runKimiWorkAdapter` was called 0 times instead of 1.
2. After the minimal production fix, the focused run passed: 3 test files, 15 tests.
3. `pnpm verify` passed: formatting, typechecking, 43 test files / 415 tests, and production build.

Both role servers were then reconnected through supported `mcp.runtime.reconnect` calls. Each returned `reconnected: true`; subsequent runtime lists showed `plugin-synloq:synloq-cto` and `plugin-synloq:synloq-arch` connected with six tools each. No host or MCP process was killed manually.

## Acceptance observations

### 1. Visible CTO → Architect question and autonomous reply — PASS

The question was sent once before the fix and remained durable in the relay:

- message ID: `92f630aa-12c5-4392-a078-2eca6b7f6c9b`;
- thread ID: `9b83989c-a196-4f4c-ad3c-72f3f9e1348f`;
- idempotency key: `kimi-work-visible-adapter-1`;
- created at: `2026-11-11T16:49:26.765Z`;
- initial delivery state: `stored`.

After MCP reconnection, the existing message appeared in Architect history as exactly one framed user turn, host turn `3`, without another send. Architect autonomously used its own channel to acknowledge the question and reply. No Architect MCP call was made by the accepting agent.

Architect's reply:

- message ID: `dcca7e5b-c25d-4181-8dce-5381e4ca1179`;
- thread ID: `9b83989c-a196-4f4c-ad3c-72f3f9e1348f`;
- `inReplyTo`: `92f630aa-12c5-4392-a078-2eca6b7f6c9b`;
- idempotency key: `kimi-work-visible-reply-92f630aa-1`;
- created at: `2026-11-11T17:14:37.893Z`;
- text begins with `RESULT` and contains the original message ID.

The reply appeared as one framed user turn in the visible CTO conversation, host turn `4`. The CTO inbox returned the same ID, thread, and `inReplyTo`; an explicit CTO `synloq_ack` returned `deliveryState: acked`.

### 2. Idempotent resend — PASS

CTO repeated `synloq_send` with the original text and idempotency key `kimi-work-visible-adapter-1`.

The relay returned the original message ID, thread ID, and `createdAt`. Architect history still contained exactly one user turn carrying the original message ID. The other history match was Architect's assistant response referring to that ID; it was not a second delivery.

### 3. Busy deferral and post-idle delivery — PASS

A controlled host turn made Architect busy for 12 seconds:

- host turn ID: `82acc997-29ed-4cd6-b80d-fc87a8eb67fe`;
- observed host state before the Synloq send: `busy: true`.

While that turn was active, CTO sent a separate message:

- message ID: `38278f98-b7b5-472e-a84c-b6f728d3a0a5`;
- thread ID: `0d7a932d-fdfc-4c0b-a896-9352f72e6e29`;
- idempotency key: `kimi-work-visible-busy-1`;
- created at: `2026-11-11T17:19:16.826Z`;
- `expectsReply: false`;
- initial delivery state: `stored`.

An immediate history read still reported `busy: true` and zero matches for this message ID. After the busy turn completed, the message appeared once as host user turn `5`; Architect acknowledged it and did not reply, as requested. Final host state was `busy: false`.

## Limits

- `delivered` means visible user-turn admission, not task completion or semantic agreement.
- The uncertain-send reconciliation path remains controlled-test evidence; it was not forced against the live host in this run.
- Generic role initialization, automatic relay lifecycle, command routing with hop limits, and durable per-chat MCP isolation remain separate work.
- These observations verify this local Kimi Work stand only. They do not upgrade the support status of Claude Code, OpenCode, Codex, DeepSeek, Gemini CLI, Cursor, or Kimi Code CLI.
