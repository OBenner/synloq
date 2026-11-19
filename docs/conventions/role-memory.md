# Role memory convention

- Status: Accepted (M1 of [#20](https://github.com/OBenner/synloq/issues/20))
- Date: 2026-11-14
- Owner: Architect (convention); each role owns its files
- Source: `docs/research/2026-11-12-role-chat-long-term-memory.md`, option A + D;
  location question resolved by live practice (CEO decisions log, 2026-11-14)

## Why

A role's working context lives in its chat's context window. Compaction and
chat restarts lose decisions, open loops, and incident detail; reconstructing
them from relay threads is lossy and slow. This convention is the cheap,
host-agnostic, zero-protocol-impact layer of long-term memory. Relay-side
token-scoped notes (research option B, M2) remain the enforced-isolation
upgrade after #8.

## Location (decided)

Each role keeps its memory under `docs/local/<role>/`:

- `docs/local/` is **gitignored** — memory never enters the repository. The
  research's open question (`.synloq/memory/` vs versioned `docs/memory/`) is
  resolved for the public-repo era: working memory is operational data, not
  project documentation, and must not leak into the public history. Locality
  also keeps the convention relocation-safe per machine.
- Survives compaction, chat restarts, and relay restarts (plain files on
  disk). Does not survive machine loss — accepted; durable decisions are
  promoted to ADRs/issues (see Promotion below).

## Files

Copy the [versioned template](../memory/role-template.md) into the role's local
directory. Verify the destination is ignored by Git before writing entries.
Each role maintains two files:

1. `decisions-log.md` — **append-only**. Use `D-<YYYY-MM-DD>-<NN>` for a
   decision, `I-<YYYY-MM-DD>-<NN>` for an incident, and
   `S-<YYYY-MM-DD>-<NN>` for a session handoff that adds useful context. Assign
   the next sequence number for that date and entry type. Record the outcome,
   next action or owner where applicable, and a source reference. Correct an
   entry by adding a new one that references its ID.
2. `open-loops.md` — **mutable snapshot**. Current tasks, pending threads
   waiting on others, and blockers. Date each item and include the next action,
   owner or dependency, and a source reference. Keep it short enough to read
   in one screen.

## Discipline

- **Read** `open-loops.md` (and skim `decisions-log.md`) at session start and
  after any compaction. If the files are absent, start with the template when
  there is something to record.
- **Write** after a decision or incident and at session end. Append the dated
  entry and update open loops. At session end, append a handoff when the next
  session needs context beyond what is already recorded.
- Write only your own role's directory. Send a Synloq message to the owner
  when another role's file needs an update. This is a team convention on a
  shared filesystem.

## Hygiene (hard rules)

- No tokens, credentials, or secrets — ever.
- Keep message bodies out. Reference by message ID, thread ID, commit hash, or
  issue number.
- No personal data about the operator beyond what tasks require.
- For incident checks and tests, use synthetic fixtures and injected paths.
  Keep actual credentials and user state out of fixtures, logs, and test
  output. See [#35](https://github.com/OBenner/synloq/issues/35).

## Promotion

- A decision with cross-role, protocol, or public-surface impact does not stay
  in the log: promote it to `docs/adr/` (architecture) or the protocol spec /
  TEAM.md (process) through the normal review flow. The log entry then links
  to the promoted artifact.
- When a loop closes, the owning role folds the durable outcome into the
  closing ADR or issue and trims `open-loops.md`. CTO spot-checks promotions
  during review.

## Role-instruction hook (for renderers)

Generated Kimi Work instructions and OpenCode prompts include the memory rule
for the named role in the project's language. The rule tells the role when to
read and update its files. It requires no relay or protocol changes.
