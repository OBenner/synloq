# Synloq Automatic Relay Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let generated role MCP processes automatically reuse or host exactly one compatible loopback relay, survive bounded owner failover, and remove manual `synloq serve` from the normal Kimi Work setup.

**Architecture:** A small supervisor probes the configured endpoint with the role credential before attempting an atomic listen. If the port is occupied, it rechecks authenticated project compatibility; an unrelated or ambiguous listener fails closed. MCP starts the supervisor before its host bridge, propagates the explicit Synloq home used during init, and closes only resources it owns.

**Tech Stack:** Node 24 HTTP, TypeScript 7, Zod 4, existing `serveCommand`, `RelayHttpClient`, SQLite stores, Vitest 5.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-11-11-kimi-work-visible-team-design.md` section 4.1.
- Only loopback HTTP URLs are accepted; initial configured endpoint is `http://127.0.0.1:4100`.
- Reuse an authenticated compatible relay. Never start a second relay because status is ambiguous.
- An unrelated listener, wrong project, invalid authentication, malformed response, or uncertain port state fails closed with a sanitized diagnostic.
- A competing process may start only after its own listen succeeds; ordinary Node exclusive port listen provides the election boundary.
- The same explicit `synloqHome` used by init reaches manifest paths, credential storage, and SQLite without relying on mutable global `process.env`.
- Relay starts before the Kimi Work adapter. MCP inbox remains available when the host adapter is unavailable, but not when relay startup fails closed.
- Failover never deletes or rewrites durable messages. Existing adapter state becomes `unknown` on transport failure; registrations receive new generations after reconnect.
- Do not add dependencies, change the six tools, commit, push, merge, kill unrelated processes, or weaken authentication without operator approval.

---

### Task 1: Relay supervisor reuse, ownership, and fail-closed election

**Files:**

- Create: `src/relay/supervisor.ts`
- Create: `test/relay/supervisor.test.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/config/paths.ts` only if the generic-init plan has not already added explicit home support

**Interfaces:**

- Consumes: `serveCommand(options): Promise<ServeHandle>` and authenticated `RelayHttpClient.listParticipants()`.
- Produces: `ensureRelay(options: EnsureRelayOptions): Promise<RelaySupervisorHandle>`.

- [ ] **Step 1: Write failing reuse and ownership tests**

Use ephemeral ports for most tests and inject `listen`/`probe` functions for deterministic election cases:

```ts
const existing = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
const reused = await ensureRelay({
  projectRoot: root,
  project: "example",
  relayUrl: existing.baseUrl,
  token,
  synloqHome: home,
});
expect(reused.baseUrl).toBe(existing.baseUrl);
expect(reused.owned).toBe(false);
await reused.close();
await expect(existing.listParticipants()).resolves.toBeDefined();

const owned = await ensureRelay({
  projectRoot: root,
  project: "example",
  relayUrl: unusedLoopbackUrl,
  token,
  synloqHome: home,
});
expect(owned.owned).toBe(true);
expect(owned.baseUrl).toBe(unusedLoopbackUrl);
```

Add cases for unrelated HTTP service, wrong project, wrong credential, malformed successful payload, timeout, non-loopback URL, and an `EADDRINUSE` race that becomes compatible on recheck. Assert every error is sanitized and no second listener is created for ambiguous status.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/relay/supervisor.test.ts`
Expected: FAIL because `supervisor.js` does not exist.

- [ ] **Step 3: Implement the supervisor**

Public contracts:

```ts
export interface EnsureRelayOptions {
  projectRoot: string;
  project: string;
  relayUrl: string;
  token: string;
  synloqHome?: string;
  probeTimeoutMs?: number;
  serve?: typeof serveCommand;
}

export interface RelaySupervisorHandle {
  baseUrl: string;
  owned: boolean;
  close(): Promise<void>;
}
```

Parse and require `http:`, hostname `127.0.0.1` or `::1`, an explicit numeric port, and no credentials, query, fragment, or non-root path. Probe `GET /v1/participants` with a short timeout. Accept only a response whose participants are non-empty and all match the configured project and whose authenticated identity is the configured role through the existing credential check.

If the probe fails with connection refused, call `serveCommand` on the same host/port. If listen throws `EADDRINUSE`, probe once more; reuse only a compatible relay, otherwise throw `SynloqError("INVALID_INPUT", "Synloq relay endpoint is occupied or incompatible")`. Do not classify authentication failure or malformed JSON as permission to listen. `close()` closes an owned `ServeHandle`; reused relay close is a no-op.

Extend `ServeOptions` and `CredentialStore`/`projectPaths` calls with optional `synloqHome`, preserving current defaults for all existing callers.

- [ ] **Step 4: Run GREEN and relay regression tests**

Run: `pnpm vitest run test/relay test/cli/commands.test.ts`
Expected: all supervisor and existing relay tests PASS.

- [ ] **Step 5: Review checkpoint**

Inspect tests for real credential output and verify that unrelated listeners remain running. Do not commit without approval.

---

### Task 2: Bounded failover without duplicate relay or durable-message loss

**Files:**

- Create: `src/relay/supervisor-loop.ts`
- Modify: `src/relay/supervisor.ts`
- Create: `test/relay/supervisor-loop.test.ts`

**Interfaces:**

- Consumes: `ensureRelay` from Task 1.
- Produces: `startRelaySupervisor(options): Promise<RelaySupervisorLoop>` with `client`, `close()`, and `closed` signal handling.
- Produces: `onOwnerLost?: () => void | Promise<void>` callback used by MCP to invalidate the host adapter before re-registration.

- [ ] **Step 1: Write failing failover tests**

Use two supervisor instances with short injected retry delays. Seed a durable message, close only the owner, and assert the survivor takes ownership on the same endpoint:

```ts
const first = await startRelaySupervisor({ ...options, retryDelayMs: 5 });
const second = await startRelaySupervisor({ ...options, retryDelayMs: 5 });
expect([first.owned, second.owned].filter(Boolean)).toHaveLength(1);
await first.close();
await vi.waitFor(() => expect(second.owned).toBe(true));
expect(await second.client.listParticipants()).toEqual({ participants });
expect(readMessage(second)).toEqual(originalMessage);
```

Also test simultaneous startup with injected barriers: exactly one `owned:true`; loser reuses the winner. Test permanent unrelated occupation after owner loss, bounded attempts, abort during backoff, idempotent close, and callback invocation before host restart. Do not assert SQLite session continuity; assert messages remain and new registration generations are required.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/relay/supervisor-loop.test.ts`
Expected: FAIL because the supervised reconnect loop does not exist.

- [ ] **Step 3: Implement bounded supervision**

Expose:

```ts
export interface RelaySupervisorLoop {
  readonly client: RelayHttpClient;
  readonly owned: boolean;
  close(): Promise<void>;
}

export interface StartRelaySupervisorOptions extends EnsureRelayOptions {
  retryDelayMs?: number;
  maxReconnectAttempts?: number;
  onOwnerLost?: () => void | Promise<void>;
}
```

Maintain one owned handle at most. When owned relay closes unexpectedly or authenticated probes fail after startup, invoke `onOwnerLost`, close the old owned handle, and run a bounded reconnect/election cycle with exponential delays capped at five seconds. Each iteration uses `ensureRelay`; compatible reuse wins over hosting. A refused connection permits an election attempt; all ambiguous statuses retain fail-closed behavior after the bounded cycle and emit only a sanitized diagnostic.

The supervisor does not reopen SQLite itself and never deletes the database. `close()` aborts sleep, prevents further election, closes only the currently owned handle, and is safe to call repeatedly.

- [ ] **Step 4: Run GREEN and race checks**

Run: `pnpm vitest run test/relay/supervisor.test.ts test/relay/supervisor-loop.test.ts`
Expected: all lifecycle tests PASS repeatedly with no leaked handles or timers.

- [ ] **Step 5: Review checkpoint**

Run the focused suite three times and inspect open handles. Do not commit without approval.

---

### Task 3: MCP integration and explicit home propagation

**Files:**

- Modify: `src/mcp/stdio.ts`
- Modify: `src/config/credentials.ts`
- Modify: `src/cli/commands.ts`
- Modify: `test/mcp/stdio.test.ts`
- Modify: `test/mcp/stdio-default-kimi-work.test.ts`
- Create: `test/mcp/stdio-relay-lifecycle.test.ts`

**Interfaces:**

- Consumes: `startRelaySupervisor` and generated `synloqHome` from generic init.
- Produces: strict optional MCP configuration fields `synloqHome?: string`, `projectRoot?: string`, `project?: string`; Kimi binding supplies root/project when standalone fields are absent.
- Produces: supervisor startup before `kimiWorkFactory`, and cleanup in reverse order.

- [ ] **Step 1: Write failing integration tests**

Assert ordering and exact propagation:

```ts
const events: string[] = [];
const relayFactory = vi.fn(async (options) => {
  events.push("relay");
  expect(options).toMatchObject({ projectRoot: root, project: "example", synloqHome: home });
  return fakeSupervisor;
});
const kimiWorkFactory = vi.fn(async () => {
  events.push("host");
  return fakeBridge;
});
await startMcpStdio(configPath, { relayFactory, kimiWorkFactory, ...streams });
await vi.waitFor(() => expect(events).toEqual(["relay", "host"]));
```

Write generated-style JSON with `synloqHome`, `relayUrl`, credential path, and `kimiWork`. Prove `CredentialStore` and `serveCommand` receive the same home without changing `process.env.SYNLOQ_HOME`. Test owner-loss ordering: runner closes/state becomes unknown before a new factory registration; shutdown closes host first and owned relay second. Existing configurations without lifecycle fields retain behavior by deriving project/root only when `kimiWork` exists or rejecting clearly when automatic startup was explicitly requested.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/mcp`
Expected: FAIL because relay lifecycle options and ordering are absent.

- [ ] **Step 3: Integrate without changing tool contracts**

Add injected `relayFactory` to `McpStdioOptions`, defaulting to `startRelaySupervisor`. Resolve project and canonical root from `kimiWork` plus `loadManifest`; avoid reading the token into diagnostics. Start and await relay reuse/ownership before calling `attachKimiWorkLifecycle`. Register the same six tools against the supervisor's client.

On owner loss, abort/close the current host bridge and allow the existing bounded host startup logic to construct a fresh adapter and registration after relay recovery. Never reuse an old generation. On server close, abort startup, close runner/adapter, await bounded cleanup, then close the supervisor. Keep failures sanitized and preserve six-tool inbox behavior when only Kimi host initialization fails.

- [ ] **Step 4: Run MCP and host regressions**

Run: `pnpm vitest run test/mcp test/adapters/kimi-work.test.ts test/adapters/kimi-work-integration.test.ts`
Expected: all tests PASS and no extra registration appears after successful startup.

- [ ] **Step 5: Review checkpoint**

Inspect shutdown ordering and explicit home propagation in the final diff. Do not commit without approval.

---

### Task 4: End-to-end automatic lifecycle and documentation

**Files:**

- Modify: `README.md`
- Create: `test/e2e/relay-lifecycle.test.ts`
- Create: `docs/superpowers/specs/2026-11-11-synloq-relay-lifecycle-acceptance.md`

**Interfaces:**

- Consumes: generic generated MCP configs and supervised relay.
- Produces: real loopback evidence that no standalone `synloq serve` is needed.

- [ ] **Step 1: Write a real end-to-end lifecycle test**

Create an isolated project/home, arbitrary roles, credential files, and two real MCP configurations on an unused explicit loopback port. Start real relay supervisors without a separate `serveCommand`; send/store a durable message; close the owner; verify the other instance owns or reuses exactly one endpoint and the message remains. Use real SQLite files under the temporary home and close every process/resource in `finally`.

- [ ] **Step 2: Run RED, then minimal fixes**

Run: `pnpm vitest run test/e2e/relay-lifecycle.test.ts`
Expected before integration fixes: FAIL on ownership/failover. Fix only lifecycle defects exposed by the test, then rerun until PASS. Do not relax assertions to hide duplicate listeners or lost messages.

- [ ] **Step 3: Replace the manual user flow**

Update README initialization to say that generated role MCP channels reuse or start the project relay automatically at `http://127.0.0.1:4100`. Keep `synloq serve` only as an advanced diagnostic/custom-host command. Document unrelated-port failure, bounded failover, and that host-delivery failure does not remove MCP inbox when relay is healthy.

- [ ] **Step 4: Run full verification**

Run: `pnpm verify`
Expected: format, typecheck, all tests, and build PASS; record exact test totals and any compatibility limits.

- [ ] **Step 5: Live two-role acceptance without manual relay**

Stop only the known development relay after confirming its ownership and preserving its database. With the updated source plugin installed, open the two test role channels and run a real `QUESTION`/`RESULT` cycle. Verify visible turns, exact thread IDs, actual-reading ack, no duplicate relay, and automatic recovery after closing the owning MCP process. Restore no messages manually and do not fabricate uncertain-send evidence.

- [ ] **Step 6: Record sanitized evidence and handoff**

Write observed commands/results, test totals, live message/thread identifiers where safe, failover observations, and unverified host/version boundaries. Remove the ignored host-inspection copy before any later commit. Only after full acceptance, delegate bounded next development tasks to the visible role chats. Do not commit, push, or hand off incomplete work as complete.
