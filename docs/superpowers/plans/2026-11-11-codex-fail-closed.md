# Codex Fail-Closed Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated Codex MCP inbox setup, generation-aware lifecycle state reporting, and a read-only app-server compatibility probe without claiming or enabling active delivery.

**Architecture:** Reuse the existing Synloq MCP stdio and HTTP relay boundaries. A strict Codex hook command registers and heartbeats the exact visible `session_id`; a separate Node 24 probe collects app-server metadata and explicitly opted-in read-only thread evidence. No Codex process is launched by the relay and no prompt or turn method is used.

**Tech Stack:** Node 24, TypeScript strict mode, Zod 4, Node child_process/streams, Vitest, Prettier, pnpm.

## Global Constraints

- Follow `docs/superpowers/specs/2026-11-11-codex-adapter-design.md` exactly.
- `activeDelivery` is always `false`; no production activation flag is added.
- Never call `turn/start`, `turn/steer`, `codex exec`, or another prompt/submission method.
- Never create a hidden replacement chat or parse transcript files as a delivery interface.
- Do not use hook `additionalContext` as a message-delivery channel.
- One Codex configuration scope represents one Synloq role; shared Desktop multi-role binding remains unverified.
- Hook stdin is limited to 64 KiB before JSON parsing or relay activity.
- Probe process/request phases default to 5000 ms; retained JSON-RPC frames are capped at 1 MiB; stderr is drained.
- Credentials, prompts, message bodies, account tokens, full transcripts, runtime databases, and probe evidence are not committed.
- No new dependency, package, push, merge, publication workflow, or unrelated refactor.
- Run tests before each implementation step and require the stated RED failure; run the same tests GREEN afterward.
- Format only explicitly touched paths. Do not stage Windows line-ending-only status entries or `.superpowers` reports.

## File map

| File                                   | Responsibility                                                         |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `src/config/adapter.ts`                | Strict `kind: "codex"` external configuration                          |
| `src/adapters/codex-state.ts`          | Pure Codex event/source to Synloq state mapping                        |
| `src/cli/codex-hook.ts`                | Bounded hook input, exact-session registration and heartbeat           |
| `src/cli/adapter.ts`                   | Codex standalone hook composition and explicit active-runner rejection |
| `src/cli/main.ts`                      | `codex-hook --config` public CLI routing                               |
| `scripts/codex-app-server/json-rpc.ts` | Bounded NDJSON JSON-RPC transport and child cleanup                    |
| `scripts/probe-codex-app-server.ts`    | Metadata commands, read-only probe report and CLI                      |
| `test/config/adapter.test.ts`          | Codex configuration and fail-closed runner tests                       |
| `test/adapters/codex-state.test.ts`    | State mapper unit tests                                                |
| `test/cli/codex-hook.test.ts`          | Hook, registration, input-limit and CLI tests                          |
| `test/adapters/codex-probe.test.ts`    | Fake-process transport and no-submission probe tests                   |
| `README.md`                            | One-role Codex MCP/hook/probe operator setup                           |
| `docs/client-compatibility.md`         | Honest Codex support and live acceptance matrix                        |
| `test/e2e/real-clients.md`             | Executable manual evidence procedure                                   |

---

### Task 1: Strict Codex configuration

**Files:**

- Modify: `src/config/adapter.ts`
- Modify: `src/cli/adapter.ts`
- Test: `test/config/adapter.test.ts`

**Interfaces:**

- Consumes: existing `loadAdapterConfiguration(configPath)` and `startStandaloneAdapter(configPath)`.
- Produces: `StandaloneAdapterConfiguration` includes a Codex variant with the existing common fields and no activation fields.

- [ ] **Step 1: Write the failing configuration tests**

Append to `test/config/adapter.test.ts`:

```ts
it("loads a strict Codex hook configuration without activation fields", async () => {
  await writeConfiguration({ ...validConfiguration(), kind: "codex" });

  const loaded = await loadAdapterConfiguration(configPath);
  expect(loaded.configuration).toMatchObject({
    kind: "codex",
    project: "verdicta",
    agentId: "cto",
    sessionId: "claude-visible-cto",
    protocolVersion: 1,
  });
  expect(loaded.configuration).not.toHaveProperty("activationVerifiedAt");
  expect(loaded.configuration).not.toHaveProperty("acceptanceMessageId");
});

it("rejects Codex in the generic active adapter runner", async () => {
  const { startStandaloneAdapter } = await import("../../src/cli/adapter.js");
  await writeConfiguration({ ...validConfiguration(), kind: "codex" });

  await expect(startStandaloneAdapter(configPath)).rejects.toMatchObject({
    code: "INVALID_INPUT",
    message: "Codex active delivery is unsupported; use codex-hook and MCP inbox",
  });
});

it.each(["activationVerifiedAt", "acceptanceMessageId"])(
  "rejects a Codex %s field",
  async (field) => {
    await writeConfiguration({
      ...validConfiguration(),
      kind: "codex",
      [field]:
        field === "acceptanceMessageId"
          ? "69d2065f-46a4-4b2f-9482-f9a64f349e26"
          : "2026-11-11T00:00:00.000Z",
    });
    await expect(loadAdapterConfiguration(configPath)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  },
);
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `pnpm vitest run test/config/adapter.test.ts`

Expected: FAIL because `kind: "codex"` does not match the configuration union.

- [ ] **Step 3: Add the minimal Codex schema and runner rejection**

In `src/config/adapter.ts`, add beside `openCodeSchema`:

```ts
const codexSchema = z
  .object({
    ...commonFields,
    kind: z.literal("codex"),
  })
  .strict();
```

Change the union to:

```ts
const configurationSchema = z.union([claudeSchema, openCodeSchema, codexSchema]);
```

In `startStandaloneAdapter` in `src/cli/adapter.ts`, immediately after the OpenCode branch add:

```ts
if (configuration.kind === "codex") {
  throw new SynloqError(
    "INVALID_INPUT",
    "Codex active delivery is unsupported; use codex-hook and MCP inbox",
  );
}
```

The remaining branch is now narrowed to Claude; do not add a Codex `HttpAdapterRunner`.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `pnpm vitest run test/config/adapter.test.ts test/cli/standalone-adapter.test.ts`

Expected: PASS; existing Claude and OpenCode configuration behavior is unchanged.

- [ ] **Step 5: Commit Task 1**

```bash
git add -- src/config/adapter.ts src/cli/adapter.ts test/config/adapter.test.ts
git commit -m "feat: add strict Codex hook configuration"
```

---

### Task 2: Pure Codex lifecycle state mapper

**Files:**

- Create: `src/adapters/codex-state.ts`
- Test: `test/adapters/codex-state.test.ts`

**Interfaces:**

- Consumes: `SessionState` from `src/domain/session.ts`.
- Produces: `mapCodexHook(event: string, source?: string): SessionState` for the hook command.

- [ ] **Step 1: Write the failing mapper tests**

Create `test/adapters/codex-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapCodexHook } from "../../src/adapters/codex-state.js";

describe("Codex hook state mapping", () => {
  it.each(["startup", "resume", "clear", "fork"])(
    "maps SessionStart source %s to idle",
    (source) => {
      expect(mapCodexHook("SessionStart", source)).toBe("idle");
    },
  );

  it("does not treat compact mid-turn startup as idle", () => {
    expect(mapCodexHook("SessionStart", "compact")).toBe("busy");
  });

  it.each([
    ["UserPromptSubmit", "busy"],
    ["PreModelRequest", "busy"],
    ["Stop", "idle"],
    ["Interrupt", "unknown"],
    ["SessionEnd", "closed"],
    ["PostModelRequest", "unknown"],
    ["SubagentStop", "unknown"],
    ["PreToolUse", "unknown"],
  ] as const)("maps %s to %s", (event, expected) => {
    expect(mapCodexHook(event)).toBe(expected);
  });

  it("fails closed for an unknown start source or event", () => {
    expect(mapCodexHook("SessionStart", "unexpected")).toBe("unknown");
    expect(mapCodexHook("SessionStart")).toBe("unknown");
    expect(mapCodexHook("UnexpectedEvent")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the mapper test to verify RED**

Run: `pnpm vitest run test/adapters/codex-state.test.ts`

Expected: FAIL to resolve `../../src/adapters/codex-state.js`.

- [ ] **Step 3: Implement the pure mapper**

Create `src/adapters/codex-state.ts`:

```ts
import type { SessionState } from "../domain/session.js";

export function mapCodexHook(event: string, source?: string): SessionState {
  if (event === "SessionStart") {
    if (source === "startup" || source === "resume" || source === "clear" || source === "fork") {
      return "idle";
    }
    return source === "compact" ? "busy" : "unknown";
  }
  if (event === "UserPromptSubmit" || event === "PreModelRequest") return "busy";
  if (event === "Stop") return "idle";
  if (event === "SessionEnd") return "closed";
  return "unknown";
}
```

`Interrupt` intentionally reaches the final `unknown` result.

- [ ] **Step 4: Run the mapper test to verify GREEN**

Run: `pnpm vitest run test/adapters/codex-state.test.ts test/adapters/claude-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add -- src/adapters/codex-state.ts test/adapters/codex-state.test.ts
git commit -m "feat: map Codex lifecycle state fail closed"
```

---

### Task 3: Codex hook composition and public CLI

**Files:**

- Create: `src/cli/codex-hook.ts`
- Modify: `src/cli/adapter.ts`
- Modify: `src/cli/main.ts`
- Test: `test/cli/codex-hook.test.ts`
- Modify: `test/cli/standalone-adapter.test.ts`

**Interfaces:**

- Consumes: `mapCodexHook`, `RelayHttpClient.registerSession`, `RelayHttpClient.heartbeat`, strict Codex configuration.
- Produces: `runCodexHook(client, config, io)`, `runStandaloneCodexHook(configPath, io)`, and `synloq codex-hook --config <path>`.

- [ ] **Step 1: Write failing hook and CLI tests**

Create `test/cli/codex-hook.test.ts` with a mocked relay:

```ts
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCodexHook } from "../../src/cli/codex-hook.js";
import { runMain, type CliIo } from "../../src/cli/main.js";
import { PROTOCOL_VERSION } from "../../src/domain/session.js";
import type { RelayHttpClient } from "../../src/transport/http-client.js";

const config = { project: "verdicta", agentId: "cto", sessionId: "codex-thread-1" };

function fakeClient() {
  const session = {
    project: config.project,
    agentId: config.agentId,
    sessionId: config.sessionId,
    generation: 3,
  };
  const registerSession = vi.fn().mockResolvedValue({ session });
  const heartbeat = vi.fn().mockResolvedValue({ session });
  return {
    registerSession,
    heartbeat,
    client: { registerSession, heartbeat } as unknown as RelayHttpClient,
  };
}

async function invoke(client: RelayHttpClient, input: string | Record<string, unknown>) {
  let stdout = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += String(chunk);
      callback();
    },
  });
  await runCodexHook(client, config, {
    stdin: Readable.from([typeof input === "string" ? input : JSON.stringify(input)]),
    stdout: output,
  });
  return stdout;
}

describe("Codex hook", () => {
  it("registers inactive state reporting and then heartbeats SessionStart", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    const stdout = await invoke(client, {
      session_id: config.sessionId,
      hook_event_name: "SessionStart",
      source: "startup",
    });

    expect(registerSession).toHaveBeenCalledWith({
      sessionId: config.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { activeDelivery: false, stateReporting: true, clientIdempotency: false },
    });
    expect(heartbeat).toHaveBeenCalledWith({ sessionId: config.sessionId, state: "idle" });
    expect(stdout).toBe("");
  });

  it("does not register later events and maps PreModelRequest to busy", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await invoke(client, {
      session_id: config.sessionId,
      hook_event_name: "PreModelRequest",
    });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith({ sessionId: config.sessionId, state: "busy" });
  });

  it("rejects another visible session before any relay mutation", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await expect(
      invoke(client, {
        session_id: "another-thread",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it("rejects oversized input before parsing or relay activity", async () => {
    const { client, registerSession, heartbeat } = fakeClient();
    await expect(invoke(client, " ".repeat(64 * 1024 + 1))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(registerSession).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
  });
});

describe("Codex hook CLI", () => {
  it("prints help and invokes its own dependency without protocol stdout", async () => {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: {
        write(chunk) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += chunk;
          return true;
        },
      },
    };
    await expect(runMain(["codex-hook", "--help"], io)).resolves.toBe(0);
    expect(stdout).toBe("Usage: synloq codex-hook --config <path>\n");

    stdout = "";
    const runCodexHook = vi.fn().mockResolvedValue(undefined);
    await expect(
      runMain(["codex-hook", "--config", "/tmp/codex.json"], io, {
        runCodexHook,
      }),
    ).resolves.toBe(0);
    expect(runCodexHook).toHaveBeenCalledWith("/tmp/codex.json");
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
```

In `test/cli/standalone-adapter.test.ts`, change the help `it.each` array to `["adapter", "claude-hook", "codex-hook"]`.

- [ ] **Step 2: Run the hook tests to verify RED**

Run: `pnpm vitest run test/cli/codex-hook.test.ts test/cli/standalone-adapter.test.ts`

Expected: FAIL to resolve `src/cli/codex-hook.js`; the new CLI help case is also unrecognized.

- [ ] **Step 3: Implement bounded hook processing**

Create `src/cli/codex-hook.ts`:

```ts
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { mapCodexHook } from "../adapters/codex-state.js";
import { SynloqError } from "../domain/errors.js";
import { PROTOCOL_VERSION } from "../domain/session.js";
import type { RelayHttpClient } from "../transport/http-client.js";

const MAX_HOOK_BYTES = 64 * 1024;
const hookSchema = z
  .object({
    session_id: z.string().min(1),
    hook_event_name: z.string().min(1),
    source: z.string().optional(),
  })
  .passthrough();

export interface CodexHookConfig {
  project: string;
  agentId: string;
  sessionId: string;
}

export interface CodexHookIo {
  stdin?: Readable;
  stdout?: Writable;
}

async function readInput(input: Readable): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let source = "";
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    bytes += buffer.byteLength;
    if (bytes > MAX_HOOK_BYTES) {
      throw new SynloqError("INVALID_INPUT", "Codex hook input exceeds 65536 bytes");
    }
    source += decoder.write(buffer);
  }
  return source + decoder.end();
}

export async function runCodexHook(
  client: RelayHttpClient,
  config: CodexHookConfig,
  io: CodexHookIo = {},
): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readInput(io.stdin ?? process.stdin));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SynloqError("INVALID_INPUT", "Codex hook contains malformed JSON");
    }
    throw error;
  }
  const hook = hookSchema.parse(input);
  if (hook.session_id !== config.sessionId) {
    throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
  }

  const state = mapCodexHook(hook.hook_event_name, hook.source);
  if (hook.hook_event_name === "SessionStart") {
    const { session } = await client.registerSession({
      sessionId: hook.session_id,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { activeDelivery: false, stateReporting: true, clientIdempotency: false },
    });
    if (
      session.project !== config.project ||
      session.agentId !== config.agentId ||
      session.sessionId !== config.sessionId
    ) {
      throw new SynloqError("UNAUTHORIZED", "registered session does not match Codex binding");
    }
  }
  await client.heartbeat({ sessionId: hook.session_id, state });
}
```

No call to `io.stdout`, `receipt`, `nextDelivery`, or `additionalContext` is added.

- [ ] **Step 4: Compose the standalone hook and CLI route**

Add to `src/cli/adapter.ts` an import of `runCodexHook` and `CodexHookIo`, then export:

```ts
export async function runStandaloneCodexHook(
  configPath: string,
  io: CodexHookIo = {},
): Promise<void> {
  const loaded = await loadAdapterConfiguration(configPath);
  const { configuration } = loaded;
  if (configuration.kind !== "codex") {
    throw new SynloqError("INVALID_INPUT", "Codex hooks require a Codex adapter configuration");
  }
  const relay = new RelayHttpClient(configuration.relayUrl, () => loaded.token);
  await runCodexHook(relay, configuration, io);
}
```

In `src/cli/main.ts`:

- import `runStandaloneCodexHook` from `./adapter.js`;
- add `runCodexHook?: (configPath: string) => Promise<void>` to `MainDependencies`;
- add `"codex-hook"` immediately after `"claude-hook"` in `commandNames`;
- add `"codex-hook": "Usage: synloq codex-hook --config <path>\n"` to `helpText`;
- add a branch beside the Claude hook branch:

```ts
if (command === "codex-hook") {
  const { values } = parse(command, args, { config: { type: "string" } });
  if (value(values, "help")) {
    io.stdout.write(helpText[command]);
    return;
  }
  await (dependencies.runCodexHook ?? runStandaloneCodexHook)(requiredString(values, "config"));
  return;
}
```

Do not import `CodexHookIo` into `main.ts` because the dependency uses only the config path.

- [ ] **Step 5: Run hook, CLI, configuration and type checks**

Run: `pnpm vitest run test/cli/codex-hook.test.ts test/cli/standalone-adapter.test.ts test/config/adapter.test.ts && pnpm typecheck`

Expected: PASS and TypeScript exit 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add -- src/cli/codex-hook.ts src/cli/adapter.ts src/cli/main.ts test/cli/codex-hook.test.ts test/cli/standalone-adapter.test.ts
git commit -m "feat: add Codex lifecycle hook bridge"
```

---

### Task 4: Bounded app-server JSON-RPC transport

**Files:**

- Create: `scripts/codex-app-server/json-rpc.ts`
- Test: `test/adapters/codex-probe.test.ts`

**Interfaces:**

- Consumes: `ChildProcessWithoutNullStreams` from `node:child_process`.
- Produces: `CodexJsonRpcConnection.request`, `notify`, `close`, and `CodexRpcError.rpcCode` for the probe.

- [ ] **Step 1: Write failing transport tests**

Create `test/adapters/codex-probe.test.ts` with these imports and the complete fake child. It parses fragmented NDJSON written by the transport, records requests and notifications, and emits `exit` on the next microtask after `kill()`:

```ts
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexJsonRpcConnection, CodexRpcError } from "../../scripts/codex-app-server/json-rpc.js";

interface RpcFrame {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

class FakeCodexChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: RpcFrame[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.input += String(chunk);
      let newline = this.input.indexOf("\n");
      while (newline >= 0) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (line !== "") this.frames.push(JSON.parse(line) as RpcFrame);
        newline = this.input.indexOf("\n");
      }
    });
  }

  get requests(): Array<RpcFrame & { id: number }> {
    return this.frames.filter(
      (frame): frame is RpcFrame & { id: number } => typeof frame.id === "number",
    );
  }

  get notifications(): Array<{ method: string; params: unknown }> {
    return this.frames
      .filter((frame) => frame.id === undefined)
      .map((frame) => ({ method: frame.method, params: frame.params }));
  }

  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM"): boolean => {
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  });
}

function fakeConnection(): {
  child: FakeCodexChild & ChildProcessWithoutNullStreams;
} {
  const child = new FakeCodexChild() as unknown as FakeCodexChild & ChildProcessWithoutNullStreams;
  return { child };
}
```

Add these tests:

```ts
it("handles fragmented responses and server notifications without answering them", async () => {
  const { child } = fakeConnection();
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 20 });
  const pending = connection.request("initialize", {
    clientInfo: { name: "synloq-test", version: "0" },
  });
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: {} }) + "\n");
  const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
  child.stdout.write(response.slice(0, 8));
  child.stdout.write(response.slice(8) + "\n");

  await expect(pending).resolves.toEqual({ capabilities: {} });
  expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
  expect(child.frames).toHaveLength(1);
  await connection.close();
  expect(child.kill).toHaveBeenCalled();
});

it("times out without sending a retry and still closes the child", async () => {
  const { child } = fakeConnection();
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 5 });
  await expect(connection.request("initialize", {})).rejects.toThrow("initialize timed out");
  expect(child.frames).toHaveLength(1);
  await connection.close();
  expect(child.kill).toHaveBeenCalled();
});

it("rejects oversized input without resolving a request", async () => {
  const { child } = fakeConnection();
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 100 });
  const pending = connection.request("initialize", {});
  child.stdout.write(" ".repeat(1024 * 1024 + 1));
  await expect(pending).rejects.toThrow("buffer exceeded");
  await connection.close();
});

it("rejects malformed JSON without resolving a request", async () => {
  const { child } = fakeConnection();
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 100 });
  const pending = connection.request("initialize", {});
  child.stdout.write("not-json\n");
  await expect(pending).rejects.toThrow("malformed JSON");
  await connection.close();
});

it("keeps the public JSON-RPC error generic and retains detail only for classification", async () => {
  const { child } = fakeConnection();
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 20 });
  const pending = connection.request("thread/resume", { threadId: "thread-open" });
  child.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "active writer; token=do-not-report" },
    }) + "\n",
  );

  const error = await pending.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(CodexRpcError);
  expect(error).toMatchObject({
    method: "thread/resume",
    rpcCode: -32600,
    message: "thread/resume failed with JSON-RPC -32600",
    remoteDetail: expect.stringContaining("active writer"),
  });
  expect((error as Error).message).not.toContain("do-not-report");
  await connection.close();
});

it("escalates a stalled SIGTERM and removes temporary exit/error listeners", async () => {
  const { child } = fakeConnection();
  child.kill.mockImplementationOnce(() => true);
  const connection = new CodexJsonRpcConnection(child, { timeoutMs: 5 });

  await connection.close();

  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(child.listenerCount("exit")).toBe(0);
  expect(child.listenerCount("error")).toBe(0);
});
```

- [ ] **Step 2: Run transport tests to verify RED**

Run: `pnpm vitest run test/adapters/codex-probe.test.ts`

Expected: FAIL to resolve `scripts/codex-app-server/json-rpc.js`.

- [ ] **Step 3: Implement the bounded transport**

Create `scripts/codex-app-server/json-rpc.ts` with these public types:

```ts
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRpcOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcCode?: number,
    readonly remoteDetail?: string,
  ) {
    super(rpcCode === undefined ? `${method} failed` : `${method} failed with JSON-RPC ${rpcCode}`);
    this.name = "CodexRpcError";
  }
}
```

Implement `CodexJsonRpcConnection` with:

- `nextId` starting at 1 and a `Map<number, PendingRequest>`;
- UTF-8 stdout accumulation capped by `maxBufferBytes ?? 1_048_576`;
- a continuously attached stderr `data` listener retaining at most 16 KiB for diagnostics;
- response matching by numeric `id`, ignoring all frames with a `method` and unknown IDs;
- `request(method, params)` writing exactly one `{jsonrpc:"2.0",id,method,params}` NDJSON frame;
- `notify(method, params)` writing exactly one frame without `id`;
- one timeout per request, cleared on response/failure, with no retry;
- `CodexRpcError` for a JSON-RPC error, preserving a numeric code and internal detail for writer-conflict classification;
- idempotent failure rejection of every pending request;
- idempotent `close()` that sends `SIGTERM`, waits for `exit`, escalates to `SIGKILL` after the timeout, and waits again; a child that still does not exit produces an error rather than a false cleanup claim.

Use this complete cleanup helper. It installs the timer before `kill()`, removes both listeners on every completion path, and never leaves a detached timer after a synchronous exit or error:

```ts
private terminate(signal: NodeJS.Signals): Promise<boolean> {
  if (this.child.exitCode !== null || this.child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      this.child.off("exit", onExit);
      this.child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), this.timeoutMs);
    this.child.once("exit", onExit);
    this.child.once("error", onError);
    try {
      const signalled = this.child.kill(signal);
      if (
        !signalled &&
        (this.child.exitCode !== null || this.child.signalCode !== null)
      ) {
        finish(true);
      }
    } catch {
      finish(false);
    }
  });
}
```

`close()` memoizes one cleanup promise, first awaits `terminate("SIGTERM")`, then `terminate("SIGKILL")` if needed, rejects pending requests, removes its persistent process/stream listeners, destroys the three streams, and throws if both waits expire. It performs listener/timer cleanup even when escalation fails.

- [ ] **Step 4: Run transport tests and typecheck**

Run: `pnpm vitest run test/adapters/codex-probe.test.ts && pnpm typecheck`

Expected: PASS and TypeScript exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add -- scripts/codex-app-server/json-rpc.ts test/adapters/codex-probe.test.ts
git commit -m "feat: add bounded Codex app-server transport"
```

---

### Task 5: Read-only Codex compatibility probe

**Files:**

- Create: `scripts/probe-codex-app-server.ts`
- Modify: `test/adapters/codex-probe.test.ts`

**Interfaces:**

- Consumes: `CodexJsonRpcConnection`, injected command runner and process spawner.
- Produces: `probeCodexAppServer(options): Promise<CodexProbeReport>` and CLI `node scripts/probe-codex-app-server.ts --cwd <absolute-path> [--thread-id <id>] [--codex-bin <path>]`.

- [ ] **Step 1: Write failing no-submission and report tests**

Append these imports and the complete probe fake to `test/adapters/codex-probe.test.ts`. The fake answers only the methods selected by each fixture and records safe deterministic command output:

```ts
import { createHash } from "node:crypto";
import {
  probeCodexAppServer,
  type CodexCommandRunner,
  type CodexProbeOptions,
} from "../../scripts/probe-codex-app-server.js";

interface ProbeFixture {
  initialize: unknown;
  resume?: unknown;
  read?: unknown;
  resumeError?: { code: number; message: string };
}

function fakeProbe(fixture: ProbeFixture): {
  child: FakeCodexChild & ChildProcessWithoutNullStreams;
  commands: Array<{ command: string; args: readonly string[]; cwd: string }>;
  options: CodexProbeOptions;
} {
  const { child } = fakeConnection();
  const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const commandRunner: CodexCommandRunner = vi.fn(async (command, args, cwd) => {
    commands.push({ command, args: [...args], cwd });
    const stdout =
      args.join(" ") === "--version"
        ? "codex 0.0.0-test\n"
        : args.join(" ") === "app-server --help"
          ? "app-server test help\n"
          : '{"type":"object"}\n';
    return { stdout, stderr: "" };
  });
  child.stdin.on("data", () => {
    const frame = child.frames.at(-1);
    if (frame?.id === undefined) return;
    queueMicrotask(() => {
      if (frame.method === "thread/resume" && fixture.resumeError !== undefined) {
        child.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            error: fixture.resumeError,
          }) + "\n",
        );
        return;
      }
      const result =
        frame.method === "initialize"
          ? fixture.initialize
          : frame.method === "thread/resume"
            ? (fixture.resume ?? {})
            : frame.method === "thread/read"
              ? (fixture.read ?? {})
              : {};
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
    });
  });
  const spawnProcess = (() => child) as unknown as NonNullable<CodexProbeOptions["spawnProcess"]>;
  return {
    child,
    commands,
    options: {
      cwd: process.cwd(),
      codexBin: "codex-test",
      spawnProcess,
      commandRunner,
      observedAt: () => "2026-11-11T00:00:00.000Z",
      timeoutMs: 20,
    },
  };
}
```

Add these tests:

```ts
it("collects metadata and skips resume without an explicit thread ID", async () => {
  const harness = fakeProbe({
    initialize: { serverInfo: { name: "codex", version: "test" }, capabilities: {} },
  });
  const report = await probeCodexAppServer(harness.options);

  expect(harness.commands.map((call) => call.args)).toEqual([
    ["--version"],
    ["app-server", "--help"],
    ["app-server", "generate-json-schema"],
  ]);
  expect(harness.child.requests.map((request) => request.method)).toEqual(["initialize"]);
  expect(harness.child.notifications).toEqual([{ method: "initialized", params: {} }]);
  expect(report.resumeSkippedReason).toBe("thread-id-not-provided");
  expect(report.activeDeliveryClaim).toBe(false);
  expect(report.reason).toBe("visible-session-submission-not-verified");
  expect(JSON.stringify(report)).not.toContain("turn/start");
});

it("uses only thread/resume and thread/read for an explicit thread", async () => {
  const harness = fakeProbe({
    initialize: { serverInfo: { name: "codex", version: "test" }, capabilities: {} },
    resume: {
      thread: {
        id: "thread-visible",
        status: { type: "idle" },
        turns: [{ text: "secret prompt" }],
      },
    },
    read: {
      thread: {
        id: "thread-visible",
        status: { type: "idle" },
        turns: [{ text: "secret prompt" }],
      },
    },
  });
  const report = await probeCodexAppServer({ ...harness.options, threadId: "thread-visible" });

  expect(harness.child.requests.map((request) => request.method)).toEqual([
    "initialize",
    "thread/resume",
    "thread/read",
  ]);
  expect(report.resume).toMatchObject({ status: "attached", threadId: "thread-visible" });
  expect(JSON.stringify(report)).not.toContain("secret prompt");
  expect(harness.child.requests.some((request) => request.method.startsWith("turn/"))).toBe(false);
});

it("records an active-writer conflict without retrying or submitting", async () => {
  const harness = fakeProbe({
    initialize: { capabilities: {} },
    resumeError: {
      code: -32600,
      message: "thread already has an active writer; token=do-not-report",
    },
  });
  const report = await probeCodexAppServer({ ...harness.options, threadId: "thread-open" });

  expect(report.resume).toEqual({ status: "writer-conflict", errorCode: -32600 });
  expect(harness.child.requests.map((request) => request.method)).toEqual([
    "initialize",
    "thread/resume",
  ]);
  expect(JSON.stringify(report)).not.toContain("do-not-report");
  expect(report.activeDeliveryClaim).toBe(false);
});

it("sanitizes initialize recursively and hashes rather than embeds the schema", async () => {
  const harness = fakeProbe({
    initialize: {
      serverInfo: { name: "codex", version: "test" },
      capabilities: { experimental: { safe: true, prompt: "secret prompt" } },
      token: "secret-token",
      nested: {
        auth: { secret: "nested-secret" },
        account: { name: "private-account" },
        turns: [{ text: "private-turn" }],
        text: "private-text",
      },
      safe: "visible",
      list: ["x".repeat(600), ...Array.from({ length: 40 }, (_, index) => index)],
    },
  });

  const report = await probeCodexAppServer(harness.options);
  const schema = '{"type":"object"}\n';
  expect(report.appServerSchema).toEqual({
    available: true,
    bytes: Buffer.byteLength(schema, "utf8"),
    sha256: createHash("sha256").update(schema, "utf8").digest("hex"),
  });
  expect(report.initialize).toEqual({
    serverInfo: { name: "codex", version: "test" },
    capabilities: { experimental: { safe: true } },
    nested: {},
    safe: "visible",
    list: ["x".repeat(256), ...Array.from({ length: 31 }, (_, index) => index + 1)],
  });
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain("private");
  expect(serialized).not.toContain(schema);
});
```

The fake command runner returns safe deterministic stdout for version/help/schema. The assertions prove that schema content is represented only by byte count and SHA-256, and that unknown initialize fields cannot leak prompts, text, turns, tokens, secrets, account, or auth data.

- [ ] **Step 2: Run probe tests to verify RED**

Run: `pnpm vitest run test/adapters/codex-probe.test.ts`

Expected: FAIL to resolve `scripts/probe-codex-app-server.js`.

- [ ] **Step 3: Implement bounded metadata commands and sanitized reporting**

Create `scripts/probe-codex-app-server.ts`. Use this command-runner contract and default implementation:

```ts
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

export interface CommandResult {
  stdout: string;
  stderr: string;
}
export type CodexCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

const defaultCommandRunner: CodexCommandRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error("Codex metadata command failed"));
        else resolve({ stdout, stderr });
      },
    );
  });
```

Define the report shape:

```ts
export interface CodexProbeReport {
  observedAt: string;
  codexVersion: string;
  appServerHelp: { available: boolean; bytes: number; sha256: string };
  appServerSchema: { available: boolean; bytes: number; sha256: string };
  initialize: unknown;
  resume?:
    | { status: "attached"; threadId: string }
    | { status: "writer-conflict" | "error"; errorCode?: number };
  resumeRead?: { status: "read" } | { status: "error"; errorCode?: number };
  resumeSkippedReason?: "thread-id-not-provided";
  activeDeliveryClaim: false;
  reason: "visible-session-submission-not-verified";
}

export interface CodexProbeOptions {
  cwd: string;
  threadId?: string;
  codexBin?: string;
  spawnProcess?: typeof spawn;
  commandRunner?: CodexCommandRunner;
  observedAt?: () => string;
  timeoutMs?: number;
}
```

Implement `metadataArtifact(stdout)` as UTF-8 byte length plus SHA-256. `codexVersion` is only the first trimmed stdout line, capped at 256 characters. A failed help/schema command produces `{available:false,bytes:0,sha256:""}`; a failed version command produces `"unknown"` and does not get converted into capability evidence. Pass `timeoutMs ?? 5000` to both the JSON-RPC connection and the default metadata command runner; injected fakes may use shorter timeouts.

Sanitize the unknown initialize result before placing it in the report with this exact recursive function:

```ts
const sensitiveInitializeKey = /prompt|text|turns|token|secret|account|auth/i;

function sanitizeInitialize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 256);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 8) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeInitialize(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (!sensitiveInitializeKey.test(key)) {
      entries.push([key, sanitizeInitialize(item, depth + 1)]);
    }
  }
  return Object.fromEntries(entries);
}
```

Use this exact read-only request sequence:

```ts
const initialize = sanitizeInitialize(
  await connection.request("initialize", {
    clientInfo: { name: "synloq-codex-probe", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  }),
);
connection.notify("initialized", {});
```

With `threadId`, send only:

```ts
await connection.request("thread/resume", { threadId: options.threadId });
await connection.request("thread/read", { threadId: options.threadId, includeTurns: false });
```

Do not include raw resume/read results in the report. Read `result.thread.id` through unknown-object guards and report `attached` only when it exactly equals the configured thread ID; a missing or different ID is `error` and skips `thread/read`. Record `resumeRead.status` and numeric error codes. Classify `CodexRpcError.remoteDetail` containing `active writer` as `writer-conflict`, without returning that detail. Other resume failures are `error`. A failed resume skips `thread/read`.

Construct failure objects conditionally so `exactOptionalPropertyTypes` never receives an explicit undefined error code:

```ts
type ProbeFailureStatus = "writer-conflict" | "error";

function probeFailure<S extends ProbeFailureStatus>(
  status: S,
  error: unknown,
): { status: S; errorCode?: number } {
  return error instanceof CodexRpcError && typeof error.rpcCode === "number"
    ? { status, errorCode: error.rpcCode }
    : { status };
}
```

Run `initialize` before constructing the final report and always close the connection in `finally`. The report's `activeDeliveryClaim` and `reason` are unconditional literals.

- [ ] **Step 4: Add the CLI entry point and validate boundaries**

In the same script, use `parseArgs` with required absolute `--cwd`, optional non-empty `--thread-id`, and optional non-empty `--codex-bin` defaulting to `codex`. Spawn exactly `[app-server]` with `cwd`, three pipes, and `windowsHide:true`.

Write only the final JSON report to stdout. On failure, write a sanitized one-line error to stderr and set exit code 1. Use the same `import.meta.url === pathToFileURL(resolve(process.argv[1])).href` entry-point guard as the Kimi probe.

- [ ] **Step 5: Run probe tests and typecheck**

Run: `pnpm vitest run test/adapters/codex-probe.test.ts && pnpm typecheck`

Expected: PASS and TypeScript exit 0. Inspect every recorded fake outgoing method and confirm no `turn/start`, `turn/steer`, `thread/start`, `exec`, prompt, approval, or configuration method exists.

- [ ] **Step 6: Commit Task 5**

```bash
git add -- scripts/probe-codex-app-server.ts test/adapters/codex-probe.test.ts
git commit -m "feat: probe Codex app-server read only"
```

---

### Task 6: Codex operator documentation and live evidence matrix

**Files:**

- Modify: `README.md`
- Modify: `docs/client-compatibility.md`
- Modify: `test/e2e/real-clients.md`

**Interfaces:**

- Consumes: the public MCP config shape, `codex-hook --config`, and probe CLI implemented above.
- Produces: executable one-role setup and explicit live-unverified support documentation.

- [ ] **Step 1: Add the Codex README section**

Document this minimal external MCP JSON (the adapter JSON remains separate and includes the common strict fields):

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "./cto.token"
}
```

Document the command shape with absolute paths substituted by the operator:

```bash
codex mcp add synloq-cto -- node /absolute/path/to/synloq/dist/mcp/stdio.js /secure/path/codex-mcp.json
```

State that one Codex configuration/`CODEX_HOME` contains one role credential. Do not instruct the operator to place tokens in `config.toml` or to configure several role servers in one scope.

Add `kind: "codex"` configuration and hook JSON for `SessionStart`, `UserPromptSubmit`, `PreModelRequest`, `Stop`, `Interrupt`, and `SessionEnd`. Every command handler uses:

```text
node /absolute/path/to/synloq/dist/cli/main.js codex-hook --config /secure/path/codex-cto.json
```

State that project hooks require a trusted project, changed hooks require review, and Synloq emits no `additionalContext` or permission decision.

Document:

```bash
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path
node scripts/probe-codex-app-server.ts --cwd /absolute/project/path --thread-id REPLACE_WITH_VISIBLE_THREAD_ID
```

Explicitly mark the second command read-only and active delivery unsupported/unverified.

- [ ] **Step 2: Add the compatibility section**

Add `## Codex` to `docs/client-compatibility.md` with:

- support: MCP inbox plus lifecycle state reporting;
- live status: `UNVERIFIED`;
- `activeDelivery:false`, `stateReporting:true`, `clientIdempotency:false`;
- the exact state table from the approved spec;
- no production activation field and no active runner;
- one-role configuration limitation and unverified shared Desktop multi-role binding;
- probe limits, sanitized report fields, and the fact that resume/schema/initialize are not delivery evidence.

- [ ] **Step 3: Add the manual acceptance matrix**

Append a Codex section to `test/e2e/real-clients.md` with numbered evidence steps for version/surface/config scope/session ID, all six MCP tools, relay restart durability, trusted hook events, wrong-session rejection, interrupt fail-closed behavior, and probe runs with and without thread ID.

Require actual output files in the operator's secure evidence directory, not in Git. Include a final checkbox stating that no active-delivery acceptance is possible in this increment and no status upgrade is allowed from mocks or a successful read-only probe.

- [ ] **Step 4: Verify formatting and documentation consistency**

Run:

```bash
pnpm exec prettier --write README.md docs/client-compatibility.md test/e2e/real-clients.md
pnpm exec prettier --check README.md docs/client-compatibility.md test/e2e/real-clients.md
```

Expected: PASS. Search the changed documentation for `turn/start`, `turn/steer`, `additionalContext`, `activeDelivery:true`, inline `token`, and `activationVerifiedAt`; only prohibitions or clearly marked non-Codex examples may match.

- [ ] **Step 5: Commit Task 6**

```bash
git add -- README.md docs/client-compatibility.md test/e2e/real-clients.md
git commit -m "docs: add Codex inbox and probe acceptance"
```

---

### Task 7: Final review, full gates and package smoke

**Files:**

- Verify all task files; modify only defects confirmed by review/tests.
- Update uncommitted: `.superpowers/sdd/progress.md` and `.superpowers/sdd/codex-report.md`.

**Interfaces:**

- Consumes: all previous task deliverables.
- Produces: verified Codex foundation; no active-delivery support claim.

- [ ] **Step 1: Review the complete Codex diff**

Run: `git diff be10701 -- src/cli/main.ts src/cli/adapter.ts src/cli/codex-hook.ts src/config/adapter.ts src/adapters/codex-state.ts scripts test/adapters/codex-state.test.ts test/adapters/codex-probe.test.ts test/cli/codex-hook.test.ts test/config/adapter.test.ts README.md docs/client-compatibility.md test/e2e/real-clients.md`

Confirm every requirement in the approved spec maps to code/tests/docs, no active-delivery path exists, and no Task 4 transport timer/listener remains after close. Do not expand scope to an active adapter.

- [ ] **Step 2: Format only touched code and run full verification**

Run:

```bash
pnpm exec prettier --write src/config/adapter.ts src/cli/adapter.ts src/cli/main.ts src/adapters/codex-state.ts src/cli/codex-hook.ts scripts/codex-app-server/json-rpc.ts scripts/probe-codex-app-server.ts test/config/adapter.test.ts test/adapters/codex-state.test.ts test/adapters/codex-probe.test.ts test/cli/codex-hook.test.ts test/cli/standalone-adapter.test.ts
pnpm verify
```

Expected: Prettier, strict typecheck, every Vitest file, and build PASS with zero failures. Report actual file/test counts, not anticipated counts.

- [ ] **Step 3: Run package and built CLI gates**

Run:

```bash
pnpm pack --pack-destination .tmp-pack
tar -tzf .tmp-pack/synloq-0.1.0.tgz
node dist/cli/main.js codex-hook --help
node dist/cli/main.js doctor --help
node dist/cli/main.js adapter --help
node dist/cli/main.js claude-hook --help
```

Expected: `codex-hook` exits 0 and prints `Usage: synloq codex-hook --config <path>`; existing help remains successful. The archive contains the required built entry points and no tests, scripts, credentials, runtime files, logs, or probe evidence. The probe intentionally remains a repository script and is not advertised as a packaged CLI.

- [ ] **Step 4: Record actual evidence and commit any review fix**

Record executed commands and actual results, changed modules, live-unverified Codex/Claude/OpenCode/Kimi limitations, and deliberately excluded active delivery in `.superpowers/sdd/codex-report.md`. Update `.superpowers/sdd/progress.md`; do not stage either file.

If review produced a tracked fix, run its focused RED/GREEN test, repeat `pnpm verify` and package smoke, then stage only the named fix files and commit:

```bash
git commit -m "fix: close Codex probe lifecycle gaps"
```

If no tracked fix exists, do not create an empty commit.

- [ ] **Step 5: Final repository check**

Run: `git status --short && git diff HEAD --name-only && git log -3 --oneline`

Expected: no substantive unstaged diff. Windows line-ending-only status entries may remain but are not staged. No push, merge, publication, live support upgrade, or next-client adapter is part of this task.
