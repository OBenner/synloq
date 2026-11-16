import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "synloq-quarantine-release-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fixture.sqlite");
  let now = Date.parse("2026-11-16T00:00:00Z");
  const clock = { now: () => now };
  const messages = new SQLiteMessageStore(path, clock);
  const sessions = new SessionStore(path, clock);
  const inspector = new DatabaseSync(path);
  cleanups.push(() => {
    inspector.close();
    sessions.close();
    messages.close();
  });
  function create(project = "fixture", to = "staff1") {
    now += 1;
    return messages.create(
      {
        project,
        from: "dev",
        to,
        text: "Synthetic quarantine fixture",
        expectsReply: true,
        idempotencyKey: crypto.randomUUID(),
      },
      crypto.randomUUID(),
      new Date(now).toISOString(),
      crypto.randomUUID(),
    ).message;
  }
  function register(acceptanceMessageId?: string) {
    const session = sessions.register(
      {
        project: "fixture",
        agentId: "staff1",
        sessionId: "visible-staff1",
        protocolVersion: 1,
        capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
        ...(acceptanceMessageId ? { acceptanceMessageId } : {}),
      },
      false,
    );
    sessions.heartbeat("fixture", "staff1", session.sessionId, "idle");
    return { sessionId: session.sessionId, generation: session.generation };
  }
  function quarantined(id: string) {
    return (
      inspector.prepare("SELECT message_id FROM delivery_quarantine WHERE message_id=?").get(id) !==
      undefined
    );
  }
  function row(id: string) {
    return inspector
      .prepare(
        "SELECT delivery_state, claim_session_id, claim_generation, acceptance_consumed_generation FROM messages WHERE id=?",
      )
      .get(id);
  }
  function consume() {
    const head = create();
    const binding = register(head.id);
    expect(messages.claimNextDelivery("fixture", "staff1", binding)?.message.id).toBe(head.id);
    messages.quarantineDelivery(head.id, "fixture", "staff1", new Date(now).toISOString());
    return { head, binding };
  }
  return {
    path,
    clock,
    messages,
    sessions,
    inspector,
    create,
    register,
    quarantined,
    row,
    consume,
    advance: () => {
      now += 15_001;
    },
  };
}

describe("quarantine release with consumed acceptance (#90)", () => {
  it.each(["explicit release", "reregistration"] as const)(
    "%s keeps consumed quarantine and lets later FIFO mail progress",
    (mode) => {
      const f = fixture();
      const { head, binding } = f.consume();
      const later = f.create();
      const before = f.row(head.id);
      expect(f.messages.nextPending("fixture", "staff1")?.id).toBe(later.id);
      if (mode === "explicit release")
        expect(f.messages.releaseQuarantinedDeliveries("fixture", "staff1")).toBe(0);
      else f.register();
      // This fails before the fix: DELETE removes quarantine but leaves submitted.
      expect(f.messages.nextPending("fixture", "staff1")?.id).toBe(later.id);
      expect(f.quarantined(head.id)).toBe(true);
      expect(f.row(head.id)).toEqual(before);
      f.advance();
      f.sessions.reapExpired(f.messages);
      expect(f.quarantined(head.id)).toBe(true);
      const resumed = f.register();
      expect(f.messages.claimNextDelivery("fixture", "staff1", resumed)?.message.id).toBe(later.id);
      expect(f.row(head.id)?.acceptance_consumed_generation).toBe(binding.generation);
      expect(f.messages.releaseQuarantinedDeliveries("fixture", "staff1")).toBe(0);
      expect(f.quarantined(head.id)).toBe(true);
    },
  );

  it.each(["explicit release", "reregistration"] as const)(
    "%s releases ordinary quarantine, cleans acked entries and respects project/recipient scope",
    (mode) => {
      const f = fixture();
      const { head } = f.consume();
      f.messages.acknowledge(head.id, "fixture", "staff1");
      const ordinary = f.create();
      const otherRole = f.create("fixture", "staff2");
      const otherProject = f.create("other", "staff1");
      for (const message of [ordinary, otherRole, otherProject])
        f.messages.quarantineDelivery(message.id, message.project, message.to, message.createdAt);
      if (mode === "explicit release")
        expect(f.messages.releaseQuarantinedDeliveries("fixture", "staff1")).toBe(1);
      else f.register();
      expect(f.row(ordinary.id)).toEqual({
        delivery_state: "stored",
        claim_session_id: null,
        claim_generation: null,
        acceptance_consumed_generation: null,
      });
      expect(f.quarantined(ordinary.id)).toBe(false);
      expect(f.quarantined(head.id)).toBe(false);
      expect(f.messages.getMessage(head.id, "fixture")?.deliveryState).toBe("acked");
      for (const message of [otherRole, otherProject]) {
        expect(f.quarantined(message.id)).toBe(true);
        expect(f.messages.getMessage(message.id, message.project)?.deliveryState).toBe("submitted");
      }
      expect(f.messages.releaseQuarantinedDeliveries("fixture", "staff1")).toBe(0);
    },
  );

  it("keeps consumed quarantine durable across database reopen and rejects reusing its allowance", () => {
    const f = fixture();
    const { head } = f.consume();
    const later = f.create();
    f.messages.releaseQuarantinedDeliveries("fixture", "staff1");
    f.messages.close();
    f.sessions.close();
    const reopenedMessages = new SQLiteMessageStore(f.path, f.clock);
    const reopenedSessions = new SessionStore(f.path, f.clock);
    try {
      reopenedSessions.register(
        {
          project: "fixture",
          agentId: "staff1",
          sessionId: "visible-staff1",
          protocolVersion: 1,
          capabilities: { activeDelivery: true, stateReporting: true, clientIdempotency: true },
          acceptanceMessageId: head.id,
        },
        false,
      );
      expect(f.quarantined(head.id)).toBe(true);
      expect(reopenedMessages.nextPending("fixture", "staff1")?.id).toBe(later.id);
      const session = reopenedSessions.list("fixture")[0]!;
      expect(session.capabilities.activeDelivery).toBe(false);
      expect(reopenedMessages.claimNextDelivery("fixture", "staff1", session)).toBeNull();
    } finally {
      reopenedSessions.close();
      reopenedMessages.close();
    }
  });
});
