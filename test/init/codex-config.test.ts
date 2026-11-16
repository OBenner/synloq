import { describe, expect, it } from "vitest";
import { ownedCodexConfig } from "../../src/init/codex-config.js";

const table = '[mcp_servers.synloq-arch]\ncommand = "node"\nargs = ["stdio.js", "arch.json"]\n';

describe("Codex TOML subtree ownership", () => {
  it("accepts CRLF header comments without altering foreign sections", () => {
    const foreign = '[projects.example] # host-owned\r\ntrust_level = "trusted"\r\n';
    expect(ownedCodexConfig(foreign + table, "arch").replace(table)).toBe(foreign + table);
  });
  it("preserves all bytes outside the owned table across host additions and removal", () => {
    const before = '# user config\r\nmodel = "example"\r\n';
    const after =
      '\n\n[projects."C:\\\\repo"]\r\ntrust_level = "trusted"\r\n[mcp_servers.other]\ncommand = "other"\n';
    const text = before + table + after;
    const owned = ownedCodexConfig(text, "arch");
    expect(owned.text).toBe(table.trimEnd());
    expect(owned.replace(table)).toBe(text);
    expect(owned.replace("")).toBe(before + "\n" + after);
  });

  it("recognizes quoted dotted headers and owned child tables separated by foreign tables", () => {
    const text =
      '["mcp_servers"."synloq-arch"]\ncommand = "node"\n[foreign]\nx = 1\n[mcp_servers."synloq-arch".env]\nEXAMPLE = "value"\n';
    const owned = ownedCodexConfig(text, "arch");
    expect(owned.text).toContain("EXAMPLE");
    expect(owned.replace("")).toBe("\n[foreign]\nx = 1\n\n");
  });

  it("ignores header lookalikes in multiline strings, arrays, and comments", () => {
    const before =
      'description = """\n[mcp_servers.synloq-arch]\ntext\n"""\nvalues = [\n  [1, 2],\n  [3, 4],\n]\n# [mcp_servers.synloq-arch]\n';
    const owned = ownedCodexConfig(before + table, "arch");
    expect(owned.text).toBe(table.trimEnd());
    expect(owned.replace("")).toBe(before + "\n");
  });

  it.each([
    table + table,
    'mcp_servers.synloq-arch.command = "node"\n',
    '[mcp_servers]\nsynloq-arch = {command = "node"}\n',
    "mcp_servers = {}\n",
    '[[mcp_servers.synloq-arch]]\ncommand = "node"\n',
    'description = """unterminated\n',
  ])("refuses ambiguous ownership instead of overwriting: %s", (text) => {
    expect(() => ownedCodexConfig(text, "arch")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
