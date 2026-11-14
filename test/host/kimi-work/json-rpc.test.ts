import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KimiWorkJsonRpcConnection,
  KimiWorkRpcError,
} from "../../../src/host/kimi-work/json-rpc.js";

const token = "test-only-token";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(
  handle: (socket: WebSocket, authorization: string | undefined) => void,
): Promise<{ endpoint: { url: string; token: string }; received: unknown[] }> {
  const received: unknown[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket, request) => {
    handle(socket, request.headers.authorization);
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const address = server.address() as AddressInfo;
  return {
    endpoint: { url: `ws://127.0.0.1:${address.port}/control`, token },
    received,
  };
}

function connect(
  endpoint: { url: string; token: string },
  timeoutMs = 100,
): KimiWorkJsonRpcConnection {
  const connection = new KimiWorkJsonRpcConnection(endpoint, { timeoutMs });
  cleanups.push(() => connection.close());
  return connection;
}

describe("Kimi Work WebSocket JSON-RPC", () => {
  it("authenticates and correlates a result while skipping notifications", async () => {
    const { endpoint, received } = await harness((socket, authorization) => {
      expect(authorization).toBe(`Bearer ${token}`);
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "conversation.updated", params: {} }));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
      });
    });
    const connection = connect(endpoint);

    await expect(
      connection.request(
        "conversations.getBusy",
        { conversationKey: "key" },
        z.object({ ok: z.boolean() }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(received).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "conversations.getBusy",
        params: { conversationKey: "key" },
      },
    ]);
  });

  it("exposes only an allowlisted remote error code", async () => {
    const { endpoint } = await harness((socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32009,
              message: `private ${token}`,
              data: { reasonCode: "CONVERSATION_BUSY", detail: token },
            },
          }),
        );
      });
    });
    const connection = connect(endpoint);

    const error = await connection
      .request("conversations.send", {}, z.unknown())
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(KimiWorkRpcError);
    expect(error).toMatchObject({ rpcCode: -32009, reasonCode: "CONVERSATION_BUSY" });
    expect((error as Error).message).not.toContain(token);
  });

  it("times out without retrying the request", async () => {
    const { endpoint, received } = await harness(() => undefined);
    const connection = connect(endpoint, 10);

    await expect(connection.request("conversations.send", {}, z.unknown())).rejects.toThrow(
      "Kimi Work RPC timed out",
    );
    expect(received).toHaveLength(1);
  });

  it("aborts before or during a request without sending another frame", async () => {
    const { endpoint, received } = await harness(() => undefined);
    const connection = connect(endpoint, 1_000);
    const controller = new AbortController();
    controller.abort();

    await expect(
      connection.request("conversations.send", {}, z.unknown(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toHaveLength(0);
  });

  it("accepts result frames larger than 1 MiB (visible-chat history frames)", async () => {
    const big = "x".repeat(2 * 1_048_576);
    const { endpoint } = await harness((socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { big } }));
      });
    });
    const connection = connect(endpoint, 5_000);

    await expect(
      connection.request("conversations.getMessages", {}, z.object({ big: z.string() })),
    ).resolves.toEqual({ big });
  });

  it("rejects malformed success payloads and pending requests on close", async () => {
    const { endpoint } = await harness((socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        if (request.method === "bad")
          socket.send(`{"jsonrpc":"2.0","id":${request.id},"result":{"ok":"yes"}}`);
      });
    });
    const connection = connect(endpoint, 1_000);

    await expect(connection.request("bad", {}, z.object({ ok: z.boolean() }))).rejects.toThrow(
      "Kimi Work RPC response is invalid",
    );
    const pending = connection.request("pending", {}, z.unknown());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rejected = expect(pending).rejects.toThrow("Kimi Work RPC connection closed");
    await connection.close();
    await rejected;
  });
});
