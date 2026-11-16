import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { serveCommand } from "../../src/cli/commands.js";
import { projectPaths } from "../../src/config/paths.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { RETENTION_INTERVAL_MS } from "../../src/relay/retention.js";

it("loads retention from the manifest, sweeps at startup and periodically, and cleans up on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-serve-retention-"));
  const home = join(root, "home");
  await writeFile(
    join(root, "synloq.yaml"),
    "project: test\nretention:\n  days: 1\nagents:\n  dev:\n    title: Dev\n    role: Build\n",
  );
  const paths = await projectPaths(root, home);
  let now = Date.parse("2026-11-01T00:00:00Z");
  const clock = { now: () => now };
  const seed = new SQLiteMessageStore(paths.database, clock);
  const create = (store: SQLiteMessageStore, key: string) =>
    store.create(
      {
        project: "test",
        from: "dev",
        to: "dev",
        text: "body",
        expectsReply: false,
        idempotencyKey: key,
      },
      crypto.randomUUID(),
      "2026-11-01T00:00:00.000Z",
      "thread",
    ).message;
  const first = create(seed, "first");
  seed.acknowledge(first.id, "test", "dev");
  const unread = create(seed, "unread");
  seed.setDeliveryState(unread.id, "test", "delivered");
  seed.close();
  now += 2 * 86_400_000;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const handle = await serveCommand({ projectRoot: root, synloqHome: home, port: 0, clock });
  try {
    expect(handle.messages.getMessage(first.id, "test")).toBeUndefined();
    expect(handle.messages.getMessage(unread.id, "test")?.text).toBe("body");
    const second = create(handle.messages, "second");
    handle.messages.acknowledge(second.id, "test", "dev");
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
    expect(handle.messages.getMessage(second.id, "test")).toBeUndefined();
    await handle.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
  } finally {
    await handle.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
