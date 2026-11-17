import { describe, expect, it } from "vitest";
import { coreRules, roleInstructionsKimi, rolePromptOpenCode } from "../../src/init/role-prompt.js";
import { TEAM_CHARTER_SUMMARY } from "../../src/init/plugin-renderer.js";

const role = {
  agentId: "tester",
  title: "Tester",
  role: "Verifies acceptance criteria with real runs.",
};

describe("coreRules (#32 W4)", () => {
  it("is the shared body of every host prompt, charter last", () => {
    const lines = coreRules(role);
    expect(lines[0]).toBe("You are one visible role in a Synloq project team.");
    expect(lines.at(-1)).toBe(TEAM_CHARTER_SUMMARY);
  });

  it("names the assigned channel explicitly (field feedback from tester)", () => {
    expect(coreRules(role).join("\n")).toContain("synloq-tester");
  });

  it("carries the backlog sweep rule and the reactive note", () => {
    const body = coreRules(role).join("\n");
    expect(body).toContain("sweep first: read the whole backlog with synloq_inbox");
    expect(body).toContain("You are reactive: you run only when the operator");
  });
});

describe("coreRules contact card (#108)", () => {
  const team = [
    { agentId: "tester", host: "opencode" as const },
    { agentId: "staff1", host: "codex-desktop" as const },
    { agentId: "staff2", host: "generic" as const },
  ];

  it("inserts the derived reachability block before the charter", () => {
    const lines = coreRules(role, "en", team);
    expect(lines.at(-1)).toBe(TEAM_CHARTER_SUMMARY);
    const headerIndex = lines.findIndex((line) => line.includes("Reachability"));
    expect(headerIndex).toBeGreaterThan(-1);
    expect(headerIndex).toBeLessThan(lines.length - 1);
    // The line after the header is the self line (tester = opencode = push).
    expect(lines[headerIndex + 1]).toContain("Your delivery: push");
    expect(lines.join("\n")).toContain("queue nudge");
    expect(lines.join("\n")).toContain("staff2 (generic): inbox-only");
  });

  it("renders the self line for the addressed role", () => {
    const lines = coreRules(role, "en", [{ agentId: "tester", host: "opencode" }]);
    expect(lines.join("\n")).toContain("Your delivery: push");
  });

  it("omits the block when no team is passed", () => {
    expect(coreRules(role).join("\n")).not.toContain("Reachability");
  });
});

describe("roleInstructionsKimi", () => {
  it("is the core rules joined, with no host mechanics", () => {
    const prompt = roleInstructionsKimi(role);
    expect(prompt).toBe(coreRules(role).join("\n"));
    expect(prompt.endsWith(TEAM_CHARTER_SUMMARY)).toBe(true);
    expect(prompt).not.toContain("polling");
  });
});

describe("rolePromptOpenCode", () => {
  it("appends the OpenCode mechanics after the core rules", () => {
    const prompt = rolePromptOpenCode(role);
    expect(prompt).toContain("Role ID: tester");
    expect(prompt).toContain(TEAM_CHARTER_SUMMARY);
    expect(prompt).toContain("MCP server");
    expect(prompt).toContain("deny other roles' tools");
    expect(prompt).toContain("no automatic push delivery");
    expect(prompt).toContain("synloq_wait for idle waiting");
    expect(prompt).toContain("one-time approval in the OpenCode UI");
  });

  it("renders the OpenCode mechanics in Russian for language=ru", () => {
    const prompt = rolePromptOpenCode(role, "ru");
    expect(prompt).toContain("ID роли: tester");
    expect(prompt).toContain("MCP-сервер synloq-tester");
    expect(prompt).toContain("synloq_wait");
    expect(prompt).not.toContain("Role ID:");
  });
});
