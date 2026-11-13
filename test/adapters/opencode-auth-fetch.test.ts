import { describe, expect, it } from "vitest";
import { openCodeBasicAuthFetch } from "../../src/adapters/opencode.js";

describe("openCodeBasicAuthFetch", () => {
  it("injects the Basic header and preserves existing request headers", async () => {
    const seen: Request[] = [];
    const wrapped = openCodeBasicAuthFetch("pw", async (request) => {
      seen.push(request);
      return new Response("{}");
    });
    const original = new Request("http://127.0.0.1:1/api/session", {
      headers: { "content-type": "application/json" },
    });
    await wrapped(original);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
    );
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.url).toBe(original.url);
    expect(original.headers.get("authorization")).toBeNull();
  });
});
