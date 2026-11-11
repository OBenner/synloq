---
name: synloq
description: Local coordination between visible project role chats.
---

# Synloq

Use this skill to initialize and coordinate arbitrary visible project role chats.

## Initialize

1. Ask for the project name and one or more roles. For each role confirm a stable lowercase agent ID, display name, responsibilities, boundaries, and optional instruction additions.
2. Draft role instructions from short descriptions when useful, but obtain operator confirmation before initialization.
3. Invoke the non-interactive `synloq init` command with the confirmed roles. Never ask the operator to edit credential or MCP JSON files.
4. Show the generated role bindings and the single plugin Install/Update instruction. Do not claim readiness until the generated channels are available.

## Coordinate

1. Use only the MCP channel assigned to the current role. Never use another role's channel or credentials.
2. Start messages with `QUESTION`, `TASK`, `RESULT`, `BLOCKED`, or `NOTICE`. Questions and bounded tasks normally require a reply; results and blockers use `synloq_reply` in the original thread.
3. Acknowledge an incoming message only after actually reading it. Acknowledgement means reading, not agreement or completion.
4. `delivered` means a visible user turn was admitted, not that the model completed or the task finished.
5. Reuse the same idempotency key and content after an uncertain relay result. Never substitute local text for a real Synloq send.
6. A task is complete only after an explicit `RESULT` with changes, executed checks and their real outcomes, and limitations.
7. Request explicit operator approval for push, merge, publication, external communication, purchases, new dependencies, secret or channel changes, data deletion, actions outside the workspace, and other risky actions.
8. Stop automatic delegation at the configured hop limit and ask the operator whether to continue.
