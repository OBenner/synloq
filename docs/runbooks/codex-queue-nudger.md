# Codex queue nudger acceptance and recovery

Scope: #83, CLI-only enqueue nudger. Automated tests cover the wrapper, durable
ledger, competing owners, restarts, cap, shutdown, pause/quarantine and host
exclusion. The integrated watcher has **not yet been activated on the live stand**.
Earlier [CLI probe evidence](https://github.com/OBenner/synloq/issues/83#issuecomment-6917088249)
does not replace this live window. Use synthetic task markers and IDs only in any
committed evidence. Do not copy credentials, task bodies or local absolute paths.

## Prepare an operator window

1. Agree the owning relay restart/build window and exact test role's Desktop chat
   UUID with the operator. Confirm the chat is the intended role with its own MCP
   channel. Do not substitute a Synloq thread ID or a session name. Record the
   tested CLI version. No new daemon, app-server, RPC, resume or production DB
   manipulation is part of this test.
2. Confirm existing Codex placement in team state and that the role has no push
   conversation or active-delivery registration. Disable manual sender-side
   `codex queue` reminders for this test role/window: external/manual senders do
   not participate in the nudger ledger and cannot be deduplicated by it. Keep
   manual reminders for other roles whose nudger is not enabled.
3. Use the [local opt-in configuration](../adapters/codex-queue.md). Keep the
   existing project/home and the persistent nudge journal. Restart only the
   agreed relay. Invalid config must log `NUDGER_DISABLED` and leave inbox access
   available. A missing opt-in file must not create a journal or invoke Codex.

## Evidence matrix

| Control                | Evidence to capture                                                                                                       | Claim allowed                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Loaded idle            | One pending Synloq message, one `queue accepted` diagnostic with queue ID and message ID; actual role inbox/ack and reply | Accepted; read/executed only with real ack/RESULT                                |
| Busy chat              | Queue acceptance while the role is busy; operator observes queued chip and a later turn                                   | CLI acceptance only; visual observation is separately attributed                 |
| Unloaded chat          | Queue acceptance and whether a new turn is observed in the bounded window                                                 | **Nudge does not guarantee turn start**; no wake claim from exit 0               |
| Delivery state         | Message remains stored/delivered until its real recipient acknowledges it                                                 | The watcher did not manufacture a receipt                                        |
| Restart/cooldown       | Restart the owner after an accepted enqueue, before 30 minutes; no second queue invocation                                | Durable dedup; wait at least 30 minutes before a later eligible iteration        |
| Budget                 | On an isolated fixture, five unacknowledged iterations spaced by 30 minutes, then the terminal log and no sixth enqueue   | `undelivered after 5 nudges`; ack absent, no inferred Desktop lifecycle          |
| Wrong UUID             | Only an operator-approved nonexistent UUID in an isolated fixture; CLI rejection, no automatic repeat                     | Rejected; do not send negative probes into unrelated chats                       |
| Parser/version/timeout | Automated fixture suite (do not deliberately break a production executable)                                               | Fail-closed, no blind retry                                                      |
| Stop                   | Stop the owning relay during a controlled fake CLI operation                                                              | Owned process reaped before ledger closes; interrupted enqueue remains uncertain |

Do not compress the production cooldown or manually change the journal counter
to accelerate the cap test. Automated clock fixtures already cover it. Live
evidence must distinguish CLI acceptance, operator visual observation and actual
relay ack/RESULT; there is no turn ID or lifecycle observation in this service.

## Recovery

- `accepted`: wait for the real recipient read/ack. Further nudges are permitted
  only by the cooldown and remaining budget. Open/activate the intended chat
  manually if the operator decides that is appropriate; do not relabel that as
  autonomous wake-up.
- `disabled`, `rejected`, `uncertain`: inspect the fixed diagnostic code and the
  operator-selected executable/version/UUID. No blind retry. A real ack permits
  the next message after the role cooldown; it does not cause the same message
  to be nudged again.
- `reserved` after a crash: the queue may already contain the reminder. Stop all
  relay owners for this project and retain the journal as evidence. An operator
  must reconcile the intended chat/actual read and confirm no owned queue process
  remains before any targeted journal repair. Preserve counts and timestamps;
  never delete the journal, decrement counts or reset an exhausted budget. There
  is deliberately no automatic reservation stealing or retry command.
- Exhausted head: log `undelivered after 5 nudges`, stop all further nudges for
  that head, and handle the unread backlog through the actual role channel. A
  new binding or relay restart does not grant another five attempts.

Roll back by removing the local opt-in config and restarting the owning relay.
Keep the journal. This changes only notifications; messages, claims, session
generations, capabilities and task results are unaffected. Config changes are
startup-only. Metadata retention in the separate local journal is intentionally
indefinite so message retention cannot silently grant a fresh retry budget.
