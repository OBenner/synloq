import { describe, expect, it } from "vitest";
import { OpencodeApiClient, type OpenCodeFetch } from "../../../src/host/opencode/client.js";

function fetchSequence(steps: Array<{ status: number; body?: unknown }>): {
  fetchImpl: OpenCodeFetch;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: OpenCodeFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}),
    });
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    return {
      status: step.status,
      text: async () => (step.body === undefined ? "" : JSON.stringify(step.body)),
    };
  };
  return { fetchImpl, calls };
}

describe("OpencodeApiClient", () => {
  it("rejects a non-loopback base URL", () => {
    try {
      new OpencodeApiClient("http://203.0.113.10:8080");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("creates a session with deny rules for other roles' tools", async () => {
    const { fetchImpl, calls } = fetchSequence([{ status: 200, body: { data: { id: "ses_1" } } }]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    const created = await client.createSession({
      title: "CTO",
      directory: "I:\\project",
      denyTools: ["synloq-arch*", "synloq-dev*"],
    });
    expect(created).toEqual({ id: "ses_1", permissionsApplied: true });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:52314/api/session",
        method: "POST",
        body: {
          title: "CTO",
          location: { directory: "I:\\project" },
          permissions: [
            { action: "synloq-arch*", resource: "*", effect: "deny" },
            { action: "synloq-dev*", resource: "*", effect: "deny" },
          ],
        },
      },
    ]);
  });

  it("fails soft: retries without permissions when the ruleset is rejected", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 400, body: { error: "bad permissions" } },
      { status: 200, body: { data: { id: "ses_2" } } },
    ]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314/", { fetch: fetchImpl });
    const created = await client.createSession({
      title: "CTO",
      directory: "/project",
      denyTools: ["synloq-arch*"],
    });
    expect(created).toEqual({ id: "ses_2", permissionsApplied: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ title: "CTO", location: { directory: "/project" } });
  });

  it("fails loud when session creation fails without a permissions cause", async () => {
    const { fetchImpl } = fetchSequence([{ status: 400, body: { error: "bad request" } }]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    await expect(
      client.createSession({ title: "CTO", directory: "/project", denyTools: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("maps a dead service to NOT_FOUND", async () => {
    const fetchImpl: OpenCodeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    await expect(client.getSession("ses_x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads sessions: 200 with matching id, 404 as missing", async () => {
    const { fetchImpl, calls } = fetchSequence([
      { status: 200, body: { data: { id: "ses_1" } } },
      { status: 404 },
    ]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    await expect(client.getSession("ses_1")).resolves.toBe(true);
    await expect(client.getSession("ses_gone")).resolves.toBe(false);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:52314/api/session/ses_1",
    });
  });

  it("posts prompts and rejects error statuses", async () => {
    const { fetchImpl, calls } = fetchSequence([{ status: 200, body: {} }]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    await client.postPrompt("ses_1", "hello role");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:52314/api/session/ses_1/prompt",
        method: "POST",
        body: { text: "hello role" },
      },
    ]);

    const failing = new OpencodeApiClient("http://127.0.0.1:52314", {
      fetch: fetchSequence([{ status: 409 }]).fetchImpl,
    });
    await expect(failing.postPrompt("ses_1", "x")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("sends the bearer password only when one is configured", async () => {
    const seen: Array<Record<string, string>> = [];
    const capture: OpenCodeFetch = async (_url, init) => {
      seen.push(init.headers);
      return { status: 200, text: async () => '{"data":{"id":"ses_1"}}' };
    };
    const authed = new OpencodeApiClient("http://127.0.0.1:52314", {
      fetch: capture,
      authToken: "service-password",
    });
    await authed.createSession({ title: "CTO", directory: "/p", denyTools: [] });
    expect(seen[0]).toEqual({
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("opencode:service-password").toString("base64")}`,
    });

    const anonymous = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: capture });
    await anonymous.createSession({ title: "CTO", directory: "/p", denyTools: [] });
    expect(seen[1]).toEqual({ "content-type": "application/json" });
  });

  it("tolerates a bare payload without the data envelope", async () => {
    const { fetchImpl } = fetchSequence([{ status: 200, body: { id: "ses_bare" } }]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    const created = await client.createSession({ title: "CTO", directory: "/p", denyTools: [] });
    expect(created).toEqual({ id: "ses_bare", permissionsApplied: false });
  });

  it("maps 401 to a clear unauthorized error without a permissions retry", async () => {
    const { fetchImpl, calls } = fetchSequence([{ status: 401 }]);
    const client = new OpencodeApiClient("http://127.0.0.1:52314", { fetch: fetchImpl });
    await expect(
      client.createSession({ title: "CTO", directory: "/p", denyTools: ["synloq-arch*"] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("unauthorized"),
    });
    expect(calls).toHaveLength(1);
  });
});
