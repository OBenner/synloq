import { afterEach, describe, expect, it } from "vitest";
import {
  adapterTitle,
  hookTitle,
  mcpTitle,
  relayTitle,
  setProcessTitle,
} from "../../src/cli/process-title.js";

describe("process titles", () => {
  it("formats every entrypoint title", () => {
    expect(relayTitle(4100)).toBe("synloq-relay (port 4100)");
    expect(mcpTitle("arch")).toBe("synloq-mcp: arch");
    expect(adapterTitle("cto")).toBe("synloq-adapter: cto");
    expect(hookTitle("claude")).toBe("synloq-hook: claude");
    expect(hookTitle("codex")).toBe("synloq-hook: codex");
  });

  describe("setProcessTitle", () => {
    const original = process.title;
    afterEach(() => {
      setProcessTitle(original);
    });

    it("sets the title, or leaves it unchanged where the embedder forbids it", () => {
      setProcessTitle("synloq-mcp: arch");
      // Some runtimes (embedded hosts, sandboxed test runners) disallow
      // retitling — the contract is best-effort, never a crash.
      expect([original, "synloq-mcp: arch"]).toContain(process.title);
    });

    it("never throws", () => {
      expect(() => setProcessTitle("synloq-relay (port 4100)")).not.toThrow();
    });
  });
});
