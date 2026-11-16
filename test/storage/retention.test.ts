import { afterEach, expect, it } from "vitest";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import type { SendMessageInput } from "../../src/domain/message.js";

const day = 86_400_000;
const stores: SQLiteMessageStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  let now = Date.parse("2026-11-01T00:00:00Z");
  const clock = { now: () => now };
  const store = new SQLiteMessageStore(":memory:", clock);
  stores.push(store);
  const input: SendMessageInput = {
    project: "test",
    from: "dev",
    to: "staff",
    text: "private body",
    expectsReply: false,
    idempotencyKey: "key",
  };
  const create = (key: string) =>
    store.create(
      { ...input, idempotencyKey: key },
      crypto.randomUUID(),
      new Date(now).toISOString(),
      crypto.randomUUID(),
    ).message;
  return {
    store,
    input,
    create,
    advance: (ms: number) => {
      now += ms;
    },
    clock,
  };
}

it("purges only old acked messages in the selected project, with bounded batches", () => {
  const { store, create, advance } = fixture();
  const stored = create("stored");
  const submitted = create("submitted");
  store.setDeliveryState(submitted.id, "test", "submitted");
  const delivered = create("delivered");
  store.setDeliveryState(delivered.id, "test", "delivered");
  const quarantined = create("quarantined");
  store.quarantineDelivery(quarantined.id, "test", "staff", quarantined.createdAt);
  store.acknowledge(quarantined.id, "test", "staff");
  const acked = [create("a"), create("b")];
  for (const message of acked) store.acknowledge(message.id, "test", "staff");
  advance(8 * day);
  const recent = create("recent");
  store.acknowledge(recent.id, "test", "staff");
  expect(store.sweepRetention("foreign", 7, 1).messagesPurged).toBe(0);
  expect(store.sweepRetention("test", 7, 1).messagesPurged).toBe(1);
  expect(store.sweepRetention("test", 7, 1).messagesPurged).toBe(1);
  expect(store.sweepRetention("test", 7, 1).messagesPurged).toBe(0);
  for (const message of [stored, submitted, delivered, recent, quarantined])
    expect(store.getMessage(message.id, "test")).toBeDefined();
});

it("keeps keys scoped to sender and project and rejects a new missing parent without reserving its key", () => {
  const { store, input, clock } = fixture();
  const create = (overrides: Partial<SendMessageInput>) =>
    store.create(
      { ...input, ...overrides },
      crypto.randomUUID(),
      new Date(clock.now()).toISOString(),
      "thread",
    );
  expect(create({}).created).toBe(true);
  expect(create({ from: "other" }).created).toBe(true);
  expect(create({ project: "other" }).created).toBe(true);
  expect(() => create({ idempotencyKey: "new", inReplyTo: "missing" })).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(create({ idempotencyKey: "new" }).created).toBe(true);
});

it("retains dedup for the full seven days after body purge and never extends the window on retry", () => {
  const { store, input, create, advance, clock } = fixture();
  const first = create("key");
  const acked = store.acknowledge(first.id, "test", "staff");
  advance(2 * day);
  expect(store.sweepRetention("test", 1).messagesPurged).toBe(1);
  expect(store.getMessage(first.id, "test")).toBeUndefined();
  const retry = () =>
    store.create(
      input,
      crypto.randomUUID(),
      new Date(clock.now()).toISOString(),
      crypto.randomUUID(),
    );
  expect(retry()).toEqual({ message: acked, created: false });
  expect(() =>
    store.create(
      { ...input, text: "changed" },
      "other",
      new Date(clock.now()).toISOString(),
      "thread",
    ),
  ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  advance(5 * day);
  expect(retry().created).toBe(false);
  advance(1);
  expect(retry().created).toBe(true);
  expect(store.listInbox("test", "staff", undefined, 100).messages).toHaveLength(1);
});

it("expires dedup even when a longer retention keeps the original body", () => {
  const { store, input, create, advance, clock } = fixture();
  const first = create("key");
  advance(7 * day + 1);
  const second = store.create(
    input,
    crypto.randomUUID(),
    new Date(clock.now()).toISOString(),
    "new-thread",
  );
  expect(second.created).toBe(true);
  expect(second.message.id).not.toBe(first.id);
  expect(store.getMessage(first.id, "test")).toBeDefined();
});
