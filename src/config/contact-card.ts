import { translate, type Language } from "../i18n/index.js";
import { MAX_NUDGES, NUDGE_COOLDOWN_MS } from "../storage/nudge-ledger.js";
import { HOST_CAPABILITIES, type HostName } from "./hosts.js";

/**
 * Role contact cards (issue #108). A compact, derived summary of how
 * reachable each role is, computed from data that already exists — the
 * manifest host and the host capability matrix plus the Codex queue-nudger
 * bounds. No new configuration: the card is a rendering of existing facts.
 *
 * Two surfaces consume this module: the role instructions rendered at init
 * (localized, via coreRules) and the relay's synloq_list output (English tag,
 * following the convention that relay-generated surfaces stay English).
 */

export type ReachMode = "push" | "queue-nudge" | "next-interaction";

export interface ContactCardRole {
  agentId: string;
  host?: HostName | undefined;
}

export function roleHost(role: ContactCardRole): HostName {
  return role.host ?? "kimi-work";
}

/** Reachability of a role, derived from its host's capabilities. */
export function reachMode(role: ContactCardRole): ReachMode {
  const host = roleHost(role);
  if (HOST_CAPABILITIES[host].hasPush) return "push";
  if (host === "codex-desktop") return "queue-nudge";
  return "next-interaction";
}

function nudgeParams() {
  return { cooldownMin: NUDGE_COOLDOWN_MS / 60_000, maxAttempts: MAX_NUDGES };
}

/**
 * Localized contact-card lines for one role's instruction block: a self line
 * describing the role's own delivery mode, then one line per teammate.
 */
export function contactCardLines(
  team: ContactCardRole[],
  selfId: string,
  language: Language,
): string[] {
  const lines: string[] = [translate(language, "contact.header")];
  const self = team.find((member) => member.agentId === selfId);
  if (self) {
    lines.push(translate(language, `contact.self.${reachMode(self)}`, nudgeParams()));
  }
  for (const member of team.filter((candidate) => candidate.agentId !== selfId)) {
    lines.push(
      translate(language, `contact.${reachMode(member)}`, {
        agentId: member.agentId,
        host: roleHost(member),
        ...nudgeParams(),
      }),
    );
  }
  return lines;
}

/**
 * Short English reachability tag for the relay's synloq_list output. Relay
 * surfaces stay English by convention (like protocol frames and reason
 * codes); the numbers come from the nudger constants, never literals.
 */
export function reachTag(role: ContactCardRole): string {
  switch (reachMode(role)) {
    case "push":
      return "push delivery — replies appear in the chat automatically";
    case "queue-nudge":
      return (
        `inbox + queue nudge — at most once per ${NUDGE_COOLDOWN_MS / 60_000} minutes, ` +
        `${MAX_NUDGES} attempts per message; an unloaded chat may not start a turn`
      );
    case "next-interaction":
      return "inbox-only — reacts on next interaction or an inbox sweep; no automatic wake-up";
  }
}
