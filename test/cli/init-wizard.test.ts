import { describe, expect, it } from "vitest";
import { runInitWizard } from "../../src/cli/init-wizard.js";

describe("runInitWizard", () => {
  it("collects and confirms arbitrary role definitions", async () => {
    const answers = [
      "example",
      "product",
      "Product",
      "Own scope and priorities",
      "Keep decisions visible",
      "yes",
      "reviewer",
      "Reviewer",
      "Review evidence and risks",
      "",
      "no",
      "yes",
    ];
    const output: string[] = [];

    await expect(
      runInitWizard({
        question: async () => answers.shift() ?? "",
        write: (line) => output.push(line),
      }),
    ).resolves.toEqual({
      project: "example",
      roles: [
        {
          agentId: "product",
          title: "Product",
          role: "Own scope and priorities",
          instructions: "Keep decisions visible",
        },
        {
          agentId: "reviewer",
          title: "Reviewer",
          role: "Review evidence and risks",
        },
      ],
    });
    expect(output.join("\n")).toContain("product");
    expect(output.join("\n")).toContain("reviewer");
  });

  it("rejects an unconfirmed or empty role set", async () => {
    await expect(
      runInitWizard({ question: async () => "", write: () => undefined }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const answers = ["example", "product", "Product", "Own scope", "", "no", "no"];
    await expect(
      runInitWizard({
        question: async () => answers.shift() ?? "",
        write: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
