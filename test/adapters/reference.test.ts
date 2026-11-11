import { describe, expect, it } from "vitest";
import { ReferenceAdapter } from "../../src/adapters/reference.js";
import type { Message } from "../../src/domain/message.js";
import { Dispatcher } from "../../src/relay/dispatcher.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";
import {
  CONTRACT_AGENT,
  CONTRACT_PROJECT,
  CONTRACT_SESSION,
  MutableClock,
  contractCapabilities,
  contractDatabase,
  contractRegistration,
  runAdapterContract,
  type Harness,
} from "./contract.js";

runAdapterContract(
  "ReferenceAdapter delivery contract",
  (capabilities = contractCapabilities()) => {
    const clock = new MutableClock();
    const database = contractDatabase();
    const store = new SQLiteMessageStore(database, clock);
    const sessions = new SessionStore(database, clock);
    const adapter = new ReferenceAdapter(capabilities);
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
      visible: adapter.visible(CONTRACT_SESSION),
      dispatcher,
      setState(state) {
        adapter.setState(CONTRACT_SESSION, state);
        sessions.heartbeat(CONTRACT_PROJECT, CONTRACT_AGENT, CONTRACT_SESSION, state);
      },
      failNext(messageId) {
        adapter.failNext(messageId);
      },
      close() {
        sessions.close();
        store.close();
      },
    };
    return harness;
  },
);

describe("ReferenceAdapter session guard", () => {
  it("rejects a new submission while its visible session is not idle", async () => {
    const adapter = new ReferenceAdapter();
    adapter.setState(CONTRACT_SESSION, "busy");
    const message: Message = {
      id: "message-direct-busy",
      project: CONTRACT_PROJECT,
      from: "cto",
      to: CONTRACT_AGENT,
      text: "Do not steer",
      expectsReply: false,
      idempotencyKey: "message-direct-busy",
      threadId: "thread-direct-busy",
      createdAt: "2026-11-09T00:00:00.000Z",
      deliveryState: "stored",
    };

    await expect(adapter.submit(CONTRACT_SESSION, message)).rejects.toThrow(
      "visible session is not idle",
    );
    expect(adapter.visible(CONTRACT_SESSION)).toEqual([]);
  });
});
