# Relay-side memory notes (#22)

Per-role memory notes: `synloq_note_write` / `synloq_note_read` MCP tools on the
role channel, backed by a `notes` table in the relay SQLite database. This is
memory option B from
[the memory research](../research/2026-11-12-role-chat-long-term-memory.md).

## Scoping and isolation

Notes are keyed by `(project, role, key)`. The role is taken from the
authenticated identity — never from the request — so one role's namespace is
invisible to every other role by construction; the conformance suite
(`test/relay/notes-conformance.test.ts`) pins this, including the operator's
separate namespace. Notes are **local tooling**: they are never routed between
participants and are not part of protocol v1 (no envelope change).

## Bounds

- Key: 1–128 characters. Body: at most 65 536 characters.
- At most 256 keys per role; exceeding the cap fails with `STORAGE_FAILURE`
  and does not affect other roles.
- Oversized or malformed requests fail closed with `INVALID_INPUT` before any
  write (zod schemas at the HTTP boundary and in the store).

## Retention

The message retention sweep (#4) does **not** touch notes: memory is meant to
outlive individual messages, and unbounded growth is already prevented by the
per-role key cap. `doctor` reports aggregate note statistics (role count, note
count, oldest/newest timestamps) without exposing bodies.

## Schema migration

The notes table arrives with schema version 6. Migration is forward-only and
additive: v5 databases gain the table in a dedicated transaction (the 0→5
rebuild is untouched), racing migrators wait on the write lock and see 6. An
older binary refuses a v6 database with the usual fail-loud
`unsupported SQLite user_version` error — the accepted rolling-upgrade
friction.

## Migration from M1 memory files

The M1 file convention (#21, arch) keys memory by markdown heading. The
mechanical mapping lives in `src/storage/notes-migration.ts`:
`notesFromMemoryFile(markdown)` turns each `## <heading>` into one note
(heading text = key, section = body), dropping the H1 title, front matter and
empty sections. Keys longer than 128 characters are truncated. The function is
offline and pure — the operator supplies the file; nothing is read from real
user state implicitly.
