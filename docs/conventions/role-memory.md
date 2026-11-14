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

Two files per role, distinct write disciplines:

1. `decisions-log.md` — **append-only**. One entry per decision:
   `D-<date>-<NN>`, context with links (thread IDs, commits, issues), the
   decision, constraints, executor. Never rewrite history; correct by a new
   entry.
2. `open-loops.md` — **mutable snapshot**. Current tasks, pending threads
   waiting on others, blockers, "where was I". Rewrite freely; keep it short
   enough to read in one screen. This is the first file to read after a
   compaction or restart.

## Discipline

- **Read** `open-loops.md` (and skim `decisions-log.md`) at session start and
  after any compaction.
- **Write** after any decision, incident, or completed task, and before
  expected idle periods.
- Memory is per-role: write only your own directory. Read access to other
  roles' files is allowed but their content is their perspective, not fact.

## Hygiene (hard rules)

- No tokens, credentials, or secrets — ever.
- No full message bodies; reference by message ID, thread ID, commit hash, or
  issue number.
- No personal data about the operator beyond what tasks require.

## Promotion

- A decision with cross-role, protocol, or public-surface impact does not stay
  in the log: promote it to `docs/adr/` (architecture) or the protocol spec /
  TEAM.md (process) through the normal review flow. The log entry then links
  to the promoted artifact.
- Periodic compression: when a loop closes, fold its scratch entries into the
  closing ADR/issue comment and trim `open-loops.md`.

## Role-instruction hook (for renderers)

Renderers (`plugin-renderer.ts` for Kimi Work, the OpenCode role-prompt
template from #32 W4) append this block to every role's instructions, in the
project `language`:

> You have a local memory directory `docs/local/<your-role>/` (gitignored).
> At session start and after any context loss, read `open-loops.md` and skim
> `decisions-log.md`. Append decisions as `D-<date>-<NN>` entries and keep
> `open-loops.md` current. Never store tokens or message bodies; reference by
> IDs.

## Templates

`decisions-log.md`:

```markdown
# <Role> — decisions log

## D-<YYYY-MM-DD>-01 — <title>

- **Context:** <links: threads/commits/issues>
- **Decision:** <what was decided>
- **Constraints:** <limits, non-goals>
- **Executor:** <who implements>
```

`open-loops.md`:

```markdown
# <Role> — open loops (updated <YYYY-MM-DD>)

## Now

- <current task, thread/issue link, state>

## Waiting on

- <what, from whom, since when>

## Blocked

- <what, by what, what unblocks>
```
