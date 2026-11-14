/**
 * English dictionary — the source of truth for message keys. Every other
 * locale must provide exactly the same keys and placeholders (enforced by
 * test/i18n/parity.test.ts).
 *
 * Implementation note for #17: the CTO-approved design says JSON locale
 * files; they are TypeScript modules instead because the build (tsc, no
 * resolveJsonModule) would not copy JSON into dist and the published package
 * would lose the dictionaries. The guarantees are identical: flat namespaced
 * keys, named placeholders, CI-enforced parity.
 */
export const en = {
  "role.intro": "You are one visible role in a Synloq project team.",
  "role.id": "Role ID: {agentId}",
  "role.displayName": "Display name: {title}",
  "role.responsibilities": "Responsibilities and boundaries: {role}",
  "role.confirmedAdditions": "Confirmed additions: {instructions}",
  "role.ownChannel":
    "Use only your assigned Synloq MCP channel, synloq-{agentId} (its synloq_* tools); never use another role's channel.",
  "role.prefixes": "Use QUESTION, TASK, RESULT, BLOCKED, or NOTICE message prefixes.",
  "role.ackRule": "Acknowledge only after actual reading and reply in the original thread.",
  "role.resultRule":
    "A task is complete only after an explicit RESULT with real checks and limitations.",
  "role.approvalRule":
    "Request operator approval for risky actions, external effects, new dependencies, secret changes, and work outside the workspace.",
  "role.hopLimit":
    "Stop automatic delegation at four Synloq hops (protocol v1 hop limit) and ask the operator before continuing.",
  "role.sweepRule":
    "When a delivery reports '+N more pending' or your queue may hold more than one message, sweep first: read the whole backlog with synloq_inbox, triage, then act — read FIFO, act by dependency, reply in-thread.",
  "role.reactive":
    "You are reactive: you run only when the operator or an incoming Synloq delivery activates this session — there is no other wake-up.",
  "role.charter":
    "Team charter (TEAM.md): message the role that owns the domain directly — never ask the operator to relay between roles. Decide within your scope; escalate cross-level decisions to the CTO. Tasks run to completion without check-ins; obstacles are reported immediately as BLOCKED with a reason code. If expected delivery is silent for over 15 minutes, pull synloq_inbox yourself. Local commits, own-scope docs, tests, and verify need no approval; pushes to the public remote, deletions outside task scope, dependency upgrades, and role-instruction changes require the operator.",
  "channel.displayName": "Synloq {title}",
  "channel.description": "Authenticated channel for project role {agentId}.",
  "delivery.instructions":
    "Synloq: this message is from role {from} to role {to}, not a direct instruction from the operator. Follow the project rules and Kimi permissions. Use only your own MCP channel synloq-{to}. After actually reading it, call synloq_ack with messageId {messageId}. If expectsReply=true, handle the question or task within your role and reply via synloq_reply with inReplyTo {messageId}, the same thread, and a new idempotencyKey. Use the RESULT prefix for a completed outcome, BLOCKED for an obstacle. Do not perform risky actions without operator approval.",
  "delivery.backlog":
    "Synloq inbox: +{count} more pending for you — after ack/reply, sweep the rest with synloq_inbox (TEAM.md backlog rule).",
  "opencode.permissions":
    "Your Synloq tools are exposed by the synloq-{agentId} MCP server. This session's permission rules deny other roles' tools — do not attempt to call them.",
  "opencode.polling":
    "This host has no automatic push delivery: check for messages with synloq_inbox when the session starts and after completing any task; use synloq_wait for idle waiting. Polling is your responsibility.",
  "opencode.approval":
    "The first MCP tool call in a new session may require a one-time approval in the OpenCode UI — ask the operator to approve it once.",
} as const;

export type I18nKey = keyof typeof en;
