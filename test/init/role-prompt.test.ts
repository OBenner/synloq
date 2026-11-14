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
