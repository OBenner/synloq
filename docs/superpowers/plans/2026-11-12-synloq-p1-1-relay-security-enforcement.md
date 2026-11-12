# P1.1 Relay Security Enforcement (deny-audit + cross-channel conformance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P1.1 slice of per-chat MCP isolation: every authorization/participant denial in the relay is recorded to a durable security audit log, cross-channel misuse is pinned by a conformance test suite, and the threat model is documented.

**Architecture:** Add a minimal `SecurityAuditLog` port in `src/relay/audit-log.ts` (null + JSONL-file implementations). `RelayService` and `RelayHttpServer` accept it as an optional constructor dependency (default null — zero behavior change for existing tests) and record every `SynloqError` rejection. Wiring happens once in `serveCommand` (`src/cli/commands.ts`). No protocol changes: Synloq protocol v1 is frozen; the known `requireParticipant` sender asymmetry is deliberately NOT fixed here (deferred to spec v1.1).

**Tech Stack:** TypeScript (Node >= 24, ESM), vitest, better-sqlite3-backed stores (in-memory for tests), prettier.

## Global Constraints

- Protocol v1 (`docs/protocol/v1.md`) is frozen — this plan changes NO message semantics, reason codes, or API shapes.
- Do NOT add sender validation to `requireParticipant` — the from/to asymmetry is a known v1.1 item (CTO decision 2026-11-12).
- No new runtime dependencies. Use only `node:*` builtins, existing deps, and vitest.
- Every public behavior change is TDD: failing test first, then minimal implementation.
- `pnpm verify` (format:check + typecheck + test + build) must stay green after every task.
- All new files formatted with prettier defaults of the repo (2 spaces, double quotes, semicolons, trailing commas — match neighboring files).
- Audit log is append-only JSONL; it is NOT a protocol message channel and MUST NOT be readable via MCP tools.

---

### Task 1: SecurityAuditLog port (`src/relay/audit-log.ts`)

**Files:**

- Create: `src/relay/audit-log.ts`
- Test: `test/relay/audit-log.test.ts`

**Interfaces:**

- Consumes: nothing outside `node:fs`, `node:path`.
- Produces:
  - `type AuditedAction = "send" | "reply" | "inbox" | "acknowledge" | "getMessage" | "pause" | "resume" | "authenticate"`
  - `interface SecurityEvent { at: string; project: string; agentId: string; action: AuditedAction; decision: "deny"; reasonCode: string; detail: string }`
  - `interface SecurityAuditLog { record(event: SecurityEvent): void }`
  - `class NullSecurityAuditLog implements SecurityAuditLog`
  - `class FileSecurityAuditLog implements SecurityAuditLog { constructor(path: string); record(event): void }`

- [ ] **Step 1: Write the failing test**

```ts
// test/relay/audit-log.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSecurityAuditLog,
  NullSecurityAuditLog,
  type SecurityEvent,
} from "../../src/relay/audit-log.js";

const event: SecurityEvent = {
  at: "2026-11-12T10:00:00.000Z",
  project: "synloq",
  agentId: "arch",
  action: "inbox",
  decision: "deny",
  reasonCode: "UNAUTHORIZED",
  detail: "inbox does not belong to the authenticated identity",
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("FileSecurityAuditLog", () => {
  it("appends one JSON line per event and creates the parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "synloq-audit-"));
    dirs.push(dir);
    const log = new FileSecurityAuditLog(join(dir, "nested", "audit.jsonl"));
    log.record(event);
    log.record({ ...event, action: "acknowledge", reasonCode: "UNAUTHORIZED" });
    const lines = readFileSync(join(dir, "nested", "audit.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(event);
    expect(JSON.parse(lines[1]).action).toBe("acknowledge");
  });
});

describe("NullSecurityAuditLog", () => {
  it("accepts events without side effects", () => {
    expect(() => new NullSecurityAuditLog().record(event)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/relay/audit-log.test.ts`
Expected: FAIL — module `../../src/relay/audit-log.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/relay/audit-log.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditedAction =
  "send" | "reply" | "inbox" | "acknowledge" | "getMessage" | "pause" | "resume" | "authenticate";

export interface SecurityEvent {
  at: string;
  project: string;
  agentId: string;
  action: AuditedAction;
  decision: "deny";
  reasonCode: string;
  detail: string;
}

export interface SecurityAuditLog {
  record(event: SecurityEvent): void;
}

export class NullSecurityAuditLog implements SecurityAuditLog {
  record(): void {
    // intentional no-op: default when no audit sink is configured
  }
}

export class FileSecurityAuditLog implements SecurityAuditLog {
  constructor(private readonly path: string) {}

  record(event: SecurityEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/relay/audit-log.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/relay/audit-log.ts test/relay/audit-log.test.ts
git commit -m "feat: add security audit log port (null + JSONL file sinks)"
```

---

### Task 2: Record denials in RelayService

**Files:**

- Modify: `src/relay/relay-service.ts` (whole file is 139 lines; add import, constructor param, helper, wrap 7 public methods)
- Test: `test/relay/relay-service-audit.test.ts`

**Interfaces:**

- Consumes: `SecurityAuditLog`, `SecurityEvent`, `AuditedAction` from Task 1; existing `Identity` from `src/config/credentials.ts` (`{ project: string; agentId: string; operator?: boolean }`); existing `SynloqError` (`.code`, `.message`).
- Produces: `RelayService` constructor gains an optional 7th parameter `audit: SecurityAuditLog = new NullSecurityAuditLog()`. No signature changes to existing methods.

Design rule: **every** `SynloqError` escaping a public RelayService method is a controlled rejection and is recorded exactly once. Non-SynloqError failures (bugs, storage crashes) are NOT recorded — they are not policy denials.

- [ ] **Step 1: Write the failing test**

```ts
// test/relay/relay-service-audit.test.ts
import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import {
  NullSecurityAuditLog,
  type SecurityAuditLog,
  type SecurityEvent,
} from "../../src/relay/audit-log.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "synloq", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "synloq", agentId: "arch", title: "Architect", role: "review" },
];

class SpyAuditLog implements SecurityAuditLog {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

function makeRelay(audit: SecurityAuditLog = new NullSecurityAuditLog()) {
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    new ProtectionPolicy(messages),
    undefined,
    undefined,
    audit,
  );
  return { relay, messages, sessions };
}

const cto: Identity = { project: "synloq", agentId: "cto" };
const arch: Identity = { project: "synloq", agentId: "arch" };

describe("RelayService audit", () => {
  it("records a deny event when inbox belongs to another role", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await expect(
      relay.inbox(cto, { project: "synloq", agentId: "arch", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      project: "synloq",
      agentId: "cto",
      action: "inbox",
      decision: "deny",
      reasonCode: "UNAUTHORIZED",
    });
  });

  it("records a deny event for unknown recipient on send", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await expect(
      relay.send(cto, {
        to: "ghost",
        text: "ping",
        expectsReply: false,
        idempotencyKey: "cto-audit-1",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events.map((e) => e.reasonCode)).toEqual(["UNKNOWN_RECIPIENT"]);
  });

  it("does not record successful operations", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    await relay.send(cto, {
      to: "arch",
      text: "ok",
      expectsReply: false,
      idempotencyKey: "cto-audit-2",
    });
    expect(audit.events).toHaveLength(0);
  });

  it("records a deny event when acknowledging a message addressed to another role", async () => {
    const audit = new SpyAuditLog();
    const { relay } = makeRelay(audit);
    const message = await relay.send(cto, {
      to: "arch",
      text: "for arch only",
      expectsReply: false,
      idempotencyKey: "cto-audit-3",
    });
    await expect(relay.acknowledge(cto, message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "acknowledge", reasonCode: "UNAUTHORIZED" });
  });

  it("defaults to NullSecurityAuditLog when no audit is injected", async () => {
    const { relay } = makeRelay();
    await expect(
      relay.inbox(cto, { project: "synloq", agentId: "arch", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/relay/relay-service-audit.test.ts`
Expected: FAIL — constructor accepts only 6 parameters / no events recorded.

- [ ] **Step 3: Write minimal implementation**

In `src/relay/relay-service.ts`:

1. Add imports:

```ts
import { NullSecurityAuditLog, type AuditedAction, type SecurityAuditLog } from "./audit-log.js";
```

2. Extend the constructor (7th parameter, after `clock`):

```ts
    private readonly clock: Clock = { now: () => Date.now() },
    private readonly audit: SecurityAuditLog = new NullSecurityAuditLog(),
  ) {}
```

3. Add a private helper:

```ts
  private recordDeny(identity: Identity, action: AuditedAction, error: unknown): void {
    if (!(error instanceof SynloqError)) return;
    this.audit.record({
      at: new Date(this.clock.now()).toISOString(),
      project: identity.project,
      agentId: identity.operator ? "operator" : identity.agentId,
      action,
      decision: "deny",
      reasonCode: error.code,
      detail: error.message,
    });
  }
```

4. Wrap each public method body in try/catch that records then rethrows. Pattern (apply identically to `send`, `reply`, `inbox`, `acknowledge`, `getMessage`, `pause`, `resume`):

```ts
  async inbox(identity: Identity, raw: InboxRequest): Promise<InboxResult> {
    try {
      if (
        raw.project !== identity.project ||
        (!identity.operator && raw.agentId !== identity.agentId)
      ) {
        throw new SynloqError("UNAUTHORIZED", "inbox does not belong to the authenticated identity");
      }
      return this.messages.listInbox(raw.project, raw.agentId, raw.cursor, raw.limit);
    } catch (error) {
      this.recordDeny(identity, "inbox", error);
      throw error;
    }
  }
```

For `send` note: wrap the whole existing body the same way with `action: "send"`. For `reply`: `action: "reply"`. For `acknowledge`: wrap `this.messages.acknowledge(...)` with `action: "acknowledge"` (store-level `UNAUTHORIZED` "only the recipient can acknowledge" flows through this wrapper — that is the intended coverage). `pause`/`resume` are sync — same try/catch pattern, `action: "pause"` / `"resume"`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/relay/relay-service-audit.test.ts test/relay/relay-service.test.ts`
Expected: PASS — new audit tests green AND all pre-existing relay-service tests green (constructor default keeps them compiling unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/relay/relay-service.ts test/relay/relay-service-audit.test.ts
git commit -m "feat: record authorization denials in relay service audit log"
```

---

### Task 3: Wire audit into serveCommand + authenticate failures

**Files:**

- Modify: `src/cli/commands.ts:83-137` (`serveCommand`)
- Modify: `src/transport/http-server.ts:160-200` (constructor options + `authenticate` call site)
- Test: `test/cli/serve-audit.test.ts`

**Interfaces:**

- Consumes: `FileSecurityAuditLog` (Task 1); audited `RelayService` (Task 2); existing `projectPaths()` (`src/config/paths.ts`) — use `paths.home` + `paths.key`; existing `RelayHttpServer` options object (`src/transport/http-server.ts`).
- Produces: `RelayHttpServer` options gain optional `audit?: SecurityAuditLog`. Audit file location: `<synloqHome>/data/<projectKey>-audit.jsonl`.

- [ ] **Step 1: Write the failing test**

```ts
// test/cli/serve-audit.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveCommand } from "../../src/cli/commands.js";

// Reuse the manifest/fixture conventions of test/cli/*.test.ts: create a temp
// project root with the participants manifest exactly as the existing CLI tests do.
// (Copy the fixture helper from the existing CLI test file verbatim.)

describe("serveCommand audit wiring", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("writes an audit line for a request with an invalid bearer token", async () => {
    const root = mkdtempSync(join(tmpdir(), "synloq-serve-audit-"));
    dirs.push(root);
    writeFileSync(
      join(root, "synloq.yaml"),
      [
        "project: synloq",
        "participants:",
        "  - agentId: cto",
        "    title: CTO",
        "    role: coordination",
        "",
      ].join("\n"),
    );
    const handle = await serveCommand({ projectRoot: root, port: 0 });
    try {
      const response = await fetch(`${handle.baseUrl}/v1/participants`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(response.status).toBe(401);
      const auditPath = join(root /* resolved via projectPaths(root) — see note below */);
      // NOTE for implementer: compute the expected path with the real helper:
      //   const paths = await projectPaths(root);
      //   const auditPath = join(paths.home, "data", `${paths.key}-audit.jsonl`);
      // The default synloqHome is the user home; tests MUST pass an explicit
      // synloqHome inside the temp dir: serveCommand({ projectRoot: root, port: 0, synloqHome: join(root, ".synloq") })
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        action: "authenticate",
        decision: "deny",
        reasonCode: "UNAUTHORIZED",
      });
    } finally {
      await handle.close();
    }
  });
});
```

Check first: read an existing CLI test (`test/cli/`) to confirm the real manifest filename/format and the exact `serveCommand` options type (`ServeOptions` in `src/cli/commands.ts`) — copy the fixture approach from there instead of guessing; adjust the test above to match before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/cli/serve-audit.test.ts`
Expected: FAIL — no audit file is created.

- [ ] **Step 3: Write minimal implementation**

1. In `src/transport/http-server.ts`:
   - Import `type SecurityAuditLog` and `NullSecurityAuditLog` from `../relay/audit-log.js`.
   - Add `audit?: SecurityAuditLog` to the server options type; store as `private readonly audit = options.audit ?? new NullSecurityAuditLog();`.
   - Around the `authenticate(...)` call (line ~172), on `SynloqError` record then rethrow:

```ts
try {
  identity = await this.authenticate(request.headers.authorization);
} catch (error) {
  if (error instanceof SynloqError) {
    this.audit.record({
      at: new Date().toISOString(),
      project: this.options.project,
      agentId: "unknown",
      action: "authenticate",
      decision: "deny",
      reasonCode: error.code,
      detail: error.message,
    });
  }
  throw error;
}
```

2. In `src/cli/commands.ts` `serveCommand`, after `const messages = ...`:

```ts
const audit = new FileSecurityAuditLog(join(paths.home, "data", `${paths.key}-audit.jsonl`));
```

Pass `audit` as the 7th argument to `new RelayService(...)` and as `audit` into the `RelayHttpServer` options object. Add imports: `FileSecurityAuditLog` from `../relay/audit-log.js`, `join` from `node:path` (if not already imported).

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/cli/serve-audit.test.ts test/e2e/relay-lifecycle.test.ts`
Expected: PASS — audit line written for bad token; lifecycle e2e unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts src/transport/http-server.ts test/cli/serve-audit.test.ts
git commit -m "feat: wire security audit log into relay server and auth failures"
```

---

### Task 4: Cross-channel conformance suite

**Files:**

- Create: `test/relay/cross-channel-conformance.test.ts`

**Interfaces:**

- Consumes: audited `RelayService` (Task 2), `SpyAuditLog` pattern from `test/relay/relay-service-audit.test.ts`, participant fixtures pattern from `test/relay/relay-service.test.ts`.
- Produces: pinned behavior contract — every cross-channel misuse yields a specific `SynloqError.code` AND exactly one audit event. This suite is the executable form of the P1.1 conformance requirement ("чужой канал = UNAUTHORIZED/BLOCKED").

- [ ] **Step 1: Write the failing tests**

```ts
// test/relay/cross-channel-conformance.test.ts
import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import type { Participant } from "../../src/domain/message.js";
import type { SecurityAuditLog, SecurityEvent } from "../../src/relay/audit-log.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

const participants: Participant[] = [
  { project: "synloq", agentId: "cto", title: "CTO", role: "coordination" },
  { project: "synloq", agentId: "arch", title: "Architect", role: "review" },
  { project: "synloq", agentId: "security", title: "Security", role: "hardening" },
  { project: "synloq", agentId: "dev", title: "Developer", role: "implementation" },
  { project: "other", agentId: "arch", title: "Other Arch", role: "other project" },
];

class SpyAuditLog implements SecurityAuditLog {
  readonly events: SecurityEvent[] = [];
  record(event: SecurityEvent): void {
    this.events.push(event);
  }
}

function makeRelay() {
  const audit = new SpyAuditLog();
  const messages = new SQLiteMessageStore(":memory:");
  const sessions = new SessionStore(":memory:");
  const relay = new RelayService(
    participants,
    messages,
    sessions,
    new ProtectionPolicy(messages),
    undefined,
    undefined,
    audit,
  );
  return { relay, audit };
}

const as = (agentId: string, project = "synloq"): Identity => ({ project, agentId });

let seq = 0;
const key = (prefix: string) => `${prefix}-conf-${++seq}`;

describe("cross-channel conformance", () => {
  it("inbox of a foreign role is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.inbox(as("arch"), { project: "synloq", agentId: "cto", limit: 10 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(audit.events).toHaveLength(1);
  });

  it("reply to a message addressed to another role is NOT_FOUND and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "arch",
      text: "arch only",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    await expect(
      relay.reply(as("security"), {
        inReplyTo: message.id,
        text: "I was not asked",
        expectsReply: false,
        idempotencyKey: key("sec"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ action: "reply", agentId: "security" });
  });

  it("acknowledging a message addressed to another role is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "dev task",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    await expect(relay.acknowledge(as("arch"), message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events.map((e) => e.action)).toEqual(["acknowledge"]);
  });

  it("getMessage between two other roles is UNAUTHORIZED and audited", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "private thread",
      expectsReply: false,
      idempotencyKey: key("cto"),
    });
    await expect(relay.getMessage(as("security"), message.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(audit.events).toHaveLength(1);
  });

  it("sending to a non-existent role is UNKNOWN_RECIPIENT and audited", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.send(as("cto"), {
        to: "ghost",
        text: "nobody home",
        expectsReply: false,
        idempotencyKey: key("cto"),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events).toHaveLength(1);
  });

  it("cross-project: recipient existing only in another project is UNKNOWN_RECIPIENT", async () => {
    const { relay, audit } = makeRelay();
    await expect(
      relay.send(as("arch", "other"), {
        to: "cto",
        text: "wrong project boundary",
        expectsReply: false,
        idempotencyKey: key("arch"),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].project).toBe("other");
  });

  it("a participant CAN read and ack own inbox end-to-end without audit events", async () => {
    const { relay, audit } = makeRelay();
    const message = await relay.send(as("cto"), {
      to: "dev",
      text: "legit",
      expectsReply: true,
      idempotencyKey: key("cto"),
    });
    const inbox = await relay.inbox(as("dev"), { project: "synloq", agentId: "dev", limit: 10 });
    expect(inbox.messages.map((m) => m.id)).toContain(message.id);
    await expect(relay.acknowledge(as("dev"), message.id)).resolves.toMatchObject({
      deliveryState: "acked",
    });
    expect(audit.events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify current behavior**

Run: `pnpm vitest run test/relay/cross-channel-conformance.test.ts`
Expected: PASS immediately after Tasks 2–3 (they pin existing behavior). If any case FAILS on current behavior, that is a real finding — stop, do NOT weaken the test, report to CTO with the failing case before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/relay/cross-channel-conformance.test.ts
git commit -m "test: pin cross-channel authorization conformance (P1.1)"
```

---

### Task 5: Threat model document

**Files:**

- Create: `docs/security/threat-model-2026-11-12.md`

**Interfaces:**

- Consumes: P1 research `docs/research/2026-11-12-per-chat-mcp-isolation.md`, protocol `docs/protocol/v1.md`, Tasks 1–4 behavior.
- Produces: committed threat model; referenced from future security reviews.

- [ ] **Step 1: Write the document**

Content (write verbatim, adjust section numbering only if the file gains sections later):

```markdown
# Synloq Threat Model — 2026-11-12

Scope: single-host relay (loopback HTTP), 4 role channels via one Kimi Work plugin,
per-role bearer tokens in `~/.synloq/credentials/<projectKey>/`.

## Assets

- Message store (SQLite) — integrity and confidentiality of team communication.
- Per-role tokens — identity of a role; possession = the role.
- Operator token — pause gates, cross-inbox read.
- Role conversation bindings (conversationKey) — visible-chat authenticity.

## Actors

- Legitimate role chats (cto, arch, security, dev), operator, relay process.
- Adversary model: a confused or misbehaving agent in a role chat (primary),
  a local process running as the same OS user (secondary, out of full mitigation).

## Trust boundaries

1. MCP stdio channel ↔ relay HTTP (authenticated by per-role token).
2. Visible chat ↔ role channel (enforced by adapter conversationKey binding,
   fail-closed; host does NOT scope tools per conversation — see P1 research).
3. Relay process ↔ on-disk state (OS user boundary; not defended in v1).

## Threats and mitigations (P1.1 status)

| Threat                                      | Mitigation                                                                                            | Status          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------- |
| Agent calls another role's MCP channel      | Adapter binding UNAUTHORIZED + audit event                                                            | Done (P1.1)     |
| Role reads/acks foreign inbox or message    | RelayService UNAUTHORIZED + audit event                                                               | Done (P1.1)     |
| Reply into a thread not addressed to caller | NOT_FOUND (no existence leak) + audit                                                                 | Done (P1.1)     |
| Stolen role token                           | Full role impersonation — accepted residual risk in v1; rotation is an open question (P1 research §5) | Accepted        |
| Sender identity spoofing at relay           | Known gap: `requireParticipant` validates recipient only; fix deferred to protocol v1.1               | Open (v1.1)     |
| Audit log tampering                         | Same OS user can edit JSONL — detective, not preventive control                                       | Accepted        |
| Host shows all role channels in every chat  | Instruction + fail-closed adapter; host-side scoping requested upstream (P1.2)                        | Open (upstream) |

## Audit log

Append-only JSONL at `~/.synloq/data/<projectKey>-audit.jsonl`; one event per
controlled denial (`SynloqError`) with action, project, agentId, reasonCode.
Detective control: operator reviews on suspicion; no alerting in v1.

## Non-goals (v1)

Encryption, non-loopback transport, multi-relay federation, OS-user isolation.
```

- [ ] **Step 2: Review against protocol**

Run: `pnpm format:check`
Expected: PASS (or run `pnpm prettier --write docs/security/threat-model-2026-11-12.md` once if it complains, then re-check).

- [ ] **Step 3: Commit**

```bash
git add docs/security/threat-model-2026-11-12.md
git commit -m "docs: add threat model for relay security (P1.1)"
```

---

### Task 6: Final verification gate

- [ ] **Step 1: Full verify**

Run: `pnpm verify`
Expected: PASS — format, typecheck, full test suite (previously 51 files / 446 tests + new), build.

- [ ] **Step 2: Report**

Post RESULT to the originating Synloq thread with: commit list (`git log --oneline`), new test count, audit file location, and the explicit note that `requireParticipant` sender asymmetry remains open for v1.1.

## Self-Review Notes

- Spec coverage: deny-logging (Tasks 1–3), conformance tests (Task 4), threat model (Task 5) — all three P1.1 items covered; P1.2/P1.3 explicitly out of scope.
- Type consistency: `SecurityAuditLog.record`, `AuditedAction`, constructor param order `(participants, messages, sessions, protection, ids, clock, audit)` used identically across Tasks 1–4.
- Deliberate exclusions: no sender validation in `requireParticipant` (v1.1), no token rotation (open question), no MCP-tool access to the audit log.
