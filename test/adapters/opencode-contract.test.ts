import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpencodeClient as OpenCodeClient } from "@opencode-ai/sdk/client";
import type { OpencodeClient as OpenCodeV2Client } from "@opencode-ai/sdk/v2/client";
import { expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { SynloqError } from "../../src/domain/errors.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";
import {
  CONTRACT_AGENT,
  CONTRACT_PROJECT,
  CONTRACT_SESSION,
  MutableClock,
  contractCapabilities,
  contractRegistration,
  runAdapterContract,
  type Harness,
  type VisibleEntry,
} from "./contract.js";

interface PromptParameters {
  sessionID: string;
  prompt: { text: string };
}

runAdapterContract("OpenCodeAdapter delivery contract", (capabilities = contractCapabilities()) => {
  const clock = new MutableClock();
  const store = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:", clock);
  const visible: VisibleEntry[] = [];
  const failures = new Set<string>();
  const prompt = vi.fn(async (parameters: PromptParameters) => {
    const messageId = /message="([^"]+)"/.exec(parameters.prompt.text)?.[1];
    if (!messageId) throw new Error("fake OpenCode prompt has no Synloq message ID");
    if (failures.delete(messageId)) {
      // The fake rejects before transmission, which is safe for ordinary retry backoff.
      throw new SynloqError("INVALID_INPUT", `forced pre-transmission failure for ${messageId}`);
    }
    const entry = { id: messageId, content: parameters.prompt.text };
    visible.push(entry);
    return {
      data: {
        data: {
          admittedSeq: visible.length,
          id: messageId,
          sessionID: parameters.sessionID,
          prompt: parameters.prompt,
          delivery: "queue",
          timeCreated: visible.length,
        },
      },
    };
  });
  const openCode = { v2: { session: { prompt } } } as unknown as OpenCodeV2Client;
  const client = {} as OpenCodeClient;
  const relay = { closeSession: vi.fn().mockResolvedValue({}) } as unknown as RelayHttpClient;
  const adapter = new OpenCodeAdapter(
    openCode,
    client,
    relay,
    { project: CONTRACT_PROJECT, agentId: CONTRACT_AGENT, sessionId: CONTRACT_SESSION },
    capabilities,
  );
  sessions.register(contractRegistration(CONTRACT_SESSION, capabilities), false);
  const dispatcher = new Dispatcher(
    store,
    sessions,
    new Map([[`${CONTRACT_PROJECT}/${CONTRACT_AGENT}`, adapter]]),
    clock,
  );

  const harness: Harness = {
    adapter,
    sessions,
    store,
    clock,
    visible,
    dispatcher,
    setState(state) {
      sessions.heartbeat(CONTRACT_PROJECT, CONTRACT_AGENT, CONTRACT_SESSION, state);
    },
    failNext(messageId) {
      failures.add(messageId);
    },
    close() {
      void adapter.close();
      sessions.close();
      store.close();
    },
  };
  return harness;
});

it("uses queued delivery and contains no steering call path", () => {
  const sourcePath = fileURLToPath(new URL("../../src/adapters/opencode.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain('delivery: "queue"');
  expect(source).not.toContain('delivery: "steer"');
});
