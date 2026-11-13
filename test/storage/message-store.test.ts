import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SynloqError } from "../../src/domain/errors.js";
import type { SendMessageInput } from "../../src/domain/message.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const validInput: SendMessageInput = {
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the storage boundary",
  expectsReply: true,
  idempotencyKey: "cto-0001",
};

const stores: SQLiteMessageStore[] = [];
const temporaryDirectories: string[] = [];

function makeStore(path = ":memory:"): SQLiteMessageStore {
  const store = new SQLiteMessageStore(path);
  stores.push(store);
  return store;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function uniqueInput(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return { ...validInput, idempotencyKey: crypto.randomUUID(), ...overrides };
}

function createAt(store: SQLiteMessageStore, id: string, createdAt: string, input = uniqueInput()) {
  return store.create(input, id, createdAt, crypto.randomUUID()).message;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteMessageStore", () => {
  it("returns the original result for an idempotent retry", () => {
    const store = makeStore();
    const first = store.create(
      validInput,
      crypto.randomUUID(),
      "2026-11-09T00:00:00.000Z",
      crypto.randomUUID(),
    );
    const retry = store.create(
      validInput,
      crypto.randomUUID(),
      "2026-11-09T00:00:01.000Z",
      crypto.randomUUID(),
    );

    expect(first.created).toBe(true);
    expect(retry.message).toEqual(first.message);
    expect(retry.created).toBe(false);
    expect(store.getByIdempotency("verdicta", "cto", validInput.idempotencyKey)).toEqual(
      first.message,
    );
    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
  });

  it.each([
    ["text", { text: "different" }],
    ["recipient", { to: "tester" }],
    ["reply expectation", { expectsReply: false }],
    ["reply parent", { inReplyTo: crypto.randomUUID() }],
  ])("rejects reuse of a key with different %s", (_field, override) => {
    const store = makeStore();
    store.create(validInput, crypto.randomUUID(), new Date().toISOString(), crypto.randomUUID());

    expect(() =>
      store.create(
        { ...validInput, ...override },
        crypto.randomUUID(),
        new Date().toISOString(),
        crypto.randomUUID(),
      ),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
  });

  it("preserves a reply parent and its supplied thread", () => {
    const store = makeStore();
    const parentId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const parent = store.create(validInput, parentId, new Date().toISOString(), threadId).message;
    const reply = store.create(
      uniqueInput({ from: "arch", to: "cto", inReplyTo: parent.id, expectsReply: false }),
      crypto.randomUUID(),
      new Date().toISOString(),
      threadId,
    ).message;

    expect(reply.inReplyTo).toBe(parent.id);
    expect(reply.threadId).toBe(parent.threadId);
    expect(store.getMessage(reply.id)).toEqual(reply);
    expect(store.getMessage(crypto.randomUUID())).toBeUndefined();
  });

  it("returns stored messages in FIFO order for one recipient", () => {
    const store = makeStore();
    const later = createAt(store, crypto.randomUUID(), "2026-11-09T00:00:02.000Z");
    const earlier = createAt(store, crypto.randomUUID(), "2026-11-09T00:00:01.000Z");
    createAt(store, crypto.randomUUID(), "2026-11-09T00:00:00.000Z", uniqueInput({ to: "tester" }));

    expect(store.nextPending("verdicta", "arch")?.id).toBe(earlier.id);
    store.setDeliveryState(earlier.id, "submitted");
    expect(store.nextPending("verdicta", "arch")).toBeUndefined();
    store.setDeliveryState(earlier.id, "delivered");
    expect(store.nextPending("verdicta", "arch")?.id).toBe(later.id);
    expect(store.nextPending("verdicta", "tester")?.to).toBe("tester");
  });

  it("uses message ID to preserve FIFO and blocking when timestamps tie", () => {
    const store = makeStore();
    const first = createAt(
      store,
      "00000000-0000-4000-8000-000000000001",
      "2026-11-09T00:00:00.000Z",
    );
    const second = createAt(
      store,
      "00000000-0000-4000-8000-000000000002",
      "2026-11-09T00:00:00.000Z",
    );

    expect(store.nextPending("verdicta", "arch")?.id).toBe(first.id);
    store.setDeliveryState(first.id, "submitted");
    expect(store.nextPending("verdicta", "arch")).toBeUndefined();
    store.setDeliveryState(first.id, "delivered");
    expect(store.nextPending("verdicta", "arch")?.id).toBe(second.id);
  });

  it("allows only the legal delivery transitions", () => {
    const store = makeStore();
    const message = createAt(store, crypto.randomUUID(), new Date().toISOString());

    expect(store.setDeliveryState(message.id, "submitted").deliveryState).toBe("submitted");
    expect(store.setDeliveryState(message.id, "delivered").deliveryState).toBe("delivered");
    expect(store.setDeliveryState(message.id, "acked").deliveryState).toBe("acked");
    expect(store.getMessage(message.id)?.deliveryState).toBe("acked");
  });

  it("records stored to delivered through both legal transitions", () => {
    const store = makeStore();
    const message = createAt(store, crypto.randomUUID(), new Date().toISOString());

    expect(store.setDeliveryState(message.id, "delivered").deliveryState).toBe("delivered");
    expect(store.getMessage(message.id)?.deliveryState).toBe("delivered");
  });

  it.each([
    ["stored", "acked"],
    ["submitted", "stored"],
    ["delivered", "submitted"],
    ["acked", "delivered"],
  ] as const)("rejects an invalid %s to %s transition", (initial, target) => {
    const store = makeStore();
    const message = createAt(store, crypto.randomUUID(), new Date().toISOString());
    if (initial !== "stored") store.setDeliveryState(message.id, "submitted");
    if (initial === "delivered" || initial === "acked") {
      store.setDeliveryState(message.id, "delivered");
    }
    if (initial === "acked") store.setDeliveryState(message.id, "acked");

    expect(() => store.setDeliveryState(message.id, target)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(store.getMessage(message.id)?.deliveryState).toBe(initial);
  });

  it("rejects a transition for a missing message", () => {
    const store = makeStore();
    expect(() => store.setDeliveryState(crypto.randomUUID(), "submitted")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("allows only the authenticated recipient to acknowledge", () => {
    const store = makeStore();
    const message = createAt(store, crypto.randomUUID(), new Date().toISOString());
    store.setDeliveryState(message.id, "submitted");
    store.setDeliveryState(message.id, "delivered");

    expect(() => store.acknowledge(message.id, "verdicta", "cto")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(() => store.acknowledge(message.id, "another-project", "arch")).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
    expect(store.getMessage(message.id)?.deliveryState).toBe("delivered");
    expect(store.acknowledge(message.id, "verdicta", "arch").deliveryState).toBe("acked");
    expect(store.acknowledge(message.id, "verdicta", "arch").deliveryState).toBe("acked");
  });

  it("paginates the inbox with an opaque created-at and ID cursor", () => {
    const store = makeStore();
    const createdAt = "2026-11-09T00:00:00.000Z";
    const third = createAt(store, "00000000-0000-4000-8000-000000000003", createdAt);
    const first = createAt(store, "00000000-0000-4000-8000-000000000001", createdAt);
    const second = createAt(store, "00000000-0000-4000-8000-000000000002", createdAt);
    createAt(store, crypto.randomUUID(), createdAt, uniqueInput({ project: "another-project" }));
    createAt(store, crypto.randomUUID(), createdAt, uniqueInput({ to: "tester" }));

    const firstPage = store.listInbox("verdicta", "arch", undefined, 2);
    expect(firstPage.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toContain(createdAt);

    const secondPage = store.listInbox("verdicta", "arch", firstPage.nextCursor, 2);
    expect(secondPage.messages.map((message) => message.id)).toEqual([third.id]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(store.listInbox("verdicta", "arch", secondPage.nextCursor, 50).messages).toHaveLength(3);
  });

  it.each([0, 101, 1.5])("rejects an invalid inbox limit of %s", (limit) => {
    const store = makeStore();
    expect(() => store.listInbox("verdicta", "arch", undefined, limit)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("rejects a malformed inbox cursor", () => {
    const store = makeStore();
    expect(() => store.listInbox("verdicta", "arch", "not-a-cursor", 50)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("counts pending messages and UTF-8 bytes only before delivery", () => {
    const store = makeStore();
    const stored = createAt(
      store,
      crypto.randomUUID(),
      "2026-11-09T00:00:00.000Z",
      uniqueInput({ text: "🙂" }),
    );
    const submitted = createAt(
      store,
      crypto.randomUUID(),
      "2026-11-09T00:00:01.000Z",
      uniqueInput({ text: "abc" }),
    );
    const delivered = createAt(
      store,
      crypto.randomUUID(),
      "2026-11-09T00:00:02.000Z",
      uniqueInput({ text: "excluded" }),
    );
    createAt(store, crypto.randomUUID(), "2026-11-09T00:00:03.000Z", uniqueInput({ to: "tester" }));
    store.setDeliveryState(submitted.id, "submitted");
    store.setDeliveryState(delivered.id, "submitted");
    store.setDeliveryState(delivered.id, "delivered");

    expect(store.pendingUsage("verdicta", "arch")).toEqual({ count: 2, bytes: 7 });
    expect(store.getMessage(stored.id)?.deliveryState).toBe("stored");
  });

  it("restores messages and delivery state after reopening the same file", () => {
    const directory = temporaryDirectory("synloq-store-reopen-");
    const database = join(directory, "nested", "messages.sqlite");
    const firstStore = makeStore(database);
    const created = firstStore.create(
      validInput,
      crypto.randomUUID(),
      "2026-11-09T00:00:00.000Z",
      crypto.randomUUID(),
    ).message;
    firstStore.setDeliveryState(created.id, "submitted");
    firstStore.close();

    const reopened = makeStore(database);
    expect(reopened.getMessage(created.id)).toEqual({ ...created, deliveryState: "submitted" });
    expect(reopened.nextPending("verdicta", "arch")).toBeUndefined();
    expect(
      reopened.create(
        validInput,
        crypto.randomUUID(),
        "2026-11-09T00:00:01.000Z",
        crypto.randomUUID(),
      ),
    ).toEqual({ message: { ...created, deliveryState: "submitted" }, created: false });
  });

  it("fails closed on a corrupt SQLite file and preserves the cause", () => {
    const directory = temporaryDirectory("synloq-store-corrupt-");
    const database = join(directory, "messages.sqlite");
    writeFileSync(database, "this is not a SQLite database");

    let thrown: unknown;
    try {
      makeStore(database);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SynloqError);
    expect(thrown).toMatchObject({ code: "STORAGE_FAILURE" });
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(String((thrown as Error).cause)).toMatch(/not a database|malformed/i);
    expect(readFileSync(database, "utf8")).toBe("this is not a SQLite database");
    expect(() => makeStore(database)).toThrow(expect.objectContaining({ code: "STORAGE_FAILURE" }));
  });

  it("fails closed on an unwritable requested path without using memory", () => {
    const directory = temporaryDirectory("synloq-store-unwritable-");
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "unchanged");
    const database = join(blockingFile, "messages.sqlite");

    let thrown: unknown;
    try {
      makeStore(database);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SynloqError);
    expect(thrown).toMatchObject({ code: "STORAGE_FAILURE" });
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(readFileSync(blockingFile, "utf8")).toBe("unchanged");
  });

  it.each(["RETRYABLE", "DELIVERY_UNCERTAIN"] as const)(
    "restores acceptance allowance only when a %s failure permits it",
    (code) => {
      const directory = temporaryDirectory("synloq-acceptance-retry-");
      const database = join(directory, "messages.sqlite");
      const store = makeStore(database);
      const sessions = new SessionStore(database);
      const messageId = crypto.randomUUID();
      createAt(store, messageId, "2026-11-09T00:00:00.000Z");

      try {
        const session = sessions.register(
          {
            project: "verdicta",
            agentId: "arch",
            sessionId: "claude-visible-arch",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              activeDelivery: true,
              stateReporting: true,
              clientIdempotency: true,
            },
            acceptanceMessageId: messageId,
          },
          false,
        );
        sessions.heartbeat("verdicta", "arch", session.sessionId, "idle");
        const binding = { sessionId: session.sessionId, generation: session.generation };

        expect(store.claimNextDelivery("verdicta", "arch", binding)?.message.id).toBe(messageId);
        store.reportDeliveryFailure(messageId, "verdicta", "arch", binding, code, true);
        expect(store.getMessage(messageId)?.deliveryState).toBe("stored");

        const retry = store.claimNextDelivery("verdicta", "arch", binding);
        if (code === "RETRYABLE") {
          expect(retry?.message.id).toBe(messageId);
        } else {
          expect(retry).toBeNull();
        }
      } finally {
        sessions.close();
      }
    },
  );

  it("reports oldest stored, awaiting ack, and stored counts for status", () => {
    const store = makeStore();
    const storedOld = crypto.randomUUID();
    const storedNew = crypto.randomUUID();
    const deliveredId = crypto.randomUUID();
    const ackedId = crypto.randomUUID();
    createAt(store, storedOld, "2026-11-09T00:00:00.000Z");
    createAt(store, storedNew, "2026-11-09T00:05:00.000Z");
    createAt(store, deliveredId, "2026-11-09T00:01:00.000Z");
    store.setDeliveryState(deliveredId, "delivered");
    createAt(store, ackedId, "2026-11-09T00:02:00.000Z");
    store.setDeliveryState(ackedId, "delivered");
    store.acknowledge(ackedId, "verdicta", "arch");

    expect(store.oldestStoredAt("verdicta", "arch")).toBe("2026-11-09T00:00:00.000Z");
    expect(store.countStored("verdicta", "arch")).toBe(2);
    expect(store.awaitingAck("verdicta", "arch")).toEqual({
      count: 1,
      oldestAt: "2026-11-09T00:01:00.000Z",
    });
    // The acked message is not awaiting anything.
    expect(store.oldestStoredAt("verdicta", "cto")).toBeUndefined();
    expect(store.countStored("verdicta", "cto")).toBe(0);
    expect(store.awaitingAck("verdicta", "cto")).toEqual({ count: 0 });
  });

  it("counts only stale acked deliveries that still expect a reply", () => {
    const store = makeStore();
    const threshold = "2026-11-09T00:30:00.000Z";
    const answered = crypto.randomUUID();
    for (const [id, createdAt, expectsReply] of [
      [crypto.randomUUID(), "2026-11-09T00:00:00.000Z", true], // stale, unanswered → counted
      [crypto.randomUUID(), "2026-11-09T00:29:00.000Z", true], // stale, unanswered → counted
      [crypto.randomUUID(), "2026-11-09T00:31:00.000Z", true], // younger than threshold
      [answered, "2026-11-09T00:01:00.000Z", true], // answered below
      [crypto.randomUUID(), "2026-11-09T00:02:00.000Z", false], // no reply expected
    ] as const) {
      createAt(store, id, createdAt, uniqueInput({ expectsReply }));
      store.setDeliveryState(id, "delivered");
      store.acknowledge(id, "verdicta", "arch");
    }
    // A reply clears the answered parent.
    store.create(
      uniqueInput({ from: "arch", to: "cto", inReplyTo: answered }),
      crypto.randomUUID(),
      "2026-11-09T00:04:00.000Z",
      crypto.randomUUID(),
    );

    expect(store.unansweredAcked("verdicta", "arch", threshold)).toEqual({
      count: 2,
      oldestAt: "2026-11-09T00:00:00.000Z",
    });
    // Nothing counts for a fresh threshold.
    expect(store.unansweredAcked("verdicta", "arch", "2026-11-09T00:00:30.000Z")).toEqual({
      count: 1,
      oldestAt: "2026-11-09T00:00:00.000Z",
    });
  });
});
