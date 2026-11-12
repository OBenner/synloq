# Contributing to Synloq

Thanks for helping build Synloq — a local-first coordination plugin for visible
coding-agent chats. This file is short on purpose; the authoritative rules live in
`docs/protocol/` (message protocol) and `docs/production-plan.md` (release gates).

## Prerequisites

- Node.js 24 or newer
- pnpm 12.18.0

## Verify before you push

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs format check, typecheck, the full test suite, and the build.
A change is not done until it is green.

## Commits

- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- Small, self-contained commits; one logical change per commit.
- Commit messages in English.

## Documentation lands with code

Documentation that describes the changed behavior is updated **in the same commit**.
A PR that changes behavior without updating the affected docs is not merged.
Dated acceptance/review documents are historical records and are never edited
retroactively; new facts go into new documents.

## Protocol changes

Anything touching the message envelope, message types, reason codes, or protocol
constants is a **protocol change**:

1. Propose the change against the spec in `docs/protocol/` first (current accepted
   version: `docs/protocol/v1.md`).
2. Protocol spec changes require double review (spec owners: CTO + Architect roles).
3. Compatibility follows the versioning policy in the spec (minor vs major).

## Evidence hygiene

Never commit tokens, credential files, SQLite databases, message bodies, logs, or
real `conversationKey`/`kernelSessionId` values. Tests and docs use synthetic
identifiers. Evidence documents reference participants by role id and messages by
ID only. The full pre-publication audit rationale is in
`docs/security/audit-2026-11-12-publication.md`.

## Tests

- TDD is the default: failing test first, then the minimal implementation.
- Do not weaken or delete an existing test to make a change pass — if current
  behavior contradicts the spec, open an issue instead.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0 (see LICENSE and NOTICE).
