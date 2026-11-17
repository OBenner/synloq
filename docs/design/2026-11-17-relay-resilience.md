# Relay crash recovery (#141)

The serve lock remains an advisory guard against accidentally starting two
relays for one database, not a security boundary against a local adversary.
Recovery applies only to the relay's `.serve.lock`, not credential or nudger locks.

## Ownership and recovery

Fresh acquisition uses exclusive file creation (`wx`) before opening the main
database. The record contains PID, start time, and a random ownership nonce.
An existing file triggers recovery under a separate SQLite sidecar transaction:
`<database>.serve.lock.mutex.sqlite`, `BEGIN IMMEDIATE`, busy timeout 5 seconds.
The short transaction performs synchronous operations only. It never opens or
migrates the application database, and uses Node's existing SQLite runtime.

Inside the mutex, acquisition retries `wx` in case the owner already released.
Otherwise it freshly reads the record, probes the PID with `process.kill(pid, 0)`,
and removes the lock **only if the probe returns ESRCH**. Successful probes mean
alive; EPERM and every other error mean unknown. Invalid, unreadable, or oversized
records fail closed. Neither file age nor timestamp comparisons authorize recovery.
PID reuse may produce a false refusal because an unrelated process is alive with
that PID. This conservative refusal is intentional.

After removal, acquisition still uses `wx`: a fresh starter can win the gap.
The recovery loser reports ALREADY_RUNNING and never removes the winner's file.
Release compares the complete owner record under the same mutex before unlinking.
SQLite releases its OS mutex if a recovering process crashes; no second stale
PID-lock needs recovery. The persistent mutex file must not be deleted or replaced
while clients can acquire/release ownership. External cleanup helpers must not
unlink serve locks concurrently with this protocol; retire the temporary manual
stale-lock workaround when rolling out this implementation.

A crash during writing the ownership record may leave a malformed file. This is
an explicit fail-closed case requiring operator inspection, not age-based recovery.
An alive but unresponsive owner is never stolen: the existing bounded five-second
re-probe remains, then reports the owner/lock diagnostic.

## Diagnostics

Recovery emits `recovered stale serve lock (pid N)` through the supervisor's
diagnostic sink (MCP stderr) or timestamped CLI stderr. A broken diagnostic sink
cannot strand acquired ownership. HTTP connection failures become structured
STORAGE_FAILURE tool results with a fixed reason (for example ECONNREFUSED) and
guidance to inspect startup diagnostics and run `synloq doctor`. Raw exception
text, request bodies, and credentials are never included in that message.
The internal cause remains available to supervisor election. Authentication and
protocol errors keep their existing types; caller cancellation is preserved.
Exhausted supervisor recovery reports the error category instead of an opaque
unavailable message. No retry policy, credential, or protocol changes are added.

## Verification

- Injected liveness: dead/live/unknown, EPERM, malformed owner, ownership-safe
  release, and a failing diagnostic sink.
- Real independent Node processes: killed owner, three concurrent recoverers
  electing exactly one winner, killed winner recovered again, and a process killed
  while holding the SQLite mutex. These tests use the actual production modules.
- Real auth-v2 HTTP relay after stale-lock recovery, bounded live-owner refusal,
  typed startup failure, MCP structured error, and supervisor exhaustion diagnostics.
- Windows Node 24.13.0 local observation: a terminated test child is recovered via
  ESRCH; signal 0 against protected system PID 4 returns EPERM. The latter is an
  environment observation; portable CI uses an injected EPERM rather than assuming
  a universal protected PID.

No production relay, scheduled keepalive task, or saved Claude stand is changed.
