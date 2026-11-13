import { describe, expect, it } from "vitest";
import { roleInstructions, TEAM_CHARTER_SUMMARY } from "../../src/init/plugin-renderer.js";

const role = {
  agentId: "dev",
  title: "Developer",
  role: "Implements tasks in the workspace.",
};

describe("roleInstructions", () => {
  it("embeds the team charter summary verbatim at the end", () => {
    const instructions = roleInstructions(role);
    expect(instructions.endsWith(TEAM_CHARTER_SUMMARY)).toBe(true);
    expect(instructions).toContain("Team charter (TEAM.md)");
    expect(instructions).toContain("never ask the operator to relay between roles");
    expect(instructions).toContain("pull synloq_inbox yourself");
  });

  it("keeps role identity lines ahead of the charter", () => {
    const instructions = roleInstructions(role);
    expect(instructions.indexOf("Role ID: dev")).toBeGreaterThanOrEqual(0);
    expect(instructions.indexOf("Role ID: dev")).toBeLessThan(
      instructions.indexOf("Team charter (TEAM.md)"),
    );
  });

  it("includes confirmed additions when present", () => {
    const instructions = roleInstructions({ ...role, instructions: "Prefer small commits." });
    expect(instructions).toContain("Confirmed additions: Prefer small commits.");
  });

  it("renders Russian instructions for language=ru", () => {
    const instructions = roleInstructions(role, "ru");
    expect(instructions).toContain("ID роли: dev");
    expect(instructions).toContain("Отображаемое имя: Developer");
    expect(instructions).toContain("Устав команды (TEAM.md)");
    expect(instructions).not.toContain("Role ID:");
    expect(instructions).not.toContain(TEAM_CHARTER_SUMMARY);
  });
});
