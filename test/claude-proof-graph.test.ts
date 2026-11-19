import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  checkpointTranscript,
  transcriptDelta,
  verifyClaudeTurn,
} from "../src/host/claude/proof.js";

const session = "00000000-0000-4000-8000-000000000001";
const target = "00000000-0000-4000-8000-000000000002";
const marker = "NUDGE-ACK-00000000-0000-4000-8000-000000000003";
type Row = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  subtype?: string;
  message?: { role: string; content: unknown };
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const node = (type: string, uuid: string, parentUuid: string, content?: unknown): Row => ({
  type,
  uuid,
  parentUuid,
  sessionId: session,
  ...(content === undefined ? {} : { message: { role: type, content } }),
});
function fixture() {
  // Structural reproduction of REINIT-20261117: the checkpoint assistant
  // ac4bdbfd is followed by stop_hook_summary 73b2c72c; seven new attachment
  // nodes include side branches. No private transcript/message bodies copied.
  const before = [
    node("assistant", "ac4bdbfd", "older", [{ type: "text", text: "READY" }]),
    node("attachment", "old-attachment", "ac4bdbfd"),
    { ...node("system", "73b2c72c", "old-attachment"), subtype: "stop_hook_summary" },
    { type: "cost-state" },
  ];
  const rows = [
    node("user", "u0", "73b2c72c", "synthetic nudge"),
    node("attachment", "a1", "u0"),
    node("attachment", "a2", "a1"),
    node("attachment", "a3", "a2"),
    node("assistant", "inbox", "a3", [
      { type: "tool_use", id: "i", name: "mcp__synloq-arch__synloq_inbox", input: {} },
    ]),
    node("attachment", "a4", "inbox"),
    node("user", "inbox-result", "inbox", [
      {
        type: "tool_result",
        tool_use_id: "i",
        content: JSON.stringify({ messages: [{ id: target, deliveryState: "stored" }] }),
      },
    ]),
    node("attachment", "a5", "inbox-result"),
    node("assistant", "ack", "a5", [
      {
        type: "tool_use",
        id: "a",
        name: "mcp__synloq-arch__synloq_ack",
        input: { messageId: target },
      },
    ]),
    node("attachment", "a6", "ack"),
    node("user", "ack-result", "ack", [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: JSON.stringify({ message: { id: target, deliveryState: "acked" } }),
      },
    ]),
    node("assistant", "marker", "ack-result", [{ type: "text", text: marker }]),
    node("attachment", "a7", "marker"),
    { ...node("system", "end", "a7"), subtype: "stop_hook_summary" },
    {
      type: "api-request-blob",
      message: { role: "assistant", content: [{ type: "tool_use", id: "i" }] },
    },
  ];
  return { before, rows };
}
async function check(change?: (data: ReturnType<typeof fixture>) => void, acknowledged = true) {
  const data = fixture();
  change?.(data);
  const dir = await mkdtemp(join(tmpdir(), "synloq-proof-graph-"));
  dirs.push(dir);
  const path = join(dir, session + ".jsonl");
  await writeFile(path, jsonl(data.before));
  const checkpoint = await checkpointTranscript(path, session);
  await appendFile(path, jsonl(data.rows));
  return verifyClaudeTurn({
    ...checkpoint,
    delta: await transcriptDelta(path, checkpoint),
    sessionId: session,
    agentId: "arch",
    targetId: target,
    marker,
    acknowledged: () => acknowledged,
  });
}
it("accepts a resumed turn after stop_hook_summary with seven attachment nodes (#138)", async () => {
  expect(await check()).toBe(true);
});

const duration = (uuid: string, parentUuid: string): Row => ({
  ...node("system", uuid, parentUuid),
  subtype: "turn_duration",
});

function withTurnDuration({ before, rows }: ReturnType<typeof fixture>) {
  // #158, structural reproduction of the pinned Claude Code 2.1.326
  // transcript: a duration node links the stop summary to the next prompt.
  before.splice(3, 0, duration("previous-duration", "73b2c72c"));
  rows[0]!.parentUuid = "previous-duration";
  rows.push(duration("current-duration", "end"));
}

it("accepts turn_duration at the checkpoint and after the resumed turn", async () => {
  expect(await check(withTurnDuration)).toBe(true);
});

it.each([
  [{ parentUuid: "missing" }, "unresolved transcript parent"],
  [{ sessionId: "other-session" }, "invalid transcript parent link"],
] as const)("rejects checkpoint turn_duration with invalid ancestry %j", async (change, error) => {
  await expect(
    check((data) => {
      withTurnDuration(data);
      Object.assign(
        data.before.find((row) => row.uuid === "previous-duration")!,
        change,
      );
    }),
  ).rejects.toThrow(error);
});

it("rejects a conversational fork through a turn_duration node", async () => {
  expect(
    await check((data) => {
      withTurnDuration(data);
      const ack = data.rows.find((row) => row.uuid === "ack")!;
      data.rows.splice(data.rows.indexOf(ack), 0, duration("fork-duration", "u0"));
      ack.parentUuid = "fork-duration";
    }),
  ).toBe(false);
});

it("does not use turn_duration content as marker evidence", async () => {
  expect(
    await check((data) => {
      withTurnDuration(data);
      const markerRow = data.rows.find((row) => row.uuid === "marker")!;
      markerRow.type = "system";
      markerRow.subtype = "turn_duration";
    }),
  ).toBe(false);
});

it("still requires the independent SQLite acknowledgement", async () => {
  expect(await check(undefined, false)).toBe(false);
});
it.each([
  "missing",
  "foreign-session",
  "cycle",
  "conversation-fork",
  "unknown-service",
  "duplicate-uuid",
])("rejects %s parent provenance", async (kind) => {
  expect(
    await check(({ rows }) => {
      const bridge = rows.find((r) => r.uuid === "a3")!;
      if (kind === "missing") bridge.parentUuid = "missing";
      if (kind === "foreign-session") bridge.sessionId = "foreign";
      if (kind === "cycle") bridge.parentUuid = "a3";
      if (kind === "conversation-fork") rows.find((r) => r.uuid === "ack")!.parentUuid = "u0";
      if (kind === "unknown-service") bridge.type = "unrecognized-graph-node";
      if (kind === "duplicate-uuid") rows.splice(4, 0, { ...bridge, parentUuid: "u0" });
    }),
  ).toBe(false);
});
it("does not count a marker or tool results hidden in attachment content", async () => {
  expect(
    await check(({ rows }) => {
      rows.find((r) => r.uuid === "marker")!.type = "attachment";
    }),
  ).toBe(false);
});
it("rejects a wrong-session conversation even when its service ancestry is valid", async () => {
  expect(
    await check(({ rows }) => {
      rows.find((r) => r.uuid === "ack-result")!.sessionId = "foreign";
    }),
  ).toBe(false);
});

it("rejects unconfirmed system subtypes carrying graph links", async () => {
  expect(
    await check(({ rows }) => {
      const r = rows.find((r) => r.uuid === "a3")!;
      r.type = "system";
      r.subtype = "unknown";
    }),
  ).toBe(false);
});
it.each([64, 65])("bounds an attachment chain at 64 nodes (length %i)", async (length) => {
  expect(
    await check(({ rows }) => {
      rows.splice(
        1,
        3,
        ...Array.from({ length }, (_, i) =>
          node("attachment", `chain-${i}`, i ? `chain-${i - 1}` : "u0"),
        ),
      );
      rows.find((r) => r.uuid === "inbox")!.parentUuid = `chain-${length - 1}`;
    }),
  ).toBe(length === 64);
});
it("bounds total service nodes even for shallow side branches", async () => {
  expect(
    await check(({ rows }) => {
      rows.splice(
        1,
        0,
        ...Array.from({ length: 1025 }, (_, i) => node("attachment", `wide-${i}`, "u0")),
      );
    }),
  ).toBe(false);
});
it("rejects a forged checkpoint tail rather than accepting its last arbitrary UUID", async () => {
  await expect(
    check(({ before }) => {
      before.find((r) => r.uuid === "73b2c72c")!.parentUuid = "missing";
    }),
  ).rejects.toThrow("unresolved");
});
