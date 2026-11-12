# Research: long-term memory for role chats

- Date: 2026-11-12
- Author: Architect
- Issue: [#20](https://github.com/OBenner/synloq/issues/20)
- Status: proposal, awaiting CTO review

## Problem

A role's working context lives only in its chat's context window plus ad-hoc
handoff artifacts (compaction summaries, on-disk plans under `docs/superpowers/`).
After compaction or a chat reset, decisions, incident details, and open loops
must be reconstructed from Synloq threads and committed docs — lossy and slow.
Both already happened in practice: the 2026-11-12 session needed a manual
handoff summary to resume after compaction.

## Requirements

- **R1 Per-role scoping.** Role X's memory must not be writable by role Y
  without going through a Synloq message. Read access may be broader
  (shared project docs already are).
- **R2 Survives compaction, chat restart, relay restart.**
- **R3 Stable identity.** Memory is keyed by (project, role); the project key
  is `sha256(realpath(projectRoot))[0:16]` (`src/config/paths.ts`) — stable
  while the repo path is stable, changed by relocation (same caveat as
  issue #7, absolute paths in generated configs).
- **R4 Hygiene.** Memory must never carry tokens, credential material, or full
  message bodies (same rule as bug_report.md evidence hygiene).
- **R5 Zero protocol impact.** No change to the protocol v1 envelope, message
  types, reason codes, or constants.

## Options

### A. Repo-file memory per role (Synloq-native, file-based)

Each role keeps an append-oriented markdown file, e.g.
`.synloq/memory/<role>.md` (or `docs/memory/<role>.md`), with dated entries:
decisions, open loops, incident refs, pointers to threads/issues. Role
instructions (plugin-renderer) gain a standing rule: read your memory file at
session start, append at session end and after any decision/incident.

- Effort: ~0.5 day (template + instruction hook + TEAM.md hygiene section).
- Protocol v1 impact: **none** (no wire change).
- Role-model fit: good; all hosts can read/write repo files.
- Isolation: instruction-only — every role shares the repo checkout, so
  write-isolation relies on discipline, exactly like today's channel isolation
  (pre-P1.1 threat model). Acceptable now; enforced scoping would need #8-era
  controls or host support.
- projectKey stability: not key-dependent at all — the file travels with the
  repo, survives relay loss, is git-versioned and reviewable. Relocation-safe
  by construction.
- Risks: agent discipline (mitigated by instruction hook + pin test);
  repo pollution if memory is verbose (mitigated by entry format + periodic
  compression into docs/ADRs).

### B. Relay-side memory notes (Synloq-native, service-based)

New MCP tools on the role channel, e.g. `synloq_note_write` /
`synloq_note_read`, backed by a relay SQLite table keyed by
(project, role, key). The relay enforces per-role access via the role token.

- Effort: ~1.5–2 days (tools, storage, retention, tests, doctor surface).
- Protocol v1 impact: **none on the envelope** — notes are tooling surface,
  not inter-participant messages; the relay gains a storage table, which is
  implementation, not protocol. (Confirmed against spec v1 §1–§2: the spec
  governs message exchange between participants, not local tooling.)
- Role-model fit: excellent — token-enforced per-role scoping, aligns with
  the P1.1 enforcement direction (#8).
- projectKey stability: keyed rows survive relay restart (SQLite persists);
  rekeying needed only on repo relocation (same caveat as #7).
- Risks: one more store to back up/migrate; retention policy needed (align
  with #4 GC); temptation to turn notes into a shadow channel — must stay
  local-only, never routed.

### C. External MCP memory server per role

Run a reference memory MCP server (e.g. the `@modelcontextprotocol/server-memory`
knowledge graph) as an additional per-role server with its own data file.

- Effort: ~1 day per host where per-role MCP configs exist; blocked on Kimi
  Work by the per-conversation scoping gap (#9) — without it, all role chats
  in a project would share one server instance and one memory graph,
  violating R1.
- Protocol v1 impact: none.
- Risks: operational complexity (N extra processes), no isolation on Kimi
  Work today, third-party dependency for a core workflow.

### D. Deliberate docs memory (already live)

GitHub Issues (#1–#20), `docs/protocol/`, `docs/security/`, ADRs and the
backlog already function as long-term memory for *decisions*. What they do
not cover is *working context* (open loops, incident detail, "where was I").

- Effort: zero incremental; formalize the ADR habit (~0.5 day of docs).
- This option complements rather than replaces A/B.

### Marketplace scan (2026-11-12)

No dedicated long-term-memory plugin currently exists in the Kimi plugin
marketplace (searched: memory, long-term memory, knowledge base, RAG — no
relevant hits). Re-check before choosing C.

## Comparison

| Option | Effort | Enforced isolation | Survives relocation | Protocol impact | Blocked by |
|---|---|---|---|---|---|
| A repo-file | 0.5 d | no (instruction) | yes | none | — |
| B relay notes | 1.5–2 d | yes (role token) | needs rekey on move | none | — |
| C MCP server | ~1 d/host | host-dependent | host-dependent | none | #9 (Kimi Work) |
| D docs/ADR | ~0.5 d | n/a (shared) | yes | none | — |

## Recommendation

**Phase 1 (now): A + formalized D.** Repo-file per-role memory with a
standing instruction hook and a TEAM.md hygiene section; decisions continue
into Issues/ADRs. Cheap, host-agnostic, relocation-safe, zero protocol risk.

**Phase 2 (after #8 lands): B** as the enforced-isolation upgrade — the same
role-instruction contract, backed by token-scoped relay storage instead of
shared files. Design B so its read/write contract mirrors A's file layout
(key = heading), making migration mechanical.

**Defer C** until #9 resolves per-conversation scoping on Kimi Work.

## Decomposition for the backlog

- **M1 (P2, arch, ~0.5 d):** memory convention doc + memory file template +
  role-instruction hook (read at start, append at end/decision) + TEAM.md
  hygiene rules (no tokens, no message bodies, reference by IDs).
- **M2 (P2, dev, ~1.5–2 d, after #8):** relay-side note tools with
  token-enforced per-role scoping, retention aligned with #4, doctor surface;
  migration path from M1 files.
- **M3 (P3, arch):** re-evaluate option C and marketplace memory plugins once
  #9 (per-conversation scoping) is answered.

## Open questions

- Memory file location: `.synloq/memory/` (private, gitignored) vs
  `docs/memory/` (versioned, reviewable). Recommendation: versioned, with the
  hygiene rules making review meaningful — but decide at M1.
- Compression cadence: who folds raw memory entries into ADRs/docs, and when
  (proposal: role does it when a loop closes; CTO spot-checks in reviews).
