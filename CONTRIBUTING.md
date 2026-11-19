# Contributing to Synloq

Thanks for helping build Synloq — a local-first coordination plugin for visible
coding-agent chats. This file is short on purpose; the authoritative rules live in
`docs/protocol/` (message protocol) and `docs/production-plan.md` (release gates).

## Prerequisites

- Node.js 24 or newer
- pnpm 12.18.0

## Branches, worktrees, and pull requests

`main` is protected: the `Format, typecheck, test, build` CI job must pass, and
force-push/deletion are disabled. Direct pushes to `main` are over — all code
changes land via pull requests.

- **Branch per task**: `feat/<issue>-<slug>` or `fix/<issue>-<slug>`, branched
  from fresh `main`. One issue = one branch = one PR.
- **Worktree per active task** (several agent roles share this machine — a
  shared checkout guarantees WIP collisions): `git worktree add
../synloq-wt/<role>-<issue> -b feat/<issue>-<slug>`. Work only inside your
  worktree; never commit into someone else's.
- **Review chain**: dev2 → dev reviews; dev → CTO reviews; architecture,
  protocol, and process changes also get Architect review. The reviewer merges
  after CI is green.
- **Keep branches short-lived**: rebase on `main` before opening the PR; delete
  the branch and worktree after merge.
- Docs-only commits (backlog, research notes, ADRs in `proposed`) may still go
  straight to `main` by the CTO to keep coordination latency low; everything
  else goes through a PR.

## Verify before you push

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs format check, typecheck, the full test suite, and the build.
A change is not done until it is green.

**Coordinated build window.** `pnpm build` overwrites `dist/`, which kills live
host-spawned MCP channel processes (they run from `dist/`). On a machine with a
live stand (relay + role channels up), agree a window with the operator before
building, and expect channels to need a restart afterwards. Test/verification
executors on live stands skip `pnpm build` deliberately (see the live runbooks).

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
ID only. Committed docs, runbooks, and scripts must not contain absolute local
paths, machine names, or OS user names — use repo-relative paths, home-relative
paths (`~/.synloq`), or documented variables/placeholders (`$Stand`,
`<projectKey>`). The full pre-publication audit rationale is in
`docs/security/audit-2026-11-12-publication.md`.

**Tests must be hermetic.** A test must never read real user configs,
credentials, or state: no `os.homedir()`, no tilde home paths
(`~/.synloq`, `~/.config`, …), no Windows account variables (`%USERPROFILE%`,
…), and no direct reads of home-related environment variables. Inject paths via
fixtures, `vi.stubEnv`, or `mkdtemp` instead. This is secret hygiene, not just
determinism: a failing test prints its values into logs, and logs travel —
issues, support bundles, backups. The 2026-11-13 incident (a real service
password in failing-test output) is the reference case. `pnpm verify` enforces
the high-signal patterns via `scripts/check-test-hermeticity.mjs`.

## Tests

- TDD is the default: failing test first, then the minimal implementation.
- Do not weaken or delete an existing test to make a change pass — if current
  behavior contradicts the spec, open an issue instead.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0 (see LICENSE and NOTICE).
