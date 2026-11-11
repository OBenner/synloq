# Kimi Work Visible Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real Synloq messages as visible turns in the exact existing Kimi Work role chats, using the current CTO/Architect stand while keeping the implementation generic for arbitrary role IDs.

**Architecture:** Each generated role MCP configuration may contain a `kimiWork` binding. The existing MCP process starts a `KimiWorkAdapter` and `HttpAdapterRunner`; a strict authenticated WebSocket client calls the installed local-control API. The adapter reports fresh idle/busy state, submits only to the bound idle client conversation, reconciles ambiguous sends read-only, and never blindly retries a mutation.

**Tech Stack:** Node 24, TypeScript 7, Zod 4, `ws` 8, Vitest 5, existing Synloq relay/SQLite/MCP contracts.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-11-11-kimi-work-visible-team-design.md`.
- CTO and Architect are test data only; no role-specific conditional logic.
- Bind by exact `conversationKey`, never by chat title.
- Reuse the current relay at `http://127.0.0.1:4100`; automatic relay ownership is a later plan.
- Use `conversations.getMetadata`, `getBusy`, `getMessages`, and `send`; never use public CLI prompt resume, `setActive`, direct SQLite edits, or `wire.jsonl` edits.
- `delivered` means admitted as a visible user turn, not completion or acknowledgement. Never auto-ack.
- Register `clientIdempotency:false`; after an ambiguous send, reconcile read-only or quarantine. Never replay the mutation blindly.
- Keep credentials and the local-control token out of logs, errors, fixtures, Git, and receipts.
- Do not modify the managed plugin copy directly. Build source, update the source plugin, and use the supported plugin installation command.
- Preserve unrelated working-tree changes. Do not commit, push, merge, install additional dependencies beyond `ws` and `@types/ws`, or start a second Kimi daemon without explicit operator approval.
- Run the real required checks and report actual outcomes; controlled tests do not replace live visible acceptance.

---

### Task 1: Authenticated local-control endpoint discovery

**Files:**

- Create: `src/host/kimi-work/control-status.ts`
- Create: `test/host/kimi-work/control-status.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `KimiWorkControlEndpoint { url: string; token: string }`.
- Produces: `loadKimiWorkControlEndpoint(options?: KimiWorkStatusOptions): Promise<KimiWorkControlEndpoint>`.
- Produces: `KimiWorkStatusOptions { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exec?: typeof execFile }` for controlled tests.
- Consumes: the installed `status --json`; no production command-line token argument.

- [ ] **Step 1: Add the approved dependencies**

Run:

```bash
pnpm add ws@8
pnpm add --save-dev @types/ws@8
```

Expected: `package.json` contains runtime `ws` and development `@types/ws`; no other dependency is intentionally changed.

- [ ] **Step 2: Write failing status tests**

Create tests with a fake `exec` that captures `file`, `args`, `env`, `timeout`, and `maxBuffer`. Cover Windows standard paths, environment overrides, non-Windows `kimi-daimon`, loopback validation, empty token, malformed JSON, non-zero exit, oversized output, and token redaction. The core successful assertion is:

```ts
await expect(
  loadKimiWorkControlEndpoint({ environment: env, platform: "win32", exec: fake }),
).resolves.toEqual({ url: "ws://127.0.0.1:59262/control", token: "test-only-token" });
expect(fake.calls[0].args).toEqual([cliPath, "--config", configPath, "status", "--json"]);
expect(fake.calls[0].env.ELECTRON_RUN_AS_NODE).toBe("1");
expect(fake.calls[0].timeout).toBe(5_000);
expect(fake.calls[0].maxBuffer).toBe(1_048_576);
```

Reject `ws://example.com/control`, `http://127.0.0.1/control`, embedded URL credentials, and a missing token. Assert thrown messages do not contain `test-only-token`.

- [ ] **Step 3: Run the tests and confirm the failure**

Run: `pnpm vitest run test/host/kimi-work/control-status.test.ts`
Expected: FAIL because `control-status.js` does not exist.

- [ ] **Step 4: Implement strict discovery**

Use `execFile` without `shell`, a five-second timeout, and a 1 MiB buffer. Resolve Windows defaults from `LOCALAPPDATA` and `APPDATA`; allow `KIMI_WORK_EXECUTABLE`, `KIMI_WORK_CLI`, and `KIMI_WORK_CONFIG` overrides. On other platforms invoke `kimi-daimon` from `PATH`.

Decode only:

```ts
const statusSchema = z
  .object({
    control: z
      .object({
        endpoint: z
          .object({ url: z.string(), auth: z.object({ token: z.string().min(1) }).strict() })
          .strict(),
      })
      .strict(),
  })
  .passthrough();

function assertLoopbackWebSocket(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    url.username ||
    url.password ||
    !["127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  ) {
    throw new SynloqError(
      "INVALID_INPUT",
      "Kimi Work control endpoint is not a loopback WebSocket",
    );
  }
  return value;
}
```

On process/status failure throw one sanitized `SynloqError("NOT_FOUND", "Kimi Work local-control status is unavailable")`; retain no token-bearing stdout/stderr in the public error.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run test/host/kimi-work/control-status.test.ts`
Expected: all status tests PASS, with no real token printed.

---

### Task 2: Strict WebSocket JSON-RPC and typed conversation methods

**Files:**

- Create: `src/host/kimi-work/json-rpc.ts`
- Create: `src/host/kimi-work/control-client.ts`
- Create: `test/host/kimi-work/json-rpc.test.ts`
- Create: `test/host/kimi-work/control-client.test.ts`

**Interfaces:**

- Consumes: Task 1 `KimiWorkControlEndpoint`.
- Produces: `KimiWorkJsonRpcConnection.request<T>(method: string, params: object, schema: ZodType<T>, options?: { signal?: AbortSignal }): Promise<T>` and `close(): Promise<void>`.
- Produces: `KimiWorkControlClient` with `metadata()`, `busy()`, `messages()`, and `send()` using the exact parameter/result types below.
- Never automatically retries `conversations.send`; a later heartbeat request may establish a new socket.

- [ ] **Step 1: Write failing transport tests against a real local `WebSocketServer`**

Use an ephemeral `127.0.0.1` port. Verify the Bearer header, JSON-RPC 2.0 IDs, params, fragmented frames, notification skipping, malformed JSON, mismatched ID, remote error classification, 1 MiB payload limit, timeout, abort, close rejection, and no token in errors.

The successful server assertion is:

```ts
expect(request.headers.authorization).toBe("Bearer test-only-token");
expect(frame).toMatchObject({
  jsonrpc: "2.0",
  id: 1,
  method: "conversations.getBusy",
  params: { conversationKey: boundConversationKey },
});
```

For a remote error, expose only:

```ts
class KimiWorkRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    readonly reasonCode?: string,
  ) {
    super(`Kimi Work RPC failed with code ${rpcCode}`);
  }
}
```

Allowlist `reasonCode` to `/^[A-Z][A-Z0-9_]{0,63}$/`; do not copy remote `message`, response bodies, or headers.

- [ ] **Step 2: Run transport tests and confirm the failure**

Run: `pnpm vitest run test/host/kimi-work/json-rpc.test.ts`
Expected: FAIL because the transport module does not exist.

- [ ] **Step 3: Implement the transport**

Use `WebSocket` from `ws` with `headers: { Authorization: `Bearer ${endpoint.token}` }`, `maxPayload: 1_048_576`, one serialized connection attempt, and a monotonically increasing numeric request ID. Keep pending requests in a map. Each request gets a five-second timer and abort listener; settlement removes both. Ignore notifications. Reject all pending requests on socket close/error. `close()` removes listeners, rejects pending calls, closes the socket, and resolves after the close event or a bounded timeout.

Do not implement reconnect inside `request()`: a mutation that was written to a socket and lost has an uncertain outcome. The adapter's next independent read may call the endpoint provider and construct a new connection.

- [ ] **Step 4: Write failing typed-client tests**

Define the exact contracts:

```ts
interface KimiWorkBinding {
  workAgentId: string;
  conversationKey: string;
  sessionKey: string;
  workspacePath: string;
  kernelSessionId?: string;
}

interface KimiWorkMetadata {
  conversationKey: string;
  sessionKey: string;
  kernelSessionId?: string;
  origin: string;
  workspacePath: string;
}

interface KimiWorkHistoryEntry {
  id: string;
  turnId?: string;
  role: string;
  status: string;
  text: string;
}

interface KimiWorkSendResult {
  conversationKey: string;
  kernelSessionId: string;
  turnId: string;
  accepted: true;
}
```

Methods:

```ts
metadata(binding: KimiWorkBinding): Promise<KimiWorkMetadata>;
busy(binding: KimiWorkBinding): Promise<boolean>;
messages(binding: KimiWorkBinding, limit?: number): Promise<KimiWorkHistoryEntry[]>;
send(binding: KimiWorkBinding, text: string, signal?: AbortSignal): Promise<KimiWorkSendResult>;
```

`metadata()` sends `{ agentId, key: conversationKey }`; `busy()` sends `{ conversationKey }`; `messages()` sends `{ agentId, conversationKey, limit }`; `send()` sends `{ agentId, conversationKey, text }`. Decode `messages[].parts` and concatenate only parts with `kind:"text"`. Require `accepted:true`, exact conversation key, non-empty turn ID, and matching kernel session when the binding includes one.

- [ ] **Step 5: Implement the typed client and run both suites**

Use strict Zod schemas with `.passthrough()` only at the outer host envelope where forward-compatible extra metadata is harmless. Nested identity and message fields remain required and type-checked.

Run: `pnpm vitest run test/host/kimi-work/json-rpc.test.ts test/host/kimi-work/control-client.test.ts`
Expected: all transport and typed-client tests PASS.

---

### Task 3: Generic binding configuration and pure delivery helpers

**Files:**

- Create: `src/host/kimi-work/binding.ts`
- Create: `src/host/kimi-work/prompt.ts`
- Modify: `src/mcp/stdio.ts`
- Create: `test/host/kimi-work/binding.test.ts`
- Create: `test/host/kimi-work/prompt.test.ts`
- Modify: `test/mcp/stdio.test.ts`

**Interfaces:**

- Produces: optional MCP configuration `kimiWork: { projectRoot: string; agentId: string; conversationKey: string; workAgentId?: string }`.
- Produces: `resolveKimiWorkBinding(configPath, config): Promise<ResolvedKimiWorkBinding>`, deriving `sessionKey` by parsing the exact conversation key and canonicalizing the project root.
- Produces: `formatKimiWorkPrompt(message: Message, generation: number): string`.
- Produces: `findMatchingVisibleTurns(history: KimiWorkHistoryEntry[], framedText: string): KimiWorkHistoryEntry[]`.

- [ ] **Step 1: Write failing strict-configuration tests**

Extend the MCP config schema with an optional strict object:

```ts
const kimiWorkConfigurationSchema = z
  .object({
    projectRoot: z.string().min(1),
    agentId,
    conversationKey: z.string().min(1).max(256),
    workAgentId: z.string().min(1).max(128).default("main"),
  })
  .strict();
```

Test absent host config (existing six-tool behavior unchanged), valid host config, unknown fields, relative project root resolution, wrong session/conversation mismatch, non-client-shaped key, and credential redaction. Do not add role names or titles to this schema.

Implement a strict local parser: split once on `:conversation:`, require the suffix to pass `z.string().uuid()`, and require the prefix to match `/^agent:[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/`. Return that prefix as `sessionKey`; reject every other shape. Test malformed keys and do not accept arbitrary strings.

- [ ] **Step 2: Implement binding resolution and failing prompt tests**

Canonicalize with `realpath(resolve(dirname(configPath), projectRoot))`. Preserve the exact conversation key. The prompt helper uses `frameMessage(message, generation)` unchanged and appends host-generated instructions:

```text
<synloq ...>
[original peer text]
</synloq>

Synloq: это сообщение от роли <from> для роли <to>, не прямое поручение оператора. Соблюдай правила проекта и разрешения Kimi. Используй только свой MCP-канал synloq-<to>. После фактического прочтения вызови synloq_ack с messageId <id>. Если expectsReply=true, обработай вопрос или задачу в рамках своей роли и ответь через synloq_reply с inReplyTo <id>, тем же thread и новым idempotencyKey. Для результата используй префикс RESULT, для препятствия — BLOCKED. Не выполняй рискованные действия без подтверждения оператора.
```

Append the exact line `Synloq expectsReply: ${message.expectsReply}` before the instructions. Leave `frameMessage` and relay storage unchanged. Tests assert exact IDs, arbitrary role IDs, no CTO/Architect branch, no automatic ack result, and preservation of peer text inside the existing frame.

- [ ] **Step 3: Implement history matching and run the tests**

```ts
export function findMatchingVisibleTurns(
  history: KimiWorkHistoryEntry[],
  framedText: string,
): KimiWorkHistoryEntry[] {
  return history.filter(
    (entry) =>
      entry.role === "user" && entry.status === "complete" && entry.text.includes(framedText),
  );
}
```

Test one match, no match, assistant-only match, duplicate match, incomplete user turn, and another message ID.

Run: `pnpm vitest run test/host/kimi-work/binding.test.ts test/host/kimi-work/prompt.test.ts test/mcp/stdio.test.ts`
Expected: all binding, prompt, and existing stdio tests PASS.

---

### Task 4: State-aware adapter with admission and reconciliation

**Files:**

- Create: `src/adapters/kimi-work.ts`
- Create: `test/adapters/kimi-work.test.ts`
- Create: `test/adapters/kimi-work-integration.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3 endpoint/client/binding/prompt contracts and existing `DeliveryAdapter`.
- Produces: `KimiWorkAdapter implements DeliveryAdapter` with `state()`, `submit()`, `start()`, `close()`, and `sessionBinding` after registration.
- Produces: `runKimiWorkAdapter(options, relay, clients?): Promise<KimiWorkAdapter>` for MCP lifecycle composition.

- [ ] **Step 1: Write failing state and registration tests**

Use fake control clients and a real relay test fixture. Verify:

- exact metadata + `busy:false` → `idle`;
- `busy:true` → `busy`;
- wrong workspace/origin/session/conversation/kernel identity → no registration and no send;
- stale idle older than 5 seconds → `unknown`;
- transport failure → `unknown` and bounded reconnect backoff;
- close → `closed`, heartbeat stops, only the Synloq registration closes.

Capabilities after successful binding are exactly:

```ts
{ activeDelivery: true, stateReporting: true, clientIdempotency: false }
```

Registration uses `sessionId: conversationKey`, `protocolVersion: PROTOCOL_VERSION`, and verifies returned project/role/session identity before starting the runner.

- [ ] **Step 2: Implement heartbeat and state**

Follow the existing OpenCode pattern: `STATE_FRESHNESS_MS = 5_000`, default heartbeat 1 second, bounded 200 ms–30 second backoff, serialized `reportQueue`, and one abort controller. Each refresh obtains metadata and busy state before calling `relay.heartbeat`. A failed refresh observes `unknown`; it does not fabricate idle from the last successful response.

- [ ] **Step 3: Write failing submission tests**

Cover exact prompt/admission, memoized success, immediate fresh-idle check, wrong session, definite busy RPC, one-match timeout reconciliation, zero/multiple-match quarantine, malformed accepted result, restart with ambiguous prior submission, and no automatic acknowledgement.

The accepted receipt assertion is:

```ts
await expect(adapter.submit(binding.conversationKey, message, { generation: 3 })).resolves.toEqual({
  state: "delivered",
  clientMessageId: "work-turn-uuid",
});
expect(client.send).toHaveBeenCalledWith(
  binding,
  formatKimiWorkPrompt(message, 3),
  expect.anything(),
);
expect(relay.acknowledge).not.toHaveBeenCalled();
```

- [ ] **Step 4: Implement one-shot submission and reconciliation**

Submission order:

1. Return a memoized receipt for the same Synloq message ID.
2. Reject a wrong session or non-fresh idle before mutation.
3. Read recent history and return exactly one existing match; multiple matches mean `DELIVERY_UNCERTAIN`.
4. Revalidate metadata and `busy:false` immediately before send.
5. Call `send` exactly once with the complete Kimi Work prompt and the caller's abort signal.
6. Validate the accepted response and memoize the host turn ID as `clientMessageId`.
7. On definite pre-admission busy (`reasonCode === "CONVERSATION_BUSY"` or the installed operation-busy equivalent established by a controlled test), throw retryable `INVALID_INPUT` without another send.
8. On any other send error, perform at most three read-only history reads, 100 ms apart, abort-aware. Exactly one complete matching user turn returns a delivered receipt using `history.id`; otherwise throw `SynloqError("DELIVERY_UNCERTAIN", ...)` and do not send again.

The `HttpAdapterRunner` must report delivered receipts and quarantine ambiguous failures through the existing relay paths. Do not add a retry around step 5.

- [ ] **Step 5: Run adapter and existing runner tests**

Run: `pnpm vitest run test/adapters/kimi-work.test.ts test/adapters/kimi-work-integration.test.ts test/adapters/http-runner.test.ts test/adapters/http-runner-integration.test.ts`
Expected: all new and existing runner/adapter tests PASS.

---

### Task 5: MCP lifecycle integration and current two-role stand

**Files:**

- Modify: `src/mcp/stdio.ts`
- Modify: `test/mcp/stdio.test.ts`
- Modify: `.synloq/runtime/kimi-debug/mcp/cto.json` (local untracked configuration)
- Modify: `.synloq/runtime/kimi-debug/mcp/arch.json` (local untracked configuration)
- Modify: `.synloq/runtime/plugin-sources/personal/synloq/kimi.plugin.json`
- Modify: `.synloq/runtime/plugin-sources/personal/synloq/skills/synloq/SKILL.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: Task 4 `runKimiWorkAdapter` and existing `HttpAdapterRunner`.
- Preserves: `startMcpStdio(configPath, options): Promise<McpServer>` and all six MCP tools.
- Produces: role MCP lifecycle that closes runner, adapter, and registration without closing Kimi Work.

- [ ] **Step 1: Write failing MCP composition tests**

Inject a `kimiWorkFactory` through `McpStdioOptions`; do not let unit tests discover the real host. Verify startup registers the exact binding, starts one runner, serves the same six tools, and closing `server.server` closes the runner/adapter once. Simulate host startup failure and assert MCP inbox still starts with one sanitized diagnostic. Add an abort-aware startup retry with bounded backoff; no retry is allowed to create another registration after success.

The returned MCP server remains the existing type. Keep the running bridge in a closure and install `server.server.onclose` cleanup.

- [ ] **Step 2: Implement MCP lifecycle**

After connecting the MCP transport, start host initialization in a supervised async task. On success construct one `HttpAdapterRunner` using the registered `sessionBinding`, start it, and retain its close function. On close, abort startup/reconnect, close runner then adapter, and await bounded cleanup. Diagnostics contain only the conversation key and state, never tokens or message bodies.

Run: `pnpm vitest run test/mcp/stdio.test.ts test/adapters/kimi-work-integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Bind the existing local example**

Add this exact block to the local untracked CTO JSON, without changing its credential:

```json
"kimiWork": {
  "projectRoot": "I:\\git\\Synloq",
  "agentId": "cto",
  "conversationKey": "agent:main:main:conversation:02ffbece-ba58-4e17-8c52-acf9615c9ccb",
  "workAgentId": "main"
}
```

Add this exact block to the local untracked Architect JSON:

```json
"kimiWork": {
  "projectRoot": "I:\\git\\Synloq",
  "agentId": "arch",
  "conversationKey": "agent:main:main:conversation:d7be2b2c-edfc-4fc7-a010-1e7af6465138",
  "workAgentId": "main"
}
```

These are local stand bindings, not production role constants.

- [ ] **Step 4: Update user-facing instructions**

Remove the claim that the stand is inbox-only. Document that visible incoming messages are processed in the target chat, `delivered` is not completion, ack follows actual reading, replies use the original thread, and risky actions require operator approval. Keep the instruction to use only the role's own MCP channel.

Bump the local plugin version to `0.1.0+local.20261111-visible1`. Build and install through the supported `kimi-plugin install` path used for the existing personal plugin; do not edit the managed copy manually. Record the real install result and whether Kimi Work requires reload.

- [ ] **Step 5: Run formatting and full gates**

Format only files owned by this plan, then run all gates:

```bash
pnpm exec prettier --write src/host/kimi-work src/adapters/kimi-work.ts src/mcp/stdio.ts test/host/kimi-work test/adapters/kimi-work.test.ts test/adapters/kimi-work-integration.test.ts test/mcp/stdio.test.ts docs/superpowers/plans/2026-11-11-kimi-work-visible-delivery.md README.md package.json
pnpm verify
```

Expected: formatting, typecheck, all tests, and build PASS. Report exact test-file/test totals and any pre-existing unrelated failure rather than hiding it.

---

### Task 6: Live visible acceptance and handoff

**Files:**

- Modify: `README.md` with only verified support status and exact setup/reload notes.
- Create: `docs/superpowers/specs/2026-11-11-kimi-work-live-acceptance.md` with sanitized observed evidence.

**Interfaces:**

- Consumes: the built and installed Task 5 plugin and existing relay.
- Produces: verified or explicitly failed live matrix; no unsupported compatibility claim.

- [ ] **Step 1: Verify transport before sending**

Run a read-only metadata/busy check for both bound chats. Expected: exact client conversations, `I:\git\Synloq` workspace, and fresh state. If busy, wait for idle; do not send a steering turn.

- [ ] **Step 2: Send one real Synloq question through the CTO credential**

Use `synloq_send` to `arch` with unique idempotency key `kimi-work-visible-adapter-1` and:

```text
[QUESTION]
Проверка видимой доставки Synloq. Ответь в этом thread через synloq_reply префиксом RESULT и укажи реальный message ID исходного сообщения. Ничего не изменяй в коде.
```

Expected relay result: a new Synloq message ID/thread ID. Do not treat its initial `stored` state as the final evidence.

- [ ] **Step 3: Verify the visible Architect turn and response**

Observe through host metadata/messages and the operator UI. Expected: one framed user turn in Architect, actual reading/ack by the receiving agent, and one `RESULT` reply in the same thread. Record message IDs, host turn/history ID, delivery transitions, and real response. If the agent does not act autonomously, fix the generated prompt/instructions through TDD before sending a new unique acceptance message; never duplicate the ambiguous original.

- [ ] **Step 4: Verify duplicate and busy behavior**

Repeat the CTO send with the same idempotency key/content. Expected: original Synloq message ID and no second visible turn. While Architect is busy, send a different controlled message and verify no steering; after idle, exactly one visible admission occurs. Induce a controlled uncertain case using the automated fake for code-level proof; do not intentionally corrupt the real Kimi database or force an uncontrolled duplicate in the user's chat.

- [ ] **Step 5: Record evidence and hand off**

Write only sanitized IDs, timestamps, transitions, host surface, checks, and limitations. State that arbitrary-role init, automatic relay lifecycle, hop-limit enforcement, other Kimi versions, and host-enforced per-chat MCP isolation are not completed by this plan.

Give CTO and Architect their next bounded tasks in separate Synloq threads:

- Architect: review the design and implementation for binding, lifecycle, duplicate prevention, and security; return `RESULT` with concrete findings and executed checks.
- CTO: own the next generic-init plan and coordination sequence after Architect's review; do not start unrelated host adapters.

Expected: both receive real visible Synloq turns. Their subsequent claims require the same evidence standard as any other agent claim.
