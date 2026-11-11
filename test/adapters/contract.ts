import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inactiveReason, type Clock, type DeliveryAdapter } from "../../src/adapters/types.js";
import type { Message } from "../../src/domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type SessionRegistration,
  type SessionState,
} from "../../src/domain/session.js";
import type { Dispatcher } from "../../src/relay/dispatcher.js";
import type { SQLiteMessageStore } from "../../src/storage/message-store.js";
import type { SessionStore } from "../../src/storage/session-store.js";

export const CONTRACT_PROJECT = "verdicta";
export const CONTRACT_AGENT = "arch";
export const CONTRACT_SESSION = "session-arch";

export interface VisibleEntry {
  id: string;
  content: string;
}

export class MutableClock implements Clock {
  private current = Date.parse("2026-11-09T00:00:00.000Z");

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

export interface Harness {
  adapter: DeliveryAdapter;
  sessions: SessionStore;
  store: SQLiteMessageStore;
  clock: MutableClock;
  visible: VisibleEntry[];
  dispatcher: Dispatcher;
  setState(state: SessionState): void;
  failNext(messageId: string): void;
  close(): void;
}

export type AdapterHarnessFactory = (capabilities?: AdapterCapabilities) => Harness;

export function contractCapabilities(
  overrides: Partial<AdapterCapabilities> = {},
): AdapterCapabilities {
  return {
    activeDelivery: true,
    stateReporting: true,
    clientIdempotency: true,
    ...overrides,
  };
}

export function contractRegistration(
  sessionId = CONTRACT_SESSION,
  capabilities = contractCapabilities(),
): SessionRegistration {
  return {
    project: CONTRACT_PROJECT,
    agentId: CONTRACT_AGENT,
    sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
  };
}

export function createContractMessage(
  h: Harness,
  id: string,
  createdAt: string,
  text = `Payload for ${id}`,
): Message {
  return h.store.create(
    {
      project: CONTRACT_PROJECT,
      from: "cto",
      to: CONTRACT_AGENT,
      text,
      expectsReply: false,
      idempotencyKey: id,
    },
    id,
    createdAt,
    `thread-${id}`,
  ).message;
}

async function expectDelivered(h: Harness, message: Message): Promise<void> {
  await h.dispatcher.runOnce(message.project, message.to);
  expect(h.visible.map((entry) => entry.id)).toContain(message.id);
  expect(h.store.getMessage(message.id)?.deliveryState).toBe("delivered");
}

export function runAdapterContract(name: string, factory: AdapterHarnessFactory): void {
  describe(name, () => {
    let h: Harness;

    beforeEach(() => {
      h = factory();
      h.setState("idle");
    });

    afterEach(() => {
      h.close();
    });

    it("negotiates version 1 and rejects version 2", () => {
      expect(h.sessions.list(CONTRACT_PROJECT)).toHaveLength(1);
      expect(h.sessions.list(CONTRACT_PROJECT)[0]?.protocolVersion).toBe(1);

      expect(() =>
        h.sessions.register({ ...contractRegistration("session-other"), protocolVersion: 2 }, true),
      ).toThrow(expect.objectContaining({ code: "INCOMPATIBLE_PROTOCOL" }));
      expect(h.sessions.list(CONTRACT_PROJECT)[0]?.sessionId).toBe(CONTRACT_SESSION);
    });

    it("binds one visible session", () => {
      expect(() => h.sessions.register(contractRegistration("session-other"), false)).toThrow(
        expect.objectContaining({ code: "DUPLICATE_SESSION" }),
      );
      expect(h.sessions.list(CONTRACT_PROJECT)).toHaveLength(1);
      expect(h.sessions.list(CONTRACT_PROJECT)[0]?.sessionId).toBe(CONTRACT_SESSION);
    });

    it("delivers to fresh idle", async () => {
      const message = createContractMessage(h, "message-idle", "2026-11-09T00:00:00.000Z");

      await expectDelivered(h, message);

      expect(h.visible).toHaveLength(1);
      expect(h.visible[0]?.id).toBe(message.id);
      expect(h.visible[0]?.content).toContain(message.text);
    });

    it("holds while busy", async () => {
      const message = createContractMessage(h, "message-busy", "2026-11-09T00:00:00.000Z");
      const submit = vi.spyOn(h.adapter, "submit");
      h.setState("busy");

      await h.dispatcher.runOnce(CONTRACT_PROJECT, CONTRACT_AGENT);

      expect(submit).not.toHaveBeenCalled();
      expect(h.store.getMessage(message.id)?.deliveryState).toBe("stored");
      expect(h.visible).toEqual([]);
    });

    it("never steers a running response", async () => {
      createContractMessage(h, "message-running", "2026-11-09T00:00:00.000Z");
      const submit = vi.spyOn(h.adapter, "submit");
      h.setState("busy");

      await h.dispatcher.kick(CONTRACT_PROJECT, CONTRACT_AGENT);
      await h.dispatcher.kick(CONTRACT_PROJECT, CONTRACT_AGENT);

      expect(submit).not.toHaveBeenCalled();
      expect(h.visible).toEqual([]);
    });

    it("drains after reconnect", async () => {
      const first = createContractMessage(h, "message-first", "2026-11-09T00:00:00.000Z");
      const second = createContractMessage(h, "message-second", "2026-11-09T00:00:01.000Z");
      h.setState("closed");
      await h.dispatcher.kick(CONTRACT_PROJECT, CONTRACT_AGENT);
      expect(h.visible).toEqual([]);

      h.sessions.register(contractRegistration(), false);
      h.setState("idle");
      await h.dispatcher.kick(CONTRACT_PROJECT, CONTRACT_AGENT);

      expect(h.visible.map((entry) => entry.id)).toEqual([first.id, second.id]);
      expect(h.store.getMessage(first.id)?.deliveryState).toBe("delivered");
      expect(h.store.getMessage(second.id)?.deliveryState).toBe("delivered");
    });

    it("preserves provenance", async () => {
      const message = createContractMessage(
        h,
        "message-provenance",
        "2026-11-09T00:00:00.000Z",
        "Review the provenance envelope",
      );

      await expectDelivered(h, message);

      expect(h.visible[0]?.content).toBe(
        `<synloq project="${message.project}" from="${message.from}" message="${message.id}" thread="${message.threadId}">\n${message.text}\n</synloq>`,
      );
    });

    it("deduplicates retry", async () => {
      const message = createContractMessage(h, "message-retry", "2026-11-09T00:00:00.000Z");

      const first = await h.adapter.submit(CONTRACT_SESSION, message);
      h.failNext(message.id);
      h.setState("busy");
      const retry = await h.adapter.submit(CONTRACT_SESSION, message);

      expect(retry).toBe(first);
      expect(retry).toEqual({
        state: "delivered",
        clientMessageId: message.id,
      });
      expect(h.visible.map((entry) => entry.id)).toEqual([message.id]);
    });

    it("blocks later FIFO after failure", async () => {
      const first = createContractMessage(h, "message-fails", "2026-11-09T00:00:00.000Z");
      const second = createContractMessage(h, "message-waits", "2026-11-09T00:00:01.000Z");
      const submit = vi.spyOn(h.adapter, "submit");
      h.failNext(first.id);

      await h.dispatcher.runOnce(CONTRACT_PROJECT, CONTRACT_AGENT);
      await h.dispatcher.runOnce(CONTRACT_PROJECT, CONTRACT_AGENT);

      expect(h.store.getMessage(first.id)?.deliveryState).toBe("stored");
      expect(h.store.getMessage(second.id)?.deliveryState).toBe("stored");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith(CONTRACT_SESSION, first, {
        generation: 1,
      });
      expect(h.visible).toEqual([]);
    });

    it("stops on heartbeat expiry", async () => {
      const message = createContractMessage(h, "message-expiry", "2026-11-09T00:00:00.000Z");
      const submit = vi.spyOn(h.adapter, "submit");
      h.clock.advance(15_001);

      expect(h.sessions.effectiveState(CONTRACT_PROJECT, CONTRACT_AGENT)).toBe("unknown");
      await h.dispatcher.runOnce(CONTRACT_PROJECT, CONTRACT_AGENT);

      expect(submit).not.toHaveBeenCalled();
      expect(h.store.getMessage(message.id)?.deliveryState).toBe("stored");
      expect(h.visible).toEqual([]);
    });

    it("reports unsupported capabilities", async () => {
      h.close();
      h = factory(contractCapabilities({ activeDelivery: false }));
      const message = createContractMessage(h, "message-unsupported", "2026-11-09T00:00:00.000Z");
      const submit = vi.spyOn(h.adapter, "submit");

      await h.dispatcher.kick(CONTRACT_PROJECT, CONTRACT_AGENT);

      const session = h.sessions.list(CONTRACT_PROJECT)[0];
      expect(inactiveReason(session)).toBe("active-delivery-unsupported");
      expect(submit).not.toHaveBeenCalled();
      expect(h.store.getMessage(message.id)?.deliveryState).toBe("stored");
      expect(h.visible).toEqual([]);
    });
  });
}
