# Storage delivery and quarantine boundaries

## Consumed acceptance quarantine (#90)

A controlled one-message acceptance claim sets
`acceptance_consumed_generation`. Its allowance must not be restored by a relay
restart, lease reaping or a fresh registration. If that submitted message has
been quarantined, it stays **submitted and quarantined** until actual delivery
evidence or a recipient read acknowledgement resolves it. No delivery or ack is
fabricated, and no automatic retry is granted.

`releaseQuarantinedDeliveries(project, recipient)` returns ordinary quarantined
submissions to `stored`, clearing their claims, and returns the number reset.
It retains the quarantine marker of a still-submitted consumed acceptance
message. `SessionStore.register` applies the same cleanup rule within its existing
registration transaction. Both paths can remove quarantine for messages that
have already progressed to delivered/acked, including consumed ones. Cleanup is
scoped to the requested project and recipient.

Why the marker matters: `nextPending` and `claimNextDelivery` skip quarantined
submitted blockers. Removing the marker while leaving the consumed message
submitted blocks all later FIFO mail, and lease reaping cannot release that
consumed claim. The shared cleanup preserves this invariant without changing the
state machine, session/wire contracts, v1 envelope or schema.

Tests in `test/storage/quarantine-release.test.ts` reproduce the original failure
in both the explicit helper and production re-registration path. They check FIFO
selection and actual subsequent claims, repeated releases, lease reaping,
reopening the database, non-reuse of the acceptance allowance, ordinary retries,
acked cleanup and isolation between projects/recipients.

This fix prevents removal of an existing protective marker. It does not guess
which already-unquarantined submitted rows on a live stand came from the old bug;
such rows require explicit reconciliation using real delivery/read evidence.

## Read acknowledgement is not a delivery claim

`acknowledge(id, project, recipient)` intentionally accepts an inbox read without
an active delivery claim. Protocol [v1 section 3](protocol/v1.md#3-ack-semantics)
defines ack as read/taken into processing and permits fast-forwarding the stored,
submitted and delivered states. Inbox-only hosts depend on that behavior.
Storage verifies the project and recipient; `RelayService.acknowledge` also checks
writer-session proof when a writer is registered, per v1 section 2.4. Adapter
transport receipts use the separate generation-bound completion methods. None of
these boundaries is weakened or redefined by #90.

Existing coverage includes `test/mcp/tools.test.ts` (inbox read/ack without an
adapter), `test/relay/single-writer.test.ts` (writer proof and wrong-chat denial),
and `test/storage/message-store.test.ts` (project/recipient isolation and
idempotent ack).

## Internal test setup mutators

The secondary call-site audit for #90 found no production callers of
`setDeliveryState` or `resetSubmittedForRetry`: references outside their
definitions are test fixtures. Contrary to the initial observation, both already
require `project` and look up the row by `(id, project)` before writing; they do
not require recipient/session proof and are not transport entry points. They
remain internal setup helpers rather than being used as production retry paths.
Production delivery uses `claimNextDelivery`, `authorizeDelivery`,
`completeDeliveryReceipt` and `reportDeliveryFailure`, which validate recipient
and binding. The explicit `releaseQuarantinedDeliveries` helper also currently
has no production call site; registration contains the production reconcile
path, so both were fixed.

Reproduce the audit with:

```sh
rg -n 'setDeliveryState|resetSubmittedForRetry|releaseQuarantinedDeliveries' src test scripts
```
