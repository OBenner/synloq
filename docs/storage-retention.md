# Message retention

Storage schema 5 separates message bodies from a seven-day idempotency ledger.
The ledger keeps a SHA-256 hash of `(to, text, expectsReply, inReplyTo)`, original
message metadata and first acceptance time, never the body. Matching retries use
the supplied identical body to reconstruct the original result after a purge;
changed content fails with `IDEMPOTENCY_CONFLICT`. Retrying does not extend the
window. After seven complete days a reused key may create a new message even if
the original body remains stored. Sender and project scopes remain independent.

Only `acked` messages older than the configured retention are eligible for GC.
Age is measured from message creation. Stored, submitted, delivered without ack,
and quarantined messages remain intact. Sweep transactions are bounded and scoped
to one project. Body and ledger expiry are independent, so retention below seven
days never shortens the dedup window.

`inReplyTo` is a historical ID, not a foreign key. New replies require a currently
stored parent at acceptance. After its deletion a new reply, get or ack fails with
`NOT_FOUND`; a previously accepted retry still resolves through its own ledger.
Existing retained replies preserve the original parent ID and thread ID.

The forward-only migration from schemas 0–4 preserves messages, session state and
quarantine, removes permanent key uniqueness and the parent FK, backfills ledger
hashes with creation time as first acceptance, and checks remaining foreign keys
before commit. Unsupported schema versions fail loudly, including on diagnostic
read-only opens. Older writers must be stopped before installing schema 5; they
cannot write this database. Take the normal storage backup before upgrading.

This is logical retention, not secure erasure or archival: SQLite reuses freed
pages, and backups/WAL files may retain prior bytes. GC does not promise to shrink
the database file immediately, and unread queues can still grow. No message body
or hash is logged by the sweeper.
