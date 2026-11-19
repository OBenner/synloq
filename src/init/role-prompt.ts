import { contactCardLines, type ContactCardRole } from "../config/contact-card.js";
import { DEFAULT_LANGUAGE, translate, type Language } from "../i18n/index.js";
import type { RoleInput } from "./types.js";

/**
 * Single source of role prompt rules across hosts (issue #32, W4).
 *
 * coreRules() is the host-neutral body every role prompt carries — identity,
 * protocol discipline, the backlog sweep rule (TEAM.md), the reactive note,
 * and the team charter (always last; pinned by plugin-renderer tests, #16).
 * Host wrappers append only host-specific mechanics. Issue #108: when the
 * caller passes the team roster, a compact derived contact-card block is
 * inserted before the charter.
 */

export function coreRules(
  role: RoleInput,
  language: Language = DEFAULT_LANGUAGE,
  team?: ContactCardRole[],
): string[] {
  const rules = [
    translate(language, "role.intro"),
    translate(language, "role.id", { agentId: role.agentId }),
    translate(language, "role.displayName", { title: role.title }),
    translate(language, "role.responsibilities", { role: role.role }),
    role.instructions
      ? translate(language, "role.confirmedAdditions", { instructions: role.instructions })
      : undefined,
    translate(language, "role.ownChannel", { agentId: role.agentId }),
    translate(language, "role.prefixes"),
    translate(language, "role.ackRule"),
    translate(language, "role.resultRule"),
    translate(language, "role.approvalRule"),
    translate(language, "role.hopLimit"),
    translate(language, "role.sweepRule"),
    translate(language, "role.reactive"),
    translate(language, "role.memory", { agentId: role.agentId }),
  ].filter((line): line is string => line !== undefined);
  if (team && team.length > 0) rules.push(...contactCardLines(team, role.agentId, language));
  // The charter stays the final line — tests pin instructions.endsWith(charter).
  rules.push(translate(language, "role.charter"));
  return rules;
}

/** Kimi Work prompt: core rules only — the host delivers them as clientInstructions. */
export function roleInstructionsKimi(
  role: RoleInput,
  language: Language = DEFAULT_LANGUAGE,
  team?: ContactCardRole[],
): string {
  return coreRules(role, language, team).join("\n");
}

/**
 * OpenCode prompt: coreRules plus the mechanics this host cannot express in
 * configuration — polling instead of push delivery, the denied foreign tools,
 * and the one-time MCP approval prompt. Posted as the first session message.
 */
export function rolePromptOpenCode(
  role: RoleInput,
  language: Language = DEFAULT_LANGUAGE,
  team?: ContactCardRole[],
): string {
  return [
    ...coreRules(role, language, team),
    translate(language, "opencode.permissions", { agentId: role.agentId }),
    translate(language, "opencode.polling"),
    translate(language, "opencode.approval"),
  ].join("\n");
}
