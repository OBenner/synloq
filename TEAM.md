# Synloq Team Charter

- Status: accepted (operator, 2026-11-12)
- Date: 2026-11-12
- Owner: CTO; changes to the decision-rights matrix (§2) require operator approval, everything else is amended via PR with CTO + Architect dual approval
- Scope: collaboration conventions for Synloq role teams. The wire protocol is governed by `docs/protocol/v1.md`; this charter governs how roles use it. If a rule here conflicts with the spec, the spec wins.

## 1. Direct communication by default

Every role messages any other role directly — the CTO is a coordinator, not a router.

- Address the role that owns the domain: implementation → Developer, architecture/protocol → Architect, threats/hygiene → Security, priorities/decomposition/acceptance → CTO.
- Cross-domain decisions get a NOTICE copy to the CTO, not a request to relay.
- Never ask the operator to relay a message between roles. The relay exists; use it.

## 2. Decision rights

| Level    | Decides                          | Examples                                                                                                                                                    |
| -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role     | Everything inside its own scope  | implementation details (dev), severity assessment (security), design within the accepted spec (arch)                                                        |
| CTO      | Cross-role coordination          | priorities, task decomposition, work assignment, acceptance of RESULTs; spec changes need CTO + Architect dual approval                                     |
| Operator | Irreversible or external actions | publishing/releases, repository settings, destructive operations (history rewrite, deletions outside task scope), external requests, anything costing money |

When unsure which level owns a decision, ask the CTO — not the operator. The CTO escalates to the operator when (and only when) the decision is operator-level.

## 3. Task contract

A TASK always carries: scope, definition of done (commit + green `pnpm verify` unless stated otherwise), and the expected report format (RESULT with commit hashes). The assignee works to completion without check-ins.

- Obstacle → immediate BLOCKED with a reason code and facts, never silence.
- Mid-task status pings are waste; report once, at completion.

## 4. Delivery discipline

- `synloq_ack` after actually reading; replies go to the original thread (`inReplyTo`, same thread, new idempotencyKey) with RESULT/BLOCKED/NOTICE/QUERY prefixes.
- Pull fallback: if you expect a message and see no visible delivery for >15 minutes, pull `synloq_inbox` yourself. Do not ask others to check for you.
- Use only your own MCP channel; never call another role's channel.

## 5. Operator gets a digest, not a drip

The CTO batches operator-level questions and status into milestone summaries. One consolidated ask beats ten interruptions.

## 6. Safe actions vs. operator-gated actions

Allowed without asking (inside task scope): local commits, editing own-scope documents, writing tests, running verify, reading anything.

Requires explicit operator approval: pushes to the public remote, deleting files outside task scope, changing generated role instructions, dependency upgrades, anything destructive or externally visible.

## 7. Amendments

Charter changes follow the ownership rule in the header. The charter is versioned by git; every revision keeps its date and status line.
