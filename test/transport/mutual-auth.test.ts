import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RelayHttpClient } from "../../src/transport/http-client.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("mutual relay authentication", () => {
  it("a squatter copying health cannot capture a credential or business body", async () => {
    const captured: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      captured.push(JSON.stringify(request.headers), Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/health"
            ? { service: "synloq-relay", protocolVersion: 1 }
            : { participants: [] },
        ),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const token = crypto.randomUUID();
    const client = new RelayHttpClient(`http://127.0.0.1:${address.port}`, () => token, {
      project: "test",
      agentId: "cto",
    });
    // No caller-side health prerequisite: every request must protect itself.
    await expect(
      client.send({
        to: "arch",
        text: "private-business-body",
        expectsReply: false,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(captured).toHaveLength(2);
    expect(captured.join("\n")).not.toContain(token);
    expect(captured.join("\n")).not.toContain("private-business-body");
  });
});
