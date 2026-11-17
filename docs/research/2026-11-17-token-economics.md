# Token economics of a Synloq role team (honest cost model)

Date: 2026-11-17. Status: research recommendation for FAQ/README wording and a
possible future measurement feature. No code changes. Source: operator question
via CTO ("how much does it cost to keep 5 roles running per day"), matching a
gap flagged in the CEO prospectivity study.

## The honest headline

**Synloq can answer "how much coordination traffic does my team generate"
precisely, and "what does my team cost" only as a proxy.** The relay sees the
transport layer (messages, deliveries, nudges, waits); it never sees the model
meter. Almost all real money in a role team is spent inside host turns —
context reads, cache behavior, output tokens — which only the host (or its
logs/APIs) can measure. Any single-number answer that ignores this split is
dishonest, and the FAQ should say so in one paragraph.

## 1. What the relay can measure today (measured)

All of this is local, per-project, and already on disk; none of it leaves the
machine.

| Signal                                | Where                                                                               | Surface today                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Delivered/wait/ack calls per role     | `~/.synloq/data/<key>-audit.jsonl` (`action`, `agentId`, `reasonCode`)              | not surfaced; one `jq`/SQLite-style query away                    |
| Message count and bytes per recipient | relay DB (`SUM(LENGTH(CAST(text AS BLOB)))` already computed per recipient)         | partially via `synloq status` pending counts; bytes not displayed |
| Nudge attempts per role/message       | `~/.synloq/data/<key>.codex-nudges.sqlite` (`nudge_attempts`: count, state, reason) | `blocked=<state>` diagnostics only                                |
| Stored-mail nudges (push hosts)       | stderr logs of the owning channel (ISO-8601 lines)                                  | logs only                                                         |
| Wake-to-ack latency                   | messages table (`created_at` → ack timestamp)                                       | not surfaced                                                      |
| Pending/stuck queues, aging           | messages + sessions tables                                                          | `synloq status` (counts, reasons)                                 |
| Delivery state transitions            | messages table (`delivery_state`)                                                   | `synloq status`, `doctor`                                         |

Gaps to call out honestly: wake-to-ack latency and calls-per-role need either a
small status extension or an ad-hoc query; neither is a protocol change.

## 2. What the relay cannot see (out of scope by construction)

- **Billed usage / invoice.** The relay is loopback transport; the meter lives
  in the host's billing system.
- **Per-turn tokens, context size, cache hit rate.** A delivered prompt turns
  into an arbitrarily large host turn (history, instructions, tools, retries).
  Two identical messages can cost 10× differently depending on chat history
  length and cache behavior. Industry figures for agentic coding sessions put
  input tokens at ~85% of spend with ~25:1 input:output ratios — i.e. the
  dominant cost is context re-read, which the relay never touches.
- **Model choice and plan pricing.** Different hosts, plans, and models price
  the same turn differently; the relay does not know either.

## 3. Host-side facts (verified 2026-11-17)

- **Claude Code**: `/usage` shows session tokens and a locally computed dollar
  estimate; the Usage and Cost Analytics API (beta, Oct 2026) returns per-user
  spend including `products[]=claude_code`. So Claude-side per-role cost is
  obtainable — from Anthropic's side, not from Synloq.
- **Codex CLI, OpenCode, Claude Code (and others)**: the open-source `ccusage`
  tool parses **local session logs** into per-day token counts and
  API-equivalent USD, no API key required. This is the pattern that fits
  local-first best: usage stays on the machine, in the host's own logs.
- **Kimi Work**: operator-visible quota/balance in the client; no public usage
  API was verified during this research — treat as unverified until probed.

Implication: a future "team cost" feature should **ingest host-side usage
data** (local logs or host APIs where the operator opts in), not try to
estimate turns from transport events.

## 4. Proxy model for FAQ/README (proposal)

Three-tier wording, each tier labeled:

1. **Measured (Synloq)**: "Your relay tracks N messages/day, M deliveries,
   K nudges, average wake-to-ack of X minutes. Coordination itself is a few
   kilobytes of text per day — negligible."
2. **Estimated (host)**: "Turn cost depends on your host and plan. Check your
   host's usage view (`/usage` in Claude Code, client quota in Kimi Work,
   `npx ccusage daily` for local logs across Codex/OpenCode/Claude)."
3. **Bounded by design (levers you control)**: Synloq already caps the
   coordination-driven spend: the Codex queue nudger fires at most once per
   30 minutes and at most 5 attempts per message; stored-mail nudges on push
   hosts are content-free and debounced; `synloq status` shows stuck queues
   before they turn into retry loops. Coordination cannot run away: worst case
   is bounded by nudge caps, not by token spend.

The nudger doubles as a cost meter: **cost-per-nudge ≈ cost of one host
turn** on nudge-driven hosts (a nudge causes exactly one wake turn, or none
for unloaded chats). So "nudges per day × your per-turn price" is a defensible
upper-bound estimate for inbox-only hosts — label it `estimated`, never
`measured`.

## 5. What we could build later (not now)

- `synloq status --traffic`: surface the already-computed per-recipient
  count/bytes and wake-to-ack percentiles (measured tier, cheap).
- Optional local ingest of `ccusage`-style logs per host directory, correlated
  by role directory/worktree (estimated tier). Strictly opt-in, local-only —
  consistent with the local-first boundary.
- An FAQ entry with the three-tier wording above.

Explicit non-goals: shipping a token estimator from transport events
(dishonest), and any telemetry that leaves the machine (against the project's
core boundary).

## Bottom line

Can we answer "how much does a 5-role team cost per day"? **Only as a
deliberate split**: coordination traffic — yes, precisely, locally; turn spend
— point at the host's own meters; coordination-driven spend — bounded by
design and roughly meterable via nudge counts. The FAQ should present exactly
this split and no single blended number.
