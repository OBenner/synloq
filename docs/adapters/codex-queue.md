# Codex CLI queue nudger

The queue wrapper recognizes only `codex-cli 0.169.0` and
`codex-cli 0.169.0-alpha.11.1`. It checks the configured exact version before each
send and invokes `codex queue --thread <UUID> --message <reminder>` without a shell
or `--resume`. Session names are not targets. The maximum claim is **queue
accepted**: exit 0, a recognized UUID queue ID, and an exact target UUID echo in
`Queued message <queueId> for thread <UUID>.` Unexpected output, a mismatch,
timeout or interrupted process is uncertain; never blindly repeat that operation.
Output is bounded to 8 KiB and runtime to 10 seconds per process. Raw CLI output
is not logged or persisted. This is an undocumented CLI surface, not a stable
Codex API contract; new versions require reviewed fixtures and probe evidence.

Acceptance does not prove persistence independently, delivery, turn start or
completion. A nudge does not guarantee turn start, especially for unloaded chats.
There is no Desktop lifecycle observer, app-server, daemon, database inspection
or resume fallback. Real Synloq inbox/ack and a subsequent RESULT remain the
delivery/read and execution evidence. The CLI-only scope was approved in #83;
the separate Desktop observability gap remains open.

Probe evidence: [#83 CLI-only matrix](https://github.com/OBenner/synloq/issues/83#issuecomment-6917088249).
Loaded-idle and busy behavior was visually confirmed in that window; it is not
observable by this wrapper. The unloaded microprobe returned queue acceptance
without an observed new turn. No probe identifiers or task text belong in config
examples or committed fixtures.
