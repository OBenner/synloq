import { afterEach, expect, it, vi } from "vitest";
import { startRetentionSweep, RETENTION_INTERVAL_MS } from "../../src/relay/retention.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SynloqError } from "../../src/domain/errors.js";

afterEach(() => vi.useRealTimers());

it("survives a failed sweep, reports only its code, retries and stops before storage close", () => {
  vi.useFakeTimers();
  const store = new SQLiteMessageStore(":memory:");
  const spy = vi.spyOn(store, "sweepRetention");
  spy.mockImplementationOnce(() => {
    throw new SynloqError("STORAGE_FAILURE", "private SQL content");
  });
  const diagnostic = vi.fn();
  const stop = startRetentionSweep(store, "test", 7, diagnostic);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).toContain("STORAGE_FAILURE");
  expect(diagnostic.mock.calls[0]![0]).not.toContain("private SQL content");
  vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
  expect(spy).toHaveBeenCalledTimes(2);
  stop();
  stop();
  store.close();
  vi.advanceTimersByTime(2 * RETENTION_INTERVAL_MS);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
