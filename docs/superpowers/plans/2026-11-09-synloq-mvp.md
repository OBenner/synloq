# Synloq MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Synloq relay that lets existing visible role-based chats exchange durable direct messages through MCP, with explicitly verified active-delivery adapters.

**Architecture:** One Node.js relay process owns all writes to one per-project SQLite database and exposes a loopback HTTP control API. A thin stdio MCP process per chat exposes the six Synloq tools, while delivery adapters prove session state and active-delivery capabilities independently. Claude Code and OpenCode are enabled only after their real-client checks pass; Kimi Code starts with the honest MCP inbox fallback.

**Tech Stack:** Node.js >= 24, pnpm 12.18.0, TypeScript 7.0.2, `@modelcontextprotocol/sdk` 1.32.2, `@opencode-ai/sdk` 1.19.5, Zod 4.6.7, YAML 2.9.1, built-in `node:sqlite`, Vitest 5.1.0, Prettier 3.9.10.

## Global Constraints

- Local communication between existing visible role-based agent chats; no hidden replacement chats or one-shot model subprocesses.
- No task statuses, dependencies, deadlines, automatic assignment, escalation, workflow orchestration, dashboard, group channels, attachments, remote delivery, automatic merge, or push in the first version.
- Direct message text is plain text limited to **32 KiB** per message.
- Delivery policy is **always queue; never steer**. Active injection is allowed only for a freshly observed `idle` session.
- Recipient states are exactly `idle`, `busy`, `closed`, and `unknown`; stale or missing state means `unknown`.
- Delivery states are exactly `stored → submitted → delivered → acked`; acknowledgement means reading, not agreement or completion.
- Runtime messages, queues, receipts, cursors, and credentials live outside Git; SQLite is fail-closed and the relay is the single writer.
- Adapter protocol version is `1`; capabilities are detected at runtime and never inferred from a client name or version.
- One distinct visible session may bind to one `(project, agentId)`; replacement is operator-only.
- Agent-facing MCP exposes only `synloq_list`, `synloq_send`, `synloq_reply`, `synloq_inbox`, `synloq_wait`, and `synloq_ack`; registration, credentials, limits, and pause/resume are operator-only.
- Logs contain message and participant IDs, not message bodies or credentials by default.
- Do not copy code, prompts, schemas, or UI from third-party projects. External documentation is used only to verify protocol behavior.
- Run every real-client claim through its own acceptance test. A reference or mock success is not evidence that a real client works.
- Execute on a feature branch. Commit only after the operator chooses execution; never push without separate explicit approval.

## Execution Gates

- **Gate A, Tasks 1–7:** durable core, protections, session registry, dispatcher, and deterministic reference adapter pass all contract tests.
- **Gate B, Tasks 8–10:** loopback control API, six MCP tools, and operator CLI work together against the same relay process.
- **Gate C, Tasks 11–12:** Claude Code and OpenCode pass mock contract tests, and their real-client acceptance procedures are documented. Unsupported behavior remains disabled.
- **Gate D, Tasks 13–14:** Kimi fallback is documented, real-client evidence is recorded separately from mock results, and the complete automated acceptance suite passes from a clean checkout.

## File Structure

- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`: one-package build and verification contract.
- `src/domain/message.ts`, `src/domain/session.ts`, `src/domain/errors.ts`: versioned domain types, limits, errors, and state vocabulary.
- `src/config/manifest.ts`, `src/config/paths.ts`, `src/config/credentials.ts`: repository manifest, external runtime paths, and hashed credentials.
- `src/storage/sqlite.ts`: SQLite opening, migrations, transactions, and corruption handling.
- `src/storage/message-store.ts`: atomic message creation, idempotency, inbox, receipts, queue limits, and pause gates.
- `src/storage/session-store.ts`: unique visible-session bindings, heartbeats, leases, and stale-state handling.
- `src/relay/relay-service.ts`: authenticated participant operations and thread rules.
- `src/relay/protection.ts`: synchronous rate, burst, queue, and cyclic-thread checks.
- `src/relay/dispatcher.ts`: single-flight FIFO dispatch, backoff, and reconnect recovery.
- `src/adapters/types.ts`: adapter and clock interfaces shared by core and tests.
- `src/adapters/reference.ts`: deterministic fake visible client.
- `src/adapters/claude-channel.ts`, `src/adapters/claude-state.ts`: Claude channel injection and hook-driven state reporting.
- `src/adapters/opencode.ts`: OpenCode events, queued prompt admission, and receipts.
- `src/adapters/kimi-fallback.ts`: Kimi capability report with active delivery disabled.
- `src/transport/http-server.ts`, `src/transport/http-client.ts`: authenticated loopback control API and long polling.
- `src/mcp/tools.ts`, `src/mcp/stdio.ts`: the six agent tools and stdio MCP entry point.
- `src/cli/main.ts`, `src/cli/commands.ts`, `src/cli/doctor.ts`: operator-only commands and diagnostics.
- `test/domain/*`, `test/config/*`, `test/storage/*`, `test/relay/*`: deterministic unit and persistence tests.
- `test/adapters/contract.ts`: reusable eleven-scenario adapter contract suite.
- `test/transport/*`, `test/mcp/*`, `test/cli/*`: API and tool boundary tests.
- `test/e2e/reference.e2e.test.ts`, `test/e2e/real-clients.md`: automated reference acceptance and reproducible real-client evidence procedure.
- `README.md`, `docs/client-compatibility.md`: operator setup and per-client verified support matrix.

---

### Task 1: Package Scaffold and Domain Vocabulary

**Files:**

- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/domain/message.ts`, `src/domain/session.ts`, `src/domain/errors.ts`
- Test: `test/domain/message.test.ts`

**Interfaces:**

- Consumes: nothing outside the new package.
- Produces: `Message`, `SendMessageInput`, `Participant`, `SessionState`, `DeliveryState`, `AdapterCapabilities`, `SessionRegistration`, `PROTOCOL_VERSION`, `MAX_TEXT_BYTES`, and `SynloqError` for every later task.

- [ ] **Step 1: Create the package and a failing domain test**

Create `package.json` with the exact dependency and script contract:

```json
{
  "name": "synloq",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.18.0",
  "engines": { "node": ">=24" },
  "bin": { "synloq": "dist/cli/main.js" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "format:check": "prettier --check .",
    "verify": "pnpm format:check && pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.2",
    "@opencode-ai/sdk": "1.19.5",
    "yaml": "2.9.1",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "^24.10.0",
    "prettier": "3.9.10",
    "typescript": "7.0.2",
    "vitest": "5.1.0"
  }
}
```

Use `module` and `moduleResolution` `NodeNext`, `target` `ES2024`, `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` in both TypeScript configs. The build config uses `rootDir: src`, `outDir: dist`, declarations, and excludes `test`. Vitest includes `test/**/*.test.ts`. Ignore `node_modules/`, `dist/`, `coverage/`, `.idea/`, `.synloq/runtime/`, and `*.sqlite*`.

Create the test:

```ts
import { describe, expect, it } from "vitest";
import { MAX_TEXT_BYTES, parseSendMessageInput } from "../../src/domain/message.js";

const valid = {
  project: "verdicta",
  from: "cto",
  to: "arch",
  text: "Review the storage boundary",
  expectsReply: true,
  idempotencyKey: "cto-0001",
};

describe("parseSendMessageInput", () => {
  it("accepts a direct message and rejects oversized UTF-8 text", () => {
    expect(parseSendMessageInput(valid).to).toBe("arch");
    expect(() => parseSendMessageInput({ ...valid, text: "🙂".repeat(MAX_TEXT_BYTES) })).toThrow(
      "text exceeds 32768 bytes",
    );
  });

  it("rejects an implicit broadcast", () => {
    expect(() => parseSendMessageInput({ ...valid, to: "*" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing implementation failure**

Run: `pnpm install && pnpm vitest run test/domain/message.test.ts`

Expected: FAIL because `src/domain/message.ts` does not exist. Do not proceed on any other failure.

- [ ] **Step 3: Implement the domain contracts**

Create `src/domain/message.ts`:

```ts
import { z } from "zod";

export const MAX_TEXT_BYTES = 32 * 1024;
export const agentId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const sendMessageInputSchema = z
  .object({
    project: z.string().min(1).max(128),
    from: agentId,
    to: agentId,
    text: z
      .string()
      .min(1)
      .refine(
        (text) => Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES,
        "text exceeds 32768 bytes",
      ),
    expectsReply: z.boolean(),
    inReplyTo: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export const parseSendMessageInput = (input: unknown): SendMessageInput =>
  sendMessageInputSchema.parse(input);

export interface Message extends SendMessageInput {
  id: string;
  threadId: string;
  createdAt: string;
  deliveryState: "stored" | "submitted" | "delivered" | "acked";
}

export interface Participant {
  project: string;
  agentId: string;
  title: string;
  role: string;
}
```

Create `src/domain/session.ts`:

```ts
export const PROTOCOL_VERSION = 1 as const;
export type SessionState = "idle" | "busy" | "closed" | "unknown";
export type DeliveryState = "stored" | "submitted" | "delivered" | "acked";

export interface AdapterCapabilities {
  activeDelivery: boolean;
  stateReporting: boolean;
  clientIdempotency: boolean;
}

export interface SessionRegistration {
  project: string;
  agentId: string;
  sessionId: string;
  protocolVersion: number;
  capabilities: AdapterCapabilities;
}

export interface AdapterSession extends SessionRegistration {
  state: SessionState;
  lastHeartbeatAt: string;
  stateObservedAt: string;
  leaseExpiresAt: string;
}
```

Create `src/domain/errors.ts`:

```ts
export class SynloqError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "UNKNOWN_RECIPIENT"
      | "IDEMPOTENCY_CONFLICT"
      | "DUPLICATE_SESSION"
      | "INCOMPATIBLE_PROTOCOL"
      | "RATE_LIMITED"
      | "QUEUE_FULL"
      | "PAUSED"
      | "STORAGE_FAILURE"
      | "UNAUTHORIZED"
      | "DELIVERY_UNCERTAIN"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SynloqError";
  }
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run: `pnpm vitest run test/domain/message.test.ts && pnpm typecheck`

Expected: 2 tests PASS; TypeScript exits 0.

- [ ] **Step 5: Commit the verified scaffold**

```bash
git add package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json vitest.config.ts .gitignore src/domain test/domain
git commit -m "feat: define Synloq domain contracts"
```

---

### Task 2: Versioned Manifest and External Credentials

**Files:**

- Create: `src/config/manifest.ts`, `src/config/paths.ts`, `src/config/credentials.ts`
- Test: `test/config/manifest.test.ts`, `test/config/credentials.test.ts`

**Interfaces:**

- Consumes: `Participant` and `SynloqError` from Task 1.
- Produces: `loadManifest(projectRoot): Promise<Participant[]>`, `projectPaths(projectRoot): ProjectPaths`, `CredentialStore.issue(project, agentId): Promise<string>`, and `CredentialStore.authenticate(project, token): Promise<Identity>`.

- [ ] **Step 1: Write failing manifest and credential tests**

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadManifest } from "../../src/config/manifest.js";

it("loads role descriptions without creating instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "synloq-manifest-"));
  await writeFile(
    join(root, "synloq.yaml"),
    [
      "project: verdicta",
      "agents:",
      "  cto:",
      "    title: CTO",
      "    role: Technical strategy and architecture",
    ].join("\n"),
  );
  await expect(loadManifest(root)).resolves.toEqual([
    {
      project: "verdicta",
      agentId: "cto",
      title: "CTO",
      role: "Technical strategy and architecture",
    },
  ]);
});
```

Add manifest rejection cases with exact `INVALID_INPUT` assertions for malformed YAML, a missing project, an invalid agent ID, unknown fields, and an unsupported manifest version. The credential test must issue two different tokens for `cto`, authenticate the correct `(project, agentId)`, reject a wrong token, reject the same token for another project, and verify that the stored JSON contains `tokenHash` but not the raw token.

- [ ] **Step 2: Run the tests and verify missing modules**

Run: `pnpm vitest run test/config`

Expected: FAIL because `manifest.ts` and `credentials.ts` are absent.

- [ ] **Step 3: Implement manifest loading and runtime paths**

Parse `synloq.yaml` with `YAML.parse` and validate it with a strict Zod schema whose `version` field is `z.literal(1).default(1)`, so the specification's minimal manifest remains valid while explicit unsupported versions fail. Convert YAML and schema failures to `SynloqError("INVALID_INPUT", ...)` and return participants only. `projectPaths` hashes the real project root so equally named repositories never share runtime state:

```ts
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

export interface ProjectPaths {
  key: string;
  database: string;
  credentials: string;
}

export async function projectPaths(projectRoot: string): Promise<ProjectPaths> {
  const canonical = await realpath(projectRoot);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const home = process.env.SYNLOQ_HOME ?? join(homedir(), ".synloq");
  return {
    key,
    database: join(home, "data", `${key}.sqlite`),
    credentials: join(home, "credentials", `${key}.json`),
  };
}
```

- [ ] **Step 4: Implement hashed credentials and verify tests**

Use `randomBytes(32).toString("base64url")` for tokens and SHA-256 for storage. Persist `{ version: 1, project, entries: [{ agentId, tokenHash }] }` with an atomic temporary-file rename and mode `0o600`. `authenticate` compares hashes with `timingSafeEqual` and returns:

```ts
export interface Identity {
  project: string;
  agentId: string;
  operator: boolean;
}
```

Reserve `operator` for the operator credential. Do not expose a model-supplied `from` override anywhere in this interface.

Run: `pnpm vitest run test/config && pnpm typecheck`

Expected: all config tests PASS; stored fixtures contain no raw token.

- [ ] **Step 5: Commit**

```bash
git add src/config test/config
git commit -m "feat: load participants and authenticate local chats"
```

---

### Task 3: Atomic SQLite Message Store

**Files:**

- Create: `src/storage/sqlite.ts`, `src/storage/message-store.ts`
- Test: `test/storage/message-store.test.ts`

**Interfaces:**

- Consumes: `Message`, `SendMessageInput`, and `SynloqError` from Task 1.
- Produces: `SQLiteMessageStore.create(input, id, createdAt, threadId)`, `getByIdempotency`, `getMessage`, `listInbox`, `acknowledge`, `nextPending`, `setDeliveryState`, `pendingUsage`, and `close`.

- [ ] **Step 1: Write failing persistence tests**

Cover these concrete cases in one store suite:

```ts
it("returns the original result for an idempotent retry", () => {
  const store = new SQLiteMessageStore(":memory:");
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
  expect(retry.message).toEqual(first.message);
  expect(retry.created).toBe(false);
  expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(1);
});

it("rejects reuse of a key with different content", () => {
  const store = new SQLiteMessageStore(":memory:");
  store.create(validInput, crypto.randomUUID(), new Date().toISOString(), crypto.randomUUID());
  expect(() =>
    store.create(
      { ...validInput, text: "different" },
      crypto.randomUUID(),
      new Date().toISOString(),
      crypto.randomUUID(),
    ),
  ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
});
```

Add tests for reply thread preservation, FIFO `nextPending`, an older `submitted` message blocking later `stored` entries, legal delivery transitions, recipient-only acknowledgement, bounded inbox pagination, and restoration after closing and reopening the same temporary file. Add fail-closed cases asserting that a corrupt SQLite file and an unwritable requested path both throw `STORAGE_FAILURE`, preserve the original failure, and never create an in-memory substitute.

- [ ] **Step 2: Run and verify the missing store failure**

Run: `pnpm vitest run test/storage/message-store.test.ts`

Expected: FAIL because `SQLiteMessageStore` is not implemented.

- [ ] **Step 3: Implement SQLite migrations and transactions**

`openDatabase` creates the parent directory, sets `PRAGMA foreign_keys=ON`, `PRAGMA journal_mode=WAL`, and applies `user_version = 1`. Convert open, migration, and write failures to `SynloqError("STORAGE_FAILURE", ...)`; never substitute an in-memory database for a requested file.

Create this schema:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  expects_reply INTEGER NOT NULL,
  in_reply_to TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('stored','submitted','delivered','acked')),
  UNIQUE(project, sender, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(project, recipient, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_fifo ON messages(project, recipient, created_at, id);
CREATE TABLE IF NOT EXISTS pause_gates (
  project TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','participant','thread')),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project, scope, scope_id)
);
```

Wrap `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK` in one synchronous helper. During `create`, read the idempotency row inside the transaction, compare every source field, and return the original row only when all fields match.

- [ ] **Step 4: Implement message queries and verify the suite**

Implement row mapping with explicit Boolean conversion for `expectsReply`. `listInbox` orders by `(createdAt, id)`, applies an opaque cursor containing both values, and limits `limit` to `1..100`. `nextPending` returns the oldest `stored` message for one recipient only when no older `submitted` message is awaiting a receipt; otherwise it returns `undefined`, preventing later messages from overtaking an in-flight one. `setDeliveryState` permits only `stored→submitted`, `submitted→delivered`, and `delivered→acked`; acknowledgement additionally checks the authenticated recipient.

Run: `pnpm vitest run test/storage/message-store.test.ts && pnpm typecheck`

Expected: all message-store tests PASS, including reopen persistence and invalid transition rejection.

- [ ] **Step 5: Commit**

```bash
git add src/storage test/storage
git commit -m "feat: persist messages atomically in SQLite"
```

---

### Task 4: Unique Sessions, Capabilities, and Heartbeat Leases

**Files:**

- Create: `src/storage/session-store.ts`, `src/adapters/types.ts`
- Modify: `src/storage/message-store.ts`
- Test: `test/storage/session-store.test.ts`

**Interfaces:**

- Consumes: `SessionRegistration`, `AdapterSession`, `SessionState`, `PROTOCOL_VERSION`, `SQLiteMessageStore`, and `SynloqError`.
- Produces: `SessionStore.register`, `heartbeat`, `close`, `effectiveState`, `reapExpired`, `list`, the shared `Clock`, `DeliveryAdapter`, and `DeliveryReceipt` contracts, `inactiveReason`, and `SQLiteMessageStore.resetSubmittedForRetry`.

- [ ] **Step 1: Write failing session tests**

Use a mutable test clock and verify all of these exact behaviors:

```ts
it("rejects a second visible session for the same role", () => {
  const store = new SessionStore(":memory:", clock);
  store.register(ctoSession("session-a"), false);
  expect(() => store.register(ctoSession("session-b"), false)).toThrow(
    expect.objectContaining({ code: "DUPLICATE_SESSION" }),
  );
});

it("forces unknown after lease expiry", () => {
  const store = new SessionStore(":memory:", clock);
  store.register(ctoSession("session-a"), false);
  clock.advance(15_001);
  expect(store.effectiveState("verdicta", "cto")).toBe("unknown");
});

it("rejects an incompatible protocol before changing state", () => {
  const store = new SessionStore(":memory:", clock);
  expect(() => store.register({ ...ctoSession("session-a"), protocolVersion: 2 }, false)).toThrow(
    expect.objectContaining({ code: "INCOMPATIBLE_PROTOCOL" }),
  );
  expect(store.list("verdicta")).toEqual([]);
});
```

Also verify same-session reconnect, operator replacement, heartbeat state freshness, `closed`, and capability preservation.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/storage/session-store.test.ts`

Expected: FAIL because `SessionStore` is absent.

- [ ] **Step 3: Implement session persistence and shared adapter types**

Persist sessions in `user_version = 2` with a primary key `(project, agentId)` and a unique `sessionId`. Use a 15-second lease and require a fresh state observation on every heartbeat. A reconnect may upsert only when the incoming `sessionId` equals the bound one; replacement requires `replace === true` and is reachable only from an operator service method.

Create `src/adapters/types.ts`:

```ts
import type { Message } from "../domain/message.js";
import type { AdapterCapabilities, AdapterSession, SessionState } from "../domain/session.js";

export interface Clock {
  now(): number;
}

export interface DeliveryReceipt {
  state: "submitted" | "delivered";
  clientMessageId?: string;
}

export interface DeliveryAdapter {
  readonly capabilities: AdapterCapabilities;
  state(sessionId: string): Promise<SessionState>;
  submit(sessionId: string, message: Message): Promise<DeliveryReceipt>;
}

export function inactiveReason(
  session: AdapterSession | undefined,
  observedState: SessionState = session?.state ?? "unknown",
): string {
  if (!session) return "session-not-registered";
  if (session.protocolVersion !== PROTOCOL_VERSION) return "incompatible-protocol";
  if (!session.capabilities.activeDelivery) return "active-delivery-unsupported";
  if (!session.capabilities.stateReporting) return "state-reporting-unsupported";
  if (observedState !== "idle") return `session-${observedState}`;
  return "ready";
}
```

Import `PROTOCOL_VERSION` as a value alongside the type imports. `effectiveState` returns `unknown` when state reporting is unsupported, `leaseExpiresAt <= now`, or `stateObservedAt` is older than five seconds. `reapExpired(messages)` calls `messages.resetSubmittedForRetry(message.id)` for a stale `submitted` message only when its registered adapter declares `clientIdempotency`; otherwise it remains `submitted` and blocked for operator inspection. Add tests for both reaper branches and for the diagnostic reasons.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/storage && pnpm typecheck`

Expected: all storage suites PASS; incompatible registration leaves an empty registry, and uncertain submissions are never reset automatically without client idempotency.

- [ ] **Step 5: Commit**

```bash
git add src/storage src/adapters/types.ts test/storage
git commit -m "feat: lease visible chat sessions"
```

---

### Task 5: Authenticated Relay Operations and Threads

**Files:**

- Create: `src/relay/relay-service.ts`
- Test: `test/relay/relay-service.test.ts`

**Interfaces:**

- Consumes: manifest and credentials from Task 2, stores from Tasks 3–4, domain contracts from Task 1.
- Produces: `RelayService.listParticipants`, `send`, `reply`, `inbox`, `acknowledge`, and `getMessage`; all agent operations require an authenticated `Identity`.

- [ ] **Step 1: Write failing identity and thread tests**

```ts
it("derives the sender from the authenticated connection", async () => {
  const { relay, cto } = await makeRelay();
  const forged: SendMessageInput = {
    ...validInput,
    project: "another-project",
    from: "ceo",
  };
  const message = await relay.send(cto, forged);
  expect(message.project).toBe("verdicta");
  expect(message.from).toBe("cto");
});

it("replies only to the original sender in the same thread", async () => {
  const { relay, cto, arch } = await makeRelay();
  const question = await relay.send(cto, validInput);
  const answer = await relay.reply(arch, {
    inReplyTo: question.id,
    text: "Use one SQLite writer",
    expectsReply: false,
    idempotencyKey: "arch-answer-1",
  });
  expect(answer.threadId).toBe(question.threadId);
  expect(answer.to).toBe("cto");
});

it("prevents reading another participant's inbox", async () => {
  const { relay, tester } = await makeRelay();
  await expect(
    relay.inbox(tester, { project: "verdicta", agentId: "arch", limit: 50 }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
```

Add a case proving that a third participant cannot reply to a message that was not addressed to it and a case proving that `acknowledge` returns `acked` without implying any other outcome.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/relay/relay-service.test.ts`

Expected: FAIL because `RelayService` is absent.

- [ ] **Step 3: Implement the relay operations**

Use this public contract:

```ts
export type SendRequest = Omit<SendMessageInput, "project" | "from">;
export type ReplyRequest = Omit<SendRequest, "to" | "inReplyTo"> & {
  inReplyTo: string;
};

export class RelayService {
  constructor(
    private readonly participants: Participant[],
    private readonly messages: SQLiteMessageStore,
    private readonly sessions: SessionStore,
    private readonly ids: () => string = crypto.randomUUID,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  async send(identity: Identity, raw: SendRequest): Promise<Message> {
    const input = parseSendMessageInput({
      ...raw,
      project: identity.project,
      from: identity.operator ? "operator" : identity.agentId,
    });
    this.requireParticipant(input.project, input.to);
    const parent = input.inReplyTo ? this.messages.getMessage(input.inReplyTo) : undefined;
    if (
      input.inReplyTo &&
      (!parent || parent.recipient !== identity.agentId || parent.project !== identity.project)
    ) {
      throw new SynloqError("NOT_FOUND", "reply parent not found");
    }
    const message = this.messages.create(
      input,
      this.ids(),
      new Date(this.clock.now()).toISOString(),
      parent?.threadId ?? this.ids(),
    ).message;
    return message;
  }

  async reply(identity: Identity, raw: ReplyRequest): Promise<Message> {
    const parent = this.messages.getMessage(raw.inReplyTo);
    if (!parent || parent.recipient !== identity.agentId || parent.project !== identity.project) {
      throw new SynloqError("NOT_FOUND", "reply parent not found");
    }
    return this.send(identity, {
      ...raw,
      to: parent.sender,
      inReplyTo: parent.id,
    });
  }
}
```

`send` must use the parent `threadId` when `inReplyTo` is present rather than generating a new one; `reply` performs the recipient and project check before calling `send`. `listParticipants` returns manifest data only. `inbox` permits only the authenticated participant, while an operator may inspect any participant. `acknowledge` delegates the recipient check to the store.

- [ ] **Step 4: Run relay and storage tests**

Run: `pnpm vitest run test/relay test/storage && pnpm typecheck`

Expected: all tests PASS; forged `project` and `from` values never reach storage.

- [ ] **Step 5: Commit**

```bash
git add src/relay/relay-service.ts test/relay/relay-service.test.ts
git commit -m "feat: route authenticated direct messages"
```

---

### Task 6: Rate, Queue, Cycle, and Pause Protections

**Files:**

- Create: `src/relay/protection.ts`
- Modify: `src/relay/relay-service.ts`, `src/storage/message-store.ts`
- Test: `test/relay/protection.test.ts`, `test/storage/pause-gates.test.ts`

**Interfaces:**

- Consumes: `Message`, `SendMessageInput`, `Identity`, `RelayService`, `SQLiteMessageStore`, and `SynloqError`.
- Produces: `ProtectionPolicy.beforeSend`, `afterAccept`, `pause`, `resume`, `isPaused`; `SQLiteMessageStore.pendingUsage`, `countThreadSince`, `pause`, `resume`, and `isPaused`.

- [ ] **Step 1: Write failing protection tests**

Use limits `maxPerSenderPerMinute = 2`, `maxPendingMessages = 1`, and `maxThreadMessagesPerWindow = 3` in the test fixture. Verify the exact sequence:

```ts
it("rejects a burst without creating the excessive message", () => {
  protection.beforeSend(first);
  protection.beforeSend(second);
  expect(() => protection.beforeSend(third)).toThrow(
    expect.objectContaining({ code: "RATE_LIMITED" }),
  );
  expect(store.listInbox("verdicta", "arch", undefined, 50).messages).toHaveLength(0);
});

it("pauses only active delivery for a cyclic thread", async () => {
  for (const message of threeMessagesInOneThread) {
    await relay.send(message.from === "cto" ? cto : arch, message.input);
  }
  expect(store.isPaused("verdicta", "thread", threadId)).toBe(true);
  expect(store.nextPending("verdicta", "arch")?.threadId).toBe(threadId);
});
```

Add executable cases for recipient rate limits, one-pending-message backpressure, byte limits, project and participant pause precedence, operator-only resume, and pause persistence after reopening SQLite.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/relay/protection.test.ts test/storage/pause-gates.test.ts`

Expected: FAIL because the protection methods are absent.

- [ ] **Step 3: Implement the synchronous policy**

Production defaults are 10 accepted sends per sender per minute, 20 per recipient per minute, 100 pending messages or 1 MiB per recipient, and 12 messages in one thread within two minutes. Token buckets are in-memory; queue and pause decisions are synchronous SQLite operations in the single relay writer.

```ts
export class ProtectionPolicy {
  constructor(
    private readonly store: SQLiteMessageStore,
    private readonly limits = DEFAULT_LIMITS,
    private readonly buckets = new Map<string, { tokens: number; resetAt: number }>(),
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  beforeSend(input: SendMessageInput): void {
    this.take(`sender:${input.project}:${input.from}`, this.limits.senderPerMinute);
    this.take(`recipient:${input.project}:${input.to}`, this.limits.recipientPerMinute);
    const usage = this.store.pendingUsage(input.project, input.to);
    if (
      usage.count >= this.limits.maxPendingMessages ||
      usage.bytes + Buffer.byteLength(input.text) > this.limits.maxPendingBytes
    ) {
      throw new SynloqError("QUEUE_FULL", "recipient queue limit reached");
    }
  }

  afterAccept(message: Message): void {
    const count = this.store.countThreadSince(
      message.threadId,
      new Date(this.clock.now() - this.limits.threadWindowMs).toISOString(),
    );
    if (count >= this.limits.maxThreadMessagesPerWindow) {
      this.store.pause(
        message.project,
        "thread",
        message.threadId,
        new Date(this.clock.now()).toISOString(),
      );
    }
  }
}
```

The `take` method refills exactly `limit` tokens at the start of each 60-second window and throws `RATE_LIMITED` when no token remains. `pause` and `resume` accept only operator identities at the service boundary. Pausing never deletes or rejects queued messages.

- [ ] **Step 4: Wire the relay, implement store counters, and verify all protection tests**

Add `ProtectionPolicy` to the `RelayService` constructor immediately after `SessionStore` and update every fixture and call site. In `RelayService.send`, call `protection.beforeSend(input)` after participant validation and before `messages.create`; call `protection.afterAccept(message)` only after the row is successfully persisted. Propagate protection errors without creating a message.

`pendingUsage` sums only `stored` and `submitted` messages. `countThreadSince` counts persisted messages by thread and timestamp. Pause keys are `project`, `participant:<agentId>`, or `thread:<threadId>`; `isPaused` checks all applicable scopes.

Run: `pnpm vitest run test/relay test/storage && pnpm typecheck`

Expected: all relay, protection, and persistence tests PASS; rejected sends create no row.

- [ ] **Step 5: Commit**

```bash
git add src/relay/protection.ts src/relay/relay-service.ts src/storage/message-store.ts test/relay test/storage
git commit -m "feat: bound message floods and delivery loops"
```

---

### Task 7: FIFO Dispatcher and Reference Adapter Contract

**Files:**

- Create: `src/relay/dispatcher.ts`, `src/adapters/reference.ts`
- Create: `test/adapters/contract.ts`, `test/adapters/reference.test.ts`, `test/relay/dispatcher.test.ts`

**Interfaces:**

- Consumes: stores, `DeliveryAdapter`, `DeliveryReceipt`, `Message`, and `Clock`.
- Produces: `Dispatcher.kick(project, agentId)`, `Dispatcher.runOnce(project, agentId)`, `ReferenceAdapter`, and reusable `runAdapterContract(name, factory)`.

- [ ] **Step 1: Write the eleven failing adapter contract scenarios**

Export a reusable Vitest suite whose factory returns a fresh `DeliveryAdapter`, a `SessionStore`, a `SQLiteMessageStore`, a mutable clock, and a visible-message log. Include these eleven named tests with concrete assertions:

1. `negotiates version 1 and rejects version 2` — registration succeeds for 1 and throws `INCOMPATIBLE_PROTOCOL` for 2.
2. `binds one visible session` — a different `sessionId` throws `DUPLICATE_SESSION`.
3. `delivers to fresh idle` — one call to `runOnce` appends the exact message ID and provenance to the visible log.
4. `holds while busy` — after `heartbeat(..., "busy")`, `runOnce` performs zero submissions and leaves `stored`.
5. `never steers a running response` — the adapter's submission spy is never called while busy.
6. `drains after reconnect` — closed heartbeat followed by same-session idle reconnect delivers in original order.
7. `preserves provenance` — visible content contains project, sender, message ID, and thread ID in a `<synloq>` envelope.
8. `deduplicates retry` — submitting the same `message.id` twice produces one visible entry and the original receipt.
9. `blocks later FIFO after failure` — a forced first-message failure leaves both messages stored; the second is never submitted.
10. `stops on heartbeat expiry` — advancing 15,001 ms changes effective state to `unknown` and prevents submission.
11. `reports unsupported capabilities` — an adapter with `activeDelivery: false` produces no dispatch and shared `inactiveReason(session)` returns `active-delivery-unsupported`.

The central assertion helper is:

```ts
async function expectDelivered(h: Harness, message: Message): Promise<void> {
  await h.dispatcher.runOnce(message.project, message.to);
  expect(h.visible.map((entry) => entry.id)).toContain(message.id);
  expect(h.store.getMessage(message.id).deliveryState).toBe("delivered");
}
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/adapters/reference.test.ts test/relay/dispatcher.test.ts`

Expected: FAIL because dispatcher and reference adapter are absent.

- [ ] **Step 3: Implement single-flight dispatch**

`Dispatcher` keeps a `Map<project/agentId, Promise<void>>` so concurrent `kick` calls share one drain. `runOnce` performs these checks synchronously before awaiting adapter I/O: pause gates, effective state `idle`, oldest dispatchable `stored` message, and per-recipient backoff. On receipt `submitted`, write `submitted` and stop the drain until a receipt arrives; on receipt `delivered`, perform both legal transitions. On an ordinary pre-transmission error, leave the message `stored`, set exponential backoff from 200 ms to 30 seconds, and never inspect the next message.

On `DELIVERY_UNCERTAIN` when `clientIdempotency` is false, transition the message to `submitted`, pause active delivery for that participant, and require operator inspection. This conservative state records an unresolved in-flight submission without claiming visible delivery; neither the reaper nor a later `kick` may reset or retry it automatically. Add a dispatcher test proving that repeated kicks and heartbeats perform zero further submissions for both the uncertain message and later FIFO entries.

Use this adapter boundary:

```ts
async runOnce(project: string, agentId: string): Promise<void> {
  const state = this.sessions.effectiveState(project, agentId);
  const pending = this.messages.nextPending(project, agentId);
  if (!pending || state !== "idle" || this.messages.isPaused(project, "participant", agentId) || this.messages.isPaused(project, "thread", pending.threadId)) return;
  const adapter = this.adapters.get(`${project}/${agentId}`);
  if (!adapter.capabilities.activeDelivery || !adapter.capabilities.stateReporting) return;
  const receipt = await adapter.submit(this.sessions.list(project).find((s) => s.agentId === agentId)!.sessionId, pending);
  if (receipt.state === "submitted") this.messages.setDeliveryState(pending.id, "submitted");
  else this.messages.setDeliveryState(pending.id, "delivered");
}
```

The complete implementation must add project pause, backoff, single-flight behavior, and the uncertain-delivery quarantine to this skeleton. It must also allow `setDeliveryState(..., "delivered")` to record the two internal transitions atomically.

- [ ] **Step 4: Implement the deterministic reference client and run the contract**

`ReferenceAdapter` stores per-session visible entries and a `Map<messageId, DeliveryReceipt>`. It throws when its session is not idle, has a `failNext(messageId)` test control, and returns the original receipt for a repeated message ID. Its visible entry is:

```ts
export function frameMessage(message: Message): string {
  return `<synloq project="${message.project}" from="${message.from}" message="${message.id}" thread="${message.threadId}">\n${message.text}\n</synloq>`;
}
```

Run: `pnpm vitest run test/adapters/reference.test.ts test/relay/dispatcher.test.ts && pnpm typecheck`

Expected: all eleven contract scenarios and dispatcher backoff tests PASS deterministically.

- [ ] **Step 5: Commit Gate A**

```bash
git add src/relay/dispatcher.ts src/adapters/reference.ts src/adapters/types.ts test/adapters test/relay/dispatcher.test.ts
git commit -m "feat: dispatch queued messages through verified adapters"
```

---

### Task 8: Authenticated Loopback Control API

**Files:**

- Create: `src/transport/http-server.ts`, `src/transport/http-client.ts`
- Test: `test/transport/http.test.ts`

**Interfaces:**

- Consumes: `RelayService`, `CredentialStore`, `SessionStore`, and `Dispatcher`.
- Produces: `RelayHttpServer.listen("127.0.0.1", 0)`, `close`, and a typed `RelayHttpClient` used by MCP, CLI, and remote adapters.

- [ ] **Step 1: Write failing HTTP boundary tests**

Start the server on port `0` and use native `fetch`. Verify:

```ts
it("requires authentication and derives identity from the token", async () => {
  await expect(fetch(`${baseUrl}/v1/participants`)).resolves.toMatchObject({ status: 401 });
  const response = await fetch(`${baseUrl}/v1/participants`, {
    headers: { authorization: `Bearer ${ctoToken}` },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    participants: [expect.objectContaining({ agentId: "cto" })],
  });
});

it("supports a long-poll timeout as a normal empty result", async () => {
  const ctoClient = new RelayHttpClient(baseUrl, () => ctoToken);
  const response = await ctoClient.inbox({ limit: 50, waitMs: 5 });
  expect(response).toEqual({ messages: [], nextCursor: undefined });
});
```

Add executable cases for send, reply, ack, session register/heartbeat/close, adapter pull and receipt, malformed JSON, body over 64 KiB, non-loopback listen rejection, and operator-only pause routes.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/transport/http.test.ts`

Expected: FAIL because the HTTP server and client are absent.

- [ ] **Step 3: Implement the versioned routes**

Expose only these routes under `http://127.0.0.1:<port>` with `Authorization: Bearer <token>`:

```text
GET  /v1/participants
POST /v1/messages
POST /v1/replies
GET  /v1/inbox?cursor=<cursor>&limit=<1..100>&waitMs=<0..25000>
POST /v1/ack
POST /v1/sessions/register
POST /v1/sessions/heartbeat
POST /v1/sessions/close
GET  /v1/deliveries/next?waitMs=<0..25000>
POST /v1/deliveries/:id/receipt
POST /v1/operator/pause
POST /v1/operator/resume
POST /v1/operator/replace-session
GET  /v1/operator/doctor
```

Use `node:http`, a 64 KiB JSON body cap, Zod parsing per route, and a shared error mapper (`400` validation, `401` authentication, `403` operator/identity, `404` missing, `409` conflicts, `429` rate/queue, `500` storage). `GET /v1/inbox` and delivery pull use an `EventEmitter` to wake on accepted messages or heartbeats; timeout returns an empty result, not an error. The server must throw if passed any host other than `127.0.0.1` or `::1`.

- [ ] **Step 4: Implement the typed client and run integration tests**

`RelayHttpClient` accepts `baseUrl` and a token provider, has one typed method per route, never logs the token, and preserves `SynloqError.code` from the response. Use `AbortSignal.timeout(waitMs + 5000)` only for long polls and `AbortSignal.timeout(5000)` elsewhere.

Run: `pnpm vitest run test/transport/http.test.ts && pnpm typecheck`

Expected: all HTTP tests PASS; no route binds a non-loopback interface.

- [ ] **Step 5: Commit**

```bash
git add src/transport test/transport
git commit -m "feat: expose the local relay control API"
```

---

### Task 9: Six Agent-Facing MCP Tools

**Files:**

- Create: `src/mcp/tools.ts`, `src/mcp/stdio.ts`
- Test: `test/mcp/tools.test.ts`

**Interfaces:**

- Consumes: `RelayHttpClient` from Task 8 and the official MCP SDK.
- Produces: `registerSynloqTools(server, client)` and the executable `synloq mcp` stdio bridge.

- [ ] **Step 1: Write failing MCP tool tests**

Use an in-memory MCP client/server pair and assert the exact tool names:

```ts
it("exposes only the six participant tools", async () => {
  const tools = await mcpClient.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "synloq_ack",
    "synloq_inbox",
    "synloq_list",
    "synloq_reply",
    "synloq_send",
    "synloq_wait",
  ]);
});

it("sends with an idempotency key and returns structured message data", async () => {
  const result = await mcpClient.callTool({
    name: "synloq_send",
    arguments: { to: "arch", text: "Review storage", expectsReply: true, idempotencyKey: "mcp-1" },
  });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    message: { to: "arch", deliveryState: "stored" },
  });
});
```

Add executable calls for reply, inbox, wait timeout, ack, invalid input, and proof that no pause, registration, credential, or replacement tool is listed.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/mcp/tools.test.ts`

Expected: FAIL because `registerSynloqTools` is absent.

- [ ] **Step 3: Register the tools**

Use `McpServer.registerTool` with strict Zod input schemas. Each handler returns `{ content: [{ type: "text", text }], structuredContent }`, maps `SynloqError` to `isError: true`, and delegates to these exact client methods:

```ts
export function registerSynloqTools(server: McpServer, client: RelayHttpClient): void {
  server.registerTool(
    "synloq_list",
    {
      description: "List project participants and role descriptions",
      inputSchema: {},
    },
    async () => result(await client.listParticipants()),
  );

  server.registerTool(
    "synloq_send",
    {
      description: "Send a direct message to one participant",
      inputSchema: {
        to: z.string(),
        text: z.string(),
        expectsReply: z.boolean(),
        idempotencyKey: z.string(),
      },
    },
    async (input) => result(await client.send(input)),
  );

  server.registerTool(
    "synloq_reply",
    {
      description: "Reply in an existing thread",
      inputSchema: {
        inReplyTo: z.string().uuid(),
        text: z.string(),
        expectsReply: z.boolean(),
        idempotencyKey: z.string(),
      },
    },
    async (input) => result(await client.reply(input)),
  );

  server.registerTool(
    "synloq_inbox",
    {
      description: "Read pending or historical incoming messages",
      inputSchema: {
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (input) => result(await client.inbox(input)),
  );

  server.registerTool(
    "synloq_wait",
    {
      description: "Wait for an incoming message; timeout is normal",
      inputSchema: { waitMs: z.number().int().min(0).max(25000).default(25000) },
    },
    async (input) => result(await client.inbox({ limit: 1, waitMs: input.waitMs })),
  );

  server.registerTool(
    "synloq_ack",
    {
      description: "Acknowledge that a message was read",
      inputSchema: { messageId: z.string().uuid() },
    },
    async (input) => result(await client.acknowledge(input.messageId)),
  );
}
```

The `result` helper JSON-stringifies only for the text fallback and preserves structured content. `stdio.ts` reads the credential file and relay URL from operator-created configuration, connects `StdioServerTransport`, and writes diagnostics only to stderr.

- [ ] **Step 4: Run MCP and transport tests**

Run: `pnpm vitest run test/mcp test/transport && pnpm typecheck`

Expected: all MCP tools PASS through the real in-memory protocol; only six tools are visible.

- [ ] **Step 5: Commit**

```bash
git add src/mcp test/mcp
git commit -m "feat: expose Synloq messaging over MCP"
```

---

### Task 10: Operator CLI and Doctor Diagnostics

**Files:**

- Create: `src/cli/main.ts`, `src/cli/commands.ts`, `src/cli/doctor.ts`
- Test: `test/cli/doctor.test.ts`, `test/cli/commands.test.ts`

**Interfaces:**

- Consumes: all relay, configuration, transport, session, and adapter interfaces from Tasks 2–9.
- Produces: `synloq init`, `serve`, `mcp`, `list`, `inbox`, `send`, `pause`, `resume`, `replace-session`, and `doctor`.

- [ ] **Step 1: Write failing CLI tests**

Test command handlers with a temporary `SYNLOQ_HOME` and a real relay on port `0`. Verify that `init` creates external credentials but leaves no runtime file in the repository; `list` shows manifest roles; `send` uses only the operator token; `pause` and `resume` change persisted gates; `replace-session` is required for a second binding; and `doctor` reports storage, protocol, capabilities, last heartbeat, queue usage, and an exact inactive reason.

The redaction assertion is:

```ts
it("never prints credentials or message bodies", async () => {
  const output = await captureDoctor(doctorFixture);
  expect(output).toContain("active-delivery-unsupported");
  expect(output).not.toContain(secretToken);
  expect(output).not.toContain(secretMessageBody);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/cli`

Expected: FAIL because command handlers are absent.

- [ ] **Step 3: Implement command handlers and doctor**

Use `node:util.parseArgs`. `init --project-root <path>` validates the manifest and creates one operator credential plus per-agent credentials externally. `serve --project-root <path>` opens SQLite, restores sessions and gates, reaps expired leases, starts adapters, and listens on loopback. `mcp --config <path>` starts the stdio bridge.

Doctor returns this stable structure before formatting:

```ts
export interface DoctorReport {
  storage: { ok: boolean; path: string; error?: string };
  participants: Array<{
    agentId: string;
    sessionId?: string;
    state: SessionState;
    adapterConnected: boolean;
    protocolVersion?: number;
    capabilities?: AdapterCapabilities;
    lastHeartbeatAt?: string;
    pendingCount: number;
    pendingBytes: number;
    inactiveReason: string;
  }>;
}
```

Import the shared `inactiveReason` from `src/adapters/types.ts`. Pass `sessions.effectiveState(project, agentId)` as its observed state rather than trusting the persisted raw state. Derive `adapterConnected` independently from the unexpired lease. Report `delivery-paused:<scope>` for an applicable persisted pause gate; otherwise use the shared capability/state reason. This keeps contract tests and CLI diagnostics on one implementation.

`main.ts` contains a `#!/usr/bin/env node` shebang, calls the selected handler, prints only its documented output, maps expected errors to concise stderr, and exits nonzero on failure. It never starts a development server or leaves child processes behind.

- [ ] **Step 4: Run CLI and full Gate B verification**

Run: `pnpm vitest run test/cli && pnpm verify`

Expected: CLI tests PASS; formatting, typecheck, all tests, and build exit 0.

- [ ] **Step 5: Commit Gate B**

```bash
git add src/cli test/cli
git commit -m "feat: add operator CLI and relay diagnostics"
```

---

### Task 11: Claude Code Channel and Hook State Adapter

**Files:**

- Create: `src/adapters/claude-channel.ts`, `src/adapters/claude-state.ts`, `src/cli/claude-hook.ts`
- Create: `docs/client-compatibility.md`
- Test: `test/adapters/claude-channel.test.ts`, `test/adapters/claude-state.test.ts`, `test/adapters/claude-contract.test.ts`

**Interfaces:**

- Consumes: MCP SDK, `RelayHttpClient`, `DeliveryAdapter`, message framing, session contracts, and the reusable adapter contract.
- Produces: `createClaudeChannelServer`, `ClaudeChannelAdapter.submit`, `mapClaudeHook`, `runClaudeHook`, and `runClaudeAdapter`.

- [ ] **Step 1: Write failing protocol and state tests**

Use a mock MCP initialize exchange and assert both experimental capabilities and the exact notification:

```ts
it("declares the required Claude channel capabilities", async () => {
  const initialized = await connectMockClaude();
  expect(initialized.capabilities.experimental).toEqual({
    "claude/channel": {},
    "claude/channel/permission": {},
  });
});

it("emits a provenance-preserving channel notification", async () => {
  await adapter.submit("claude-session-1", message);
  expect(channelNotifications[0]).toEqual({
    method: "notifications/claude/channel",
    params: {
      content: frameMessage(message),
      meta: { project: "verdicta", from: "cto", message: message.id, thread: message.threadId },
    },
  });
});
```

Test this exact state table:

```ts
it.each([
  ["SessionStart", "idle"],
  ["UserPromptSubmit", "busy"],
  ["Stop", "idle"],
  ["StopFailure", "idle"],
  ["SessionEnd", "closed"],
  ["PreToolUse", "unknown"],
] as const)("maps %s to %s", (event, expected) => {
  expect(mapClaudeHook(event).state).toBe(expected);
});
```

Also verify that notification write returns only `submitted`, a `UserPromptSubmit` hook containing the Synloq message ID posts the `delivered` receipt, missing activation or either required experimental capability yields `activeDelivery: false` and no injection, and a permission notification is never auto-approved.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/adapters/claude-channel.test.ts test/adapters/claude-state.test.ts`

Expected: FAIL because Claude adapter modules are absent.

- [ ] **Step 3: Implement channel injection and activation gating**

Use the low-level MCP `Server` so capabilities are explicit:

```ts
export function createClaudeChannelServer(): Server {
  return new Server(
    { name: "synloq", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
    },
  );
}
```

`ClaudeChannelAdapter.submit` sends `notifications/claude/channel` with `content` and `meta`, then returns `{ state: "submitted" }`. It never returns `delivered` merely because the stdio write succeeded. Its initial capabilities are `{ activeDelivery: false, stateReporting: true, clientIdempotency: true }`; active delivery becomes true only when the initialized exchange exposes both required experimental capabilities and the operator-created adapter config contains `activationVerifiedAt` for the same Claude `session_id` and protocol version.

`mapClaudeHook` implements the tested table. `runClaudeHook` reads one JSON object from stdin, heartbeats the mapped state, extracts `message="<uuid>"` from a Synloq envelope when present, posts the delivered receipt, emits no additional context, and never returns a permission decision.

- [ ] **Step 4: Run the reusable contract and record manual activation requirements**

Register the Claude adapter in the contract harness with fake hooks and a mock channel transport, then run:

Run: `pnpm vitest run test/adapters/claude-channel.test.ts test/adapters/claude-state.test.ts test/adapters/claude-contract.test.ts && pnpm typecheck`

Expected: all eleven adapter scenarios PASS with the mock. `docs/client-compatibility.md` must state that this is not live verification and give these exact activation mechanisms: local `--dangerously-load-development-channels` or managed `allowedChannelPlugins`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude-channel.ts src/adapters/claude-state.ts src/cli/claude-hook.ts test/adapters/claude-* docs/client-compatibility.md
git commit -m "feat: add gated Claude Code delivery"
```

---

### Task 12: OpenCode Queued Prompt and Event Adapter

**Files:**

- Create: `src/adapters/opencode.ts`
- Test: `test/adapters/opencode.test.ts`, `test/adapters/opencode-contract.test.ts`
- Modify: `docs/client-compatibility.md`

**Interfaces:**

- Consumes: `@opencode-ai/sdk`, `DeliveryAdapter`, `RelayHttpClient`, `frameMessage`, and the reusable contract suite.
- Produces: `OpenCodeAdapter.start`, `state`, `submit`, `close`, and `runOpenCodeAdapter`.

- [ ] **Step 1: Write failing OpenCode API tests**

Use a fake SDK client with a controllable event stream. Verify:

```ts
it("uses queue delivery and never steer", async () => {
  await adapter.submit("ses_cto", message);
  expect(v2.session.prompt).toHaveBeenCalledWith(
    {
      sessionID: "ses_cto",
      prompt: { text: frameMessage(message) },
      delivery: "queue",
      resume: false,
    },
    { throwOnError: true },
  );
});

it.each([
  [
    { type: "session.status", properties: { sessionID: "ses_cto", status: { type: "busy" } } },
    "busy",
  ],
  [
    { type: "session.status", properties: { sessionID: "ses_cto", status: { type: "idle" } } },
    "idle",
  ],
  [{ type: "session.idle", properties: { sessionID: "ses_cto" } }, "idle"],
  [{ type: "session.deleted", properties: { sessionID: "ses_cto" } }, "closed"],
] as const)("maps event to fresh state", async (event, expected) => {
  await emit(event);
  expect(await adapter.state("ses_cto")).toBe(expected);
});
```

Add executable cases proving event-stream EOF produces `unknown`, reconnect performs a fresh status read before delivery, an accepted inbox entry returns `delivered`, an uncertain transport failure returns no receipt, and repeated known message IDs return the original receipt without another prompt.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/adapters/opencode.test.ts`

Expected: FAIL because `OpenCodeAdapter` is absent.

- [ ] **Step 3: Implement event tracking and queued admission**

Create the normal client for session status and the v2 client for prompt admission against the same loopback OpenCode server. Subscribe with `client.event.subscribe()` and consume `events.stream`; use only events for the bound `sessionID`. On `server.connected` or stream reconnect, call `client.session.status({})` and require a fresh matching status before reporting `idle` or `busy`.

Use exactly:

```ts
const response = await this.openCode.v2.session.prompt(
  {
    sessionID: sessionId,
    prompt: { text: frameMessage(message) },
    delivery: "queue",
    resume: false,
  },
  { throwOnError: true },
);
```

A response containing the new inbox entry for the bound session is `delivered`, because OpenCode admitted it to that visible session. Before the call, store no success receipt; after the call, cache the receipt by Synloq `message.id`. An exception after request transmission is uncertain: throw `DELIVERY_UNCERTAIN`, set `clientIdempotency: false`, and require operator inspection rather than blindly reposting.

`start` runs heartbeat and event loops with bounded 200 ms–30 s backoff. `close` aborts both loops and reports `closed`. No code path may pass `delivery: "steer"`.

- [ ] **Step 4: Run the full contract and static steering check**

Run: `pnpm vitest run test/adapters/opencode.test.ts test/adapters/opencode-contract.test.ts && pnpm typecheck`

Run: `pnpm exec prettier --check src/adapters/opencode.ts`

Expected: all eleven contract scenarios PASS with the fake client. A source scan in `opencode-contract.test.ts` must assert that the adapter contains `delivery: "queue"` and does not contain `delivery: "steer"`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts test/adapters/opencode* docs/client-compatibility.md
git commit -m "feat: add OpenCode queued delivery"
```

---

### Task 13: Kimi Code Honest Fallback and ACP Compatibility Probe

**Files:**

- Create: `src/adapters/kimi-fallback.ts`, `scripts/probe-kimi-acp.ts`
- Test: `test/adapters/kimi-fallback.test.ts`
- Modify: `docs/client-compatibility.md`

**Interfaces:**

- Consumes: adapter capabilities, session state, `DeliveryAdapter`, and operator CLI reporting.
- Produces: `KimiFallbackAdapter`, `probeKimiAcp`, and a reproducible JSON compatibility report. Active delivery remains disabled in this task.

- [ ] **Step 1: Write the failing fallback test**

```ts
it("supports MCP inbox without claiming active delivery", async () => {
  const adapter = new KimiFallbackAdapter();
  expect(adapter.capabilities).toEqual({
    activeDelivery: false,
    stateReporting: false,
    clientIdempotency: false,
  });
  await expect(adapter.state("kimi-session")).resolves.toBe("unknown");
  await expect(adapter.submit("kimi-session", message)).rejects.toMatchObject({
    code: "DELIVERY_UNCERTAIN",
  });
  expect(inactiveReason(kimiSession)).toBe("active-delivery-unsupported");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run test/adapters/kimi-fallback.test.ts`

Expected: FAIL because `KimiFallbackAdapter` is absent.

- [ ] **Step 3: Implement fallback and a bounded read-only ACP probe**

`KimiFallbackAdapter.state` always returns `unknown`; `submit` always throws before network or client activity. MCP inbox and `synloq_wait` remain available through the normal client connection.

`probeKimiAcp` spawns `kimi acp` only when the operator runs the script, uses NDJSON JSON-RPC over stdio, sends `initialize`, and preserves the raw initialize result in the report. It must negotiate from that result rather than assume ACP v1: for v1, read resume support from `agentCapabilities.sessionCapabilities.resume`; for v2, inspect the session baseline under `capabilities.session`. Use only resume behavior advertised for the negotiated version. Never fall back to `session/load`, which is removed in ACP v2.

With `--session-id <id>`, send `session/resume` using `{ sessionId, cwd, mcpServers: [] }` only when the negotiated capabilities advertise it; otherwise record that resume was skipped as unsupported. Without that explicit flag, do not resume or prompt any existing chat. Every operation has a five-second timeout and child termination on completion.

The JSON report contains:

```ts
export interface KimiAcpReport {
  kimiVersion: string;
  observedAt: string;
  initialize: unknown;
  resumeResult?: unknown;
  resumeSkippedReason?: string;
  activeDeliveryClaim: false;
  reason: "existing-tui-interaction-not-verified";
}
```

Do not send `session/prompt` in this automated probe. The separate manual acceptance procedure in Task 14 is the only path that may prompt an already open TUI.

- [ ] **Step 4: Run tests and record the compatibility command**

Run: `pnpm vitest run test/adapters/kimi-fallback.test.ts && pnpm typecheck`

Expected: fallback test PASS; doctor reports `active-delivery-unsupported` and no active-delivery claim appears in the generated report.

Document the operator command `node scripts/probe-kimi-acp.ts --cwd <absolute-project-path>`. Node 24 executes the probe's erasable TypeScript syntax directly; do not add `tsx` or another runtime dependency.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/kimi-fallback.ts scripts/probe-kimi-acp.ts test/adapters/kimi-fallback.test.ts docs/client-compatibility.md
git commit -m "feat: add honest Kimi Code fallback"
```

---

### Task 14: End-to-End Acceptance, Documentation, and Package Gate

**Files:**

- Create: `test/e2e/reference.e2e.test.ts`, `test/e2e/real-clients.md`, `README.md`
- Modify: `package.json`, `docs/client-compatibility.md`
- Test: `test/e2e/reference.e2e.test.ts`

**Interfaces:**

- Consumes: the complete product from Tasks 1–13.
- Produces: reproducible clean-checkout verification, operator installation instructions, per-client support evidence, and a packable `synloq` binary.

- [ ] **Step 1: Write the failing automated end-to-end scenario**

Start one real relay with a temporary SQLite file and two reference visible sessions named `cto` and `arch`. Drive both through the real MCP in-memory transport and HTTP adapter path. The test must execute this exact sequence:

1. CTO sends `Please review the storage boundary` with `expectsReply: true`.
2. Assert the sender call returns immediately with a message ID.
3. Assert idle Architect receives a framed message with the same ID.
4. Set Architect busy, send a second message, and assert no visible entry or steering occurs.
5. Report idle and assert the second message arrives after the first.
6. Close Architect, send a third message, reconnect the same session, and assert FIFO recovery.
7. Reply as Architect and assert CTO sees the original `threadId` and `inReplyTo`.
8. Acknowledge both sides and assert `acked` only on their own incoming messages.
9. Restart the relay without deleting SQLite and assert no pending loss or duplicate visible message.
10. Attempt a tool or permission change through message text and assert no additional capability is registered.

Include the restart assertion:

```ts
expect(afterRestart.visibleIds()).toEqual(beforeRestart.visibleIds());
expect(afterRestart.pendingCount()).toBe(0);
```

- [ ] **Step 2: Run and fix only integration defects**

Run: `pnpm vitest run test/e2e/reference.e2e.test.ts`

Expected initially: FAIL at the first unwired transport or lifecycle boundary. Fix the actual wiring, rerun the identical test, and require all ten observations to PASS without sleeps; use bounded polling with a one-second deadline.

- [ ] **Step 3: Write operator and real-client verification documentation**

`README.md` documents installation, `synloq init`, `synloq serve`, MCP configuration, one-time role binding, the six tools, pause/resume, doctor, external runtime paths, and the no-orchestrator boundary.

`test/e2e/real-clients.md` gives a reproducible manual matrix for Claude Code and OpenCode with the installed client version, activation settings, two visible sessions, busy/idle observations, reconnect, restart, provenance, deduplication, and permission checks. Its required cross-client scenario binds one visible Claude Code chat as `cto` and one visible OpenCode chat as `arch`, then records a question and reply with the same thread ID and no human copying. It requires the operator to record command output and observed client behavior before changing a client to `verified` in `docs/client-compatibility.md`.

The Kimi section runs `scripts/probe-kimi-acp.ts` first. Only if the operator separately proves safe interaction with an already open TUI may a later task add active Kimi delivery; the MVP support entry remains `inbox-only` otherwise.

Execute the manual matrix with the operator and record its actual output before marking Claude Code or OpenCode `verified`. If either real client is unavailable, leave its support `unverified` and report the real-client acceptance gate as incomplete; mock and reference tests cannot substitute for this evidence.

- [ ] **Step 4: Run the complete clean gate and package smoke test**

Set `package.json` `files` to `["dist"]` so the package includes the compiled runtime plus npm's automatic README and package metadata, but excludes sources, tests, and local runtime state. Keep the package private and do not add a publish step.

Run:

```bash
pnpm verify
pnpm pack --pack-destination .tmp-pack
```

Expected: formatting, typecheck, all unit/contract/integration/e2e tests, and build PASS. The tarball contains `dist/cli/main.js`, `dist/mcp/stdio.js`, `README.md`, and `package.json`, but no tests, SQLite files, credentials, `.idea`, or message bodies.

Run `node dist/cli/main.js doctor --help` and expect exit 0 with the doctor options on stdout. Do not publish the package.

- [ ] **Step 5: Commit the verified MVP**

```bash
git add README.md docs/client-compatibility.md test/e2e package.json pnpm-lock.yaml
git commit -m "test: verify the Synloq MVP end to end"
```

---

## Completion Checklist

- [ ] Every task's focused tests were actually run and their real output recorded.
- [ ] `pnpm verify` passed from a clean checkout after the final task.
- [ ] Reference adapter passed all eleven contract scenarios.
- [ ] Claude Code and OpenCode support claims match real-client evidence, not mock results.
- [ ] Kimi Code remains inbox-only unless safe existing-TUI interaction was independently observed.
- [ ] No runtime database, credential, log, message body, or IDE file is tracked by Git.
- [ ] No automatic merge, push, dashboard, group channel, task workflow, or remote delivery was added.
