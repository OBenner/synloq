import { afterEach, describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Participant, SendMessageInput } from "../../src/domain/message.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService, type ReplyRequest } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  {
    project: "verdicta",
    agentId: "cto",
    title: "CTO",
    role: "Technical strategy and architecture",
  },
  {
    project: "verdicta",
    agentId: "arch",
    title: "Architect",
    role: "ADRs and architectural review",
  },
  {
    project: "verdicta",
    agentId: "tester",
    title: "Tester",
    role: "Independent verification",
  },
  {
    project: "another-project",
    agentId: "arch",
    title: "Other Architect",
    role: "A participant in another project",
  },
];

const validInput: SendMessageInput = {
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the storage boundary",
  expectsReply: true,
  idempotencyKey: "cto-0001",
};

const messageStores: SQLiteMessageStore[] = [];
const sessionStores: SessionStore[] = [];

async function makeRelay() {
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  messageStores.push(messages);
  sessionStores.push(sessions);
  const protection = new ProtectionPolicy(messages);
  const relay = new RelayService(participants, messages, sessions, protection);

  return {
    relay,
    messages,
    sessions,
    cto: { project: "verdicta", agentId: "cto", operator: false } satisfies Identity,
    arch: { project: "verdicta", agentId: "arch", operator: false } satisfies Identity,
    tester: { project: "verdicta", agentId: "tester", operator: false } satisfies Identity,
    operator: { project: "verdicta", agentId: "operator", operator: true } satisfies Identity,
    otherProjectArch: {
      project: "another-project",
      agentId: "arch",
      operator: false,
    } satisfies Identity,
    otherProjectOperator: {
      project: "another-project",
      agentId: "operator",
      operator: true,
    } satisfies Identity,
  };
}

afterEach(() => {
  for (const store of messageStores.splice(0)) store.close();
  for (const store of sessionStores.splice(0)) store.close();
});

describe("RelayService", () => {
  it("lists only manifest participants from the authenticated project", async () => {
    const { relay, cto, otherProjectArch } = await makeRelay();

    await expect(relay.listParticipants(cto)).resolves.toEqual(participants.slice(0, 3));
    await expect(relay.listParticipants(otherProjectArch)).resolves.toEqual([participants[3]]);
  });

  it("derives the sender and project from the authenticated connection", async () => {
    const { relay, messages, cto } = await makeRelay();
    const forged: SendMessageInput = {
      ...validInput,
      project: "another-project",
      from: "tester",
    };

    const message = await relay.send(cto, forged);

    expect(message).toMatchObject({ project: "verdicta", from: "cto", to: "arch" });
    expect(messages.getMessage(message.id)).toEqual(message);
    expect(messages.listInbox("another-project", "arch", undefined, 50).messages).toEqual([]);
  });

  it("derives the operator sender without requiring a manifest role", async () => {
    const { relay, operator } = await makeRelay();

    const message = await relay.send(operator, {
      ...validInput,
      idempotencyKey: "operator-0001",
    });

    expect(message).toMatchObject({ project: "verdicta", from: "operator", to: "arch" });
  });

  it("rejects an unknown recipient before storing a message", async () => {
    const { relay, messages, cto } = await makeRelay();

    await expect(
      relay.send(cto, { ...validInput, to: "missing", idempotencyKey: "unknown-recipient" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(messages.listInbox("verdicta", "arch", undefined, 50).messages).toEqual([]);
  });

  it("returns the original stored message for an idempotent retry", async () => {
    const { relay, messages, cto } = await makeRelay();

    const first = await relay.send(cto, validInput);
    const retry = await relay.send(cto, validInput);

    expect(retry).toEqual(first);
    expect(messages.listInbox("verdicta", "arch", undefined, 50).messages).toEqual([first]);
    await expect(
      relay.send(cto, { ...validInput, text: "Different content" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("replies only to the original sender in the same thread", async () => {
    const { relay, cto, arch } = await makeRelay();
    const question = await relay.send(cto, validInput);
    const request: ReplyRequest = {
      inReplyTo: question.id,
      text: "Use one SQLite writer",
      expectsReply: false,
      idempotencyKey: "arch-answer-1",
    };

    const answer = await relay.reply(arch, request);

    expect(answer).toMatchObject({
      project: "verdicta",
      from: "arch",
      to: "cto",
      inReplyTo: question.id,
      threadId: question.threadId,
    });
  });

  it("preserves one thread through a multi-message exchange", async () => {
    const { relay, cto, arch } = await makeRelay();
    const question = await relay.send(cto, validInput);
    const answer = await relay.reply(arch, {
      inReplyTo: question.id,
      text: "Use one SQLite writer",
      expectsReply: true,
      idempotencyKey: "arch-answer-1",
    });

    const followUp = await relay.reply(cto, {
      inReplyTo: answer.id,
      text: "Please document the transaction boundary",
      expectsReply: false,
      idempotencyKey: "cto-follow-up-1",
    });

    expect(followUp).toMatchObject({
      to: "arch",
      inReplyTo: answer.id,
      threadId: question.threadId,
    });
    expect(new Set([question.threadId, answer.threadId, followUp.threadId]).size).toBe(1);
  });

  it("uses the authorized parent thread for send with inReplyTo", async () => {
    const { relay, cto, arch } = await makeRelay();
    const question = await relay.send(cto, validInput);

    const answer = await relay.send(arch, {
      ...validInput,
      to: "cto",
      text: "Use one SQLite writer",
      expectsReply: false,
      inReplyTo: question.id,
      idempotencyKey: "arch-send-answer-1",
    });

    expect(answer.threadId).toBe(question.threadId);
    expect(answer.inReplyTo).toBe(question.id);
  });

  it("prevents a third participant from replying to a message not addressed to it", async () => {
    const { relay, messages, cto, tester } = await makeRelay();
    const question = await relay.send(cto, validInput);

    await expect(
      relay.reply(tester, {
        inReplyTo: question.id,
        text: "Unsolicited answer",
        expectsReply: false,
        idempotencyKey: "tester-answer-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messages.listInbox("verdicta", "cto", undefined, 50).messages).toEqual([]);
  });

  it("prevents send with inReplyTo from using another recipient's parent", async () => {
    const { relay, messages, cto, tester } = await makeRelay();
    const question = await relay.send(cto, validInput);

    await expect(
      relay.send(tester, {
        ...validInput,
        to: "cto",
        inReplyTo: question.id,
        idempotencyKey: "tester-send-answer-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messages.listInbox("verdicta", "cto", undefined, 50).messages).toEqual([]);
  });

  it("prevents a same-named participant in another project from replying", async () => {
    const { relay, messages, cto, otherProjectArch } = await makeRelay();
    const question = await relay.send(cto, validInput);

    await expect(
      relay.reply(otherProjectArch, {
        inReplyTo: question.id,
        text: "Cross-project answer",
        expectsReply: false,
        idempotencyKey: "other-arch-answer-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messages.listInbox("verdicta", "cto", undefined, 50).messages).toEqual([]);
  });

  it("returns only the authenticated participant's inbox", async () => {
    const { relay, cto, arch } = await makeRelay();
    const message = await relay.send(cto, validInput);

    await expect(
      relay.inbox(arch, { project: "verdicta", agentId: "arch", limit: 50 }),
    ).resolves.toEqual({ messages: [message], nextCursor: undefined });
  });

  it("prevents reading another participant's inbox", async () => {
    const { relay, tester } = await makeRelay();

    await expect(
      relay.inbox(tester, { project: "verdicta", agentId: "arch", limit: 50 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("prevents participant and operator inbox access across projects", async () => {
    const { relay, cto, operator, otherProjectOperator } = await makeRelay();

    await expect(
      relay.inbox(cto, { project: "another-project", agentId: "cto", limit: 50 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      relay.inbox(operator, { project: "another-project", agentId: "arch", limit: 50 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      relay.inbox(otherProjectOperator, {
        project: "verdicta",
        agentId: "arch",
        limit: 50,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows an operator to inspect any participant inbox in its project", async () => {
    const { relay, cto, operator } = await makeRelay();
    const message = await relay.send(cto, validInput);

    await expect(
      relay.inbox(operator, { project: "verdicta", agentId: "arch", limit: 50 }),
    ).resolves.toEqual({ messages: [message], nextCursor: undefined });
    await expect(
      relay.inbox(operator, { project: "verdicta", agentId: "cto", limit: 50 }),
    ).resolves.toEqual({ messages: [], nextCursor: undefined });
  });

  it("allows message reads only by its sender, recipient, or project operator", async () => {
    const { relay, cto, arch, tester, operator, otherProjectOperator } = await makeRelay();
    const message = await relay.send(cto, validInput);

    await expect(relay.getMessage(cto, message.id)).resolves.toEqual(message);
    await expect(relay.getMessage(arch, message.id)).resolves.toEqual(message);
    await expect(relay.getMessage(operator, message.id)).resolves.toEqual(message);
    await expect(relay.getMessage(tester, message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(relay.getMessage(otherProjectOperator, message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(relay.getMessage(operator, crypto.randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("acknowledges only as the recipient and returns acked without another outcome", async () => {
    const { relay, messages, cto, arch } = await makeRelay();
    const message = await relay.send(cto, validInput);
    messages.setDeliveryState(message.id, "submitted");
    messages.setDeliveryState(message.id, "delivered");

    const acknowledged = await relay.acknowledge(arch, message.id);

    expect(acknowledged).toEqual({ ...message, deliveryState: "acked" });
    await expect(relay.acknowledge(arch, message.id)).resolves.toEqual(acknowledged);
  });

  it("does not let a sender, third participant, or operator acknowledge", async () => {
    const { relay, messages, cto, tester, operator } = await makeRelay();
    const message = await relay.send(cto, validInput);
    messages.setDeliveryState(message.id, "submitted");
    messages.setDeliveryState(message.id, "delivered");

    for (const identity of [cto, tester, operator]) {
      await expect(relay.acknowledge(identity, message.id)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    expect(messages.getMessage(message.id)?.deliveryState).toBe("delivered");
    await expect(relay.acknowledge(cto, crypto.randomUUID())).rejects.toBeInstanceOf(SynloqError);
  });
});
