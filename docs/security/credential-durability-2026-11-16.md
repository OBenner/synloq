# Credential write serialization and durability (#15)

This implementation follow-up addresses L2 and L3 in the historical
[2026-11-12 review](review-2026-11-12.md); that review remains unchanged.

## L2: concurrent credential writers

All `CredentialStore` mutations (`issue`, `ensureCredential`, `rotate`, `revoke`)
acquire `<synloqHome>/credentials/<project-key>.json.lock` using exclusive file
creation before reading the credential store. The lock covers the complete
read/modify/write operation, related token-file write/removal, and audit call.
Concurrent `ensureCredential` calls therefore reuse the first successful issue.
Authentication remains read-only and reads an atomically replaced JSON file.

The lock is cooperative and per project, shared by CLI and relay processes using
this implementation. Older binaries or external editors do not participate. It
is not an authorization boundary or a distributed/network-filesystem lock.

Waiters retry with jitter for up to ten seconds, then fail with `STORAGE_FAILURE`
and the lock path. Permission failures retain the actionable `PERMISSION_DENIED`
diagnostic. A normal completion or exception releases the lock. A process kill
can leave it behind. Age and PID checks never steal a lock: a paused live writer,
PID reuse, and simultaneous reclaimers make that unsafe without fencing.

To recover an orphan, stop **all** credential writers for the project (including
relay, CLI and host channels), inspect the lock's PID/timestamp if available,
remove only that project's `.json.lock`, and restart. Empty lock metadata is also
possible after a crash. Never remove the lock while another writer may be alive.

## L3: flush before publication

`writeTextAtomic` (and thus `writeJsonAtomic`) creates a temporary file with the requested mode,
next to its destination, writes its contents, calls `FileHandle.sync()`,
closes it, and only then renames it over the destination. On POSIX it also syncs
the containing directory after rename. Write, sync, or rename failure before
publication preserves the previous destination and cleans up the temporary file.
A killed process may leave an unreferenced temporary file; it is not read as state.

Windows has no directory-fsync support through this Node API, so rename durability
across power loss is not guaranteed there. Durability also depends on the local
filesystem/hardware honoring flushes; creation of new ancestor directories is not
recursively synced. A POSIX directory-sync error occurs after publication and
cannot promise rollback. Windows can still refuse a rename when an unrelated
process holds an incompatible file handle; the error is reported, not hidden.

This does not turn multiple files into one transaction: a crash between updating
credential hashes and updating a token file can leave a stale/missing token.
Existing doctor/repair procedures apply. Audit append and SQLite transaction
semantics are unchanged. Other JSON stores gain flush-before-rename, but their
read/modify/write operations are not newly serialized by the credential lock.

## Verification

- Independent stores issue concurrently without losing hashes; concurrent ensure
  returns one token with exactly one fresh issue.
- Separate Node processes exercise issue/ensure/rotate/revoke against one project.
- Existing/stale/incomplete locks fail closed; exceptions release ownership.
- Injected partial-write, sync, and rename failures preserve previous valid JSON.
- A real child process killed after file sync and before rename leaves the previous
  state intact. This tests process interruption, not a physical power-loss event.
- Existing credential audit, lifecycle and permission diagnostics remain covered.
