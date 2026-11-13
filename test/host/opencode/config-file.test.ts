import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeOpencodeMcpServers } from "../../../src/host/opencode/config-file.js";

const servers = {
  "synloq-cto": {
    type: "local" as const,
    command: ["node", "dist/mcp/stdio.js", "C:\\home\\runtime\\k\\mcp\\cto.json"],
    enabled: true,
  },
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("mergeOpencodeMcpServers", () => {
  it("creates opencode.json when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-merge-"));
    const path = await mergeOpencodeMcpServers(root, servers);
    expect(path).toBe(join(root, "opencode.json"));
    expect(await readJson(path)).toEqual({ mcp: { servers } });
  });

  it("preserves foreign top-level, mcp, and server keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-merge-"));
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "openai/gpt-5",
        mcp: {
          servers: { "other-tool": { type: "local", command: ["other"], enabled: false } },
          extra: { keep: true },
        },
      }),
    );
    await mergeOpencodeMcpServers(root, servers);
    expect(await readJson(join(root, "opencode.json"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "openai/gpt-5",
      mcp: {
        servers: {
          "other-tool": { type: "local", command: ["other"], enabled: false },
          ...servers,
        },
        extra: { keep: true },
      },
    });
  });

  it("is byte-identical on re-run with the same entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-merge-"));
    const path = await mergeOpencodeMcpServers(root, servers);
    const first = await readFile(path, "utf8");
    await mergeOpencodeMcpServers(root, servers);
    expect(await readFile(path, "utf8")).toBe(first);
  });

  it("fails loud on malformed existing JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-merge-"));
    await writeFile(join(root, "opencode.json"), "{ not json");
    await expect(mergeOpencodeMcpServers(root, servers)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("fails loud when root or mcp is not an object", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-opencode-merge-"));
    await writeFile(join(root, "opencode.json"), '["array"]');
    await expect(mergeOpencodeMcpServers(root, servers)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await writeFile(join(root, "opencode.json"), '{"mcp": 42}');
    await expect(mergeOpencodeMcpServers(root, servers)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
