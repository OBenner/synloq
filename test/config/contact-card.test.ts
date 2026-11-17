import { describe, expect, it } from "vitest";
import {
  contactCardLines,
  reachMode,
  reachTag,
  type ContactCardRole,
} from "../../src/config/contact-card.js";
import { MAX_NUDGES, NUDGE_COOLDOWN_MS } from "../../src/storage/nudge-ledger.js";

const team: ContactCardRole[] = [
  { agentId: "cto", host: "kimi-work" },
  { agentId: "tester", host: "opencode" },
  { agentId: "staff1", host: "codex-desktop" },
  { agentId: "staff2", host: "generic" },
  { agentId: "misc", host: "generic" },
];

describe("reachMode (#108)", () => {
  it("derives push for push-capable hosts", () => {
    expect(reachMode({ agentId: "a", host: "kimi-work" })).toBe("push");
    expect(reachMode({ agentId: "a", host: "opencode" })).toBe("push");
  });

  it("derives queue-nudge for Codex Desktop (opt-in nudger)", () => {
    expect(reachMode({ agentId: "a", host: "codex-desktop" })).toBe("queue-nudge");
  });

  it("derives next-interaction for hosts without push or a nudger", () => {
    // Claude Desktop roles are declared as `generic`: no push, no nudger —
    // the card honestly reports inbox-only next-interaction reachability.
    expect(reachMode({ agentId: "a", host: "zcode" })).toBe("next-interaction");
    expect(reachMode({ agentId: "a", host: "generic" })).toBe("next-interaction");
  });

  it("defaults a missing host to kimi-work (push)", () => {
    expect(reachMode({ agentId: "a" })).toBe("push");
  });
});

describe("contactCardLines (#108)", () => {
  it("starts with the header and renders one line per teammate plus the self line", () => {
    const lines = contactCardLines(team, "staff1", "en");
    expect(lines[0]).toContain("Reachability");
    expect(lines).toHaveLength(team.length + 1);
    expect(lines[1]).toContain("inbox + queue nudge");
    expect(lines[1]).toContain(String(NUDGE_COOLDOWN_MS / 60_000));
    expect(lines[1]).toContain(String(MAX_NUDGES));
    // Teammate lines name the role and its host.
    const ctoLine = lines.find((line) => line.includes("cto"))!;
    expect(ctoLine).toContain("(kimi-work)");
    expect(ctoLine).toContain("push");
    const staff2Line = lines.find((line) => line.includes("staff2"))!;
    expect(staff2Line).toContain("(generic)");
    expect(staff2Line).toContain("inbox-only");
  });

  it("localizes the block (ru)", () => {
    const lines = contactCardLines(team, "staff2", "ru");
    expect(lines[0]).toContain("Доступность");
    expect(lines[1]).toContain("только inbox");
    expect(lines[1]).toContain("автоматического пробуждения нет");
  });

  it("omits the self line when the role is not in the team", () => {
    const lines = contactCardLines(team, "outsider", "en");
    expect(lines).toHaveLength(team.length + 1);
    expect(lines.slice(1).every((line) => !line.startsWith("Your delivery"))).toBe(true);
  });
});

describe("reachTag (#108)", () => {
  it("renders the nudger numbers from constants, never literals", () => {
    const tag = reachTag({ agentId: "staff1", host: "codex-desktop" });
    expect(tag).toContain(`${NUDGE_COOLDOWN_MS / 60_000} minutes`);
    expect(tag).toContain(`${MAX_NUDGES} attempts`);
    expect(tag).toContain("unloaded chat may not start a turn");
  });

  it("renders push and next-interaction tags", () => {
    expect(reachTag({ agentId: "a", host: "kimi-work" })).toContain("push delivery");
    expect(reachTag({ agentId: "a", host: "generic" })).toContain("no automatic wake-up");
  });
});
