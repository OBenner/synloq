# Synloq Generic Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `synloq init` into a generic initializer that accepts arbitrary confirmed roles, creates or reuses exact visible Kimi Work chats, persists resumable bindings, and generates per-role MCP channels without exposing tokens or requiring hand-edited JSON.

**Architecture:** A dependency-injected initialization engine is shared by interactive and non-interactive CLI entry points and by a Kimi-driven invocation. The engine writes the manifest and per-chat binding state atomically, reuses valid credential files, renders the versioned source-plugin template, and returns only non-secret readiness data. Relay ownership remains the existing manually started relay until the companion lifecycle plan lands.

**Tech Stack:** Node 24, TypeScript 7, Zod 4, YAML 2, Vitest 5, existing Kimi Work JSON-RPC and Synloq credential storage.

## Global Constraints

- Specification: `docs/superpowers/specs/2026-11-11-kimi-work-visible-team-design.md`.
- CTO and Architect are fixtures only. Any valid domain agent ID and role text must work.
- Bind by exact `conversationKey`; never use a title as an address.
- Create with `origin:"client"`, `activate:false`, `sessionKey:"agent:main:main"`, `agentId:"main"`, and the canonical project root.
- Persist each successful create immediately. After an uncertain create, list/reconcile or fail closed; never blindly repeat the mutation.
- One source plugin has one persisted project owner. A different project fails closed rather than overwriting channels.
- Plaintext tokens live only in mode-`0600` files under Synloq home and are never printed by CLI, written into plugin source, or included in errors.
- Reuse an existing valid role token; do not add another credential generation on every rerun.
- Do not modify the managed plugin copy. The repository template is scaffolded with `create_plugin.py`; generated source is validated with `validate_plugin.py` before registration.
- Do not add dependencies, change the six MCP tools, commit, push, merge, or edit files outside this feature's scope without operator approval.

---

### Task 1: Typed Kimi Work discovery and creation

**Files:**

- Modify: `src/host/kimi-work/control-client.ts`
- Modify: `test/host/kimi-work/control-client.test.ts`

**Interfaces:**

- Produces: `KimiWorkConversationSummary`, `KimiWorkCreateInput`, `KimiWorkListOptions`, `KimiWorkListResult`.
- Produces: `KimiWorkControlClient.create(input): Promise<KimiWorkConversationSummary>` and `.list(options): Promise<KimiWorkListResult>`.
- Consumes: existing `KimiWorkJsonRpcConnection.request` without changing transport retry behavior.

- [ ] **Step 1: Write failing list/create tests**

Use the existing `FakeRpc`. Assert exact calls and decoded values:

```ts
await client.create({
  agentId: "main",
  sessionKey: "agent:main:main",
  origin: "client",
  activate: false,
  workspacePath: binding.workspacePath,
  clientInstructions: "Role: reviewer\nUse only your assigned Synloq channel.",
});
expect(rpc.calls[0]).toEqual({
  method: "conversations.create",
  params: {
    agentId: "main",
    sessionKey: "agent:main:main",
    origin: "client",
    activate: false,
    workspacePath: binding.workspacePath,
    clientInstructions: "Role: reviewer\nUse only your assigned Synloq channel.",
  },
});

await client.list({
  agentId: "main",
  sessionKey: "agent:main:main",
  origin: "client",
  workspacePath: binding.workspacePath,
  limit: 100,
  includeTemporary: false,
});
```

The fake create result must contain `agentId`, `sessionKey`, `conversationKey`, `conversationId`, `origin`, `workspacePath`, `clientInstructions`, `title`, `titleStatus`, `createdAt`, `updatedAt`, and optional `kernelSessionId`. The list result contains `conversations` and `page:{limit,hasMore,nextCursor?}`. Add rejection cases for a missing key, wrong origin type, missing workspace on a created client chat, and an empty instruction string when supplied.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/host/kimi-work/control-client.test.ts`
Expected: FAIL because `create` and `list` do not exist.

- [ ] **Step 3: Implement strict contracts**

Add these public types and validate responses with Zod; permit unrelated host diagnostics with `.passthrough()` only on envelopes:

```ts
export interface KimiWorkConversationSummary {
  agentId: string;
  sessionKey: string;
  conversationKey: string;
  conversationId: string;
  kernelSessionId?: string;
  origin: string;
  workspacePath?: string;
  clientInstructions?: string;
  title: string;
}

export interface KimiWorkCreateInput {
  agentId: string;
  sessionKey: string;
  origin: "client";
  activate: false;
  workspacePath: string;
  clientInstructions: string;
}

export interface KimiWorkListOptions {
  agentId: string;
  sessionKey?: string;
  origin?: "client";
  workspacePath?: string;
  limit?: number;
  cursor?: string;
  includeTemporary?: boolean;
}

export interface KimiWorkListResult {
  conversations: KimiWorkConversationSummary[];
  page: { limit: number; hasMore: boolean; nextCursor?: string };
}
```

`create()` returns `result.conversation` and verifies that its key, agent, session, origin, workspace, and instructions match the request. `list()` validates page fields and never matches titles.

- [ ] **Step 4: Run GREEN**

Run: `pnpm vitest run test/host/kimi-work/control-client.test.ts`
Expected: all existing and new typed-client tests PASS.

- [ ] **Step 5: Review checkpoint**

Run `git diff --check` and inspect only the two files. Do not commit unless the operator separately approves a commit.

---

### Task 2: Atomic manifest, project state, and reusable credentials

**Files:**

- Modify: `src/config/paths.ts`
- Modify: `src/config/manifest.ts`
- Modify: `src/config/credentials.ts`
- Create: `src/config/atomic-file.ts`
- Create: `src/config/team-state.ts`
- Create: `test/config/team-state.test.ts`
- Modify: `test/config/manifest.test.ts`
- Modify: `test/cli/commands.test.ts`

**Interfaces:**

- Produces: `projectPaths(projectRoot, synloqHome?): Promise<ProjectPaths>` where `ProjectPaths` adds `home`, `runtime`, `bindings`, and `tokens`.
- Produces: `writeManifest(projectRoot, participants): Promise<void>`.
- Produces: `TeamStateStore` with `read()`, `write()`, and `update()`.
- Produces: `ensureCredential(project, agentId): Promise<{ token:string; tokenPath:string; reused:boolean }>`.

- [ ] **Step 1: Write failing persistence tests**

Cover arbitrary roles, atomic replacement, no secret fields in state, and rerun reuse:

```ts
const store = new TeamStateStore(paths.bindings);
await store.update((state) => ({
  ...state,
  conversations: {
    ...state.conversations,
    reviewer: {
      agentId: "reviewer",
      workAgentId: "main",
      sessionKey: "agent:main:main",
      conversationKey: createdKey,
      conversationId: "conversation-uuid",
      workspacePath: root,
    },
  },
}));
expect((await store.read()).conversations.reviewer?.conversationKey).toBe(createdKey);

const first = await credentials.ensureCredential("example", "reviewer");
const second = await credentials.ensureCredential("example", "reviewer");
expect(second.token).toBe(first.token);
expect(second.reused).toBe(true);
expect(second.tokenPath).not.toContain("plugin-sources");
expect(await credentials.authenticate("example", first.token)).toMatchObject({
  agentId: "reviewer",
});
```

Also prove two different agent IDs never share a token file, malformed state fails closed, and `writeManifest` preserves role descriptions without adding instruction fields to version 1.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/config/manifest.test.ts test/config/team-state.test.ts test/cli/commands.test.ts`
Expected: FAIL on missing state and credential methods.

- [ ] **Step 3: Implement focused persistence modules**

`atomic-file.ts` exposes:

```ts
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void>;
export async function writeTextAtomic(path: string, value: string, mode = 0o600): Promise<void>;
```

Both create parent directories, write a unique sibling temporary file with `wx`, rename, and remove the temporary file in `finally`. `projectPaths` accepts an optional explicit home so the same value can flow from init to MCP without global environment mutation.

Persist this strict state at `paths.bindings`:

```ts
interface TeamState {
  version: 1;
  project: string;
  projectRoot: string;
  pluginSourcePath?: string;
  conversations: Record<
    string,
    {
      agentId: string;
      workAgentId: "main";
      sessionKey: "agent:main:main";
      conversationKey: string;
      conversationId: string;
      kernelSessionId?: string;
      workspacePath: string;
    }
  >;
}
```

`ensureCredential` resolves `paths.tokens/<agentId>.token`, reuses it only when `authenticate` succeeds, otherwise issues and atomically saves a new token with mode `0600`. Existing hashed credential files remain compatible. Update test fixtures to use returned tokens directly rather than stdout.

- [ ] **Step 4: Run GREEN and regression tests**

Run: `pnpm vitest run test/config test/cli/commands.test.ts`
Expected: all focused tests PASS and no token file appears in the repository.

- [ ] **Step 5: Review checkpoint**

Run `git diff --check`; inspect state fixtures for accidental plaintext tokens. Do not commit without approval.

---

### Task 3: Resumable generic initialization engine and plugin rendering

**Files:**

- Create: `src/init/types.ts`
- Create: `src/init/initialize-team.ts`
- Create: `src/init/kimi-work-host.ts`
- Create: `src/init/plugin-renderer.ts`
- Create: `plugins/synloq/` via the official plugin scaffold
- Create: `test/init/initialize-team.test.ts`
- Create: `test/init/plugin-renderer.test.ts`

**Interfaces:**

- Consumes: Tasks 1–2 public contracts and existing `loadKimiWorkControlEndpoint` / `KimiWorkJsonRpcConnection`.
- Produces: `initializeTeam(options: InitializeTeamOptions): Promise<InitializeTeamResult>`.
- Produces: `KimiWorkInitHost` with `create` and `list`, injectable for controlled tests.

- [ ] **Step 1: Scaffold the repository template**

Run the installed `create_plugin.py synloq --type mcp+skills --with-agents --locale en-US --output <temporary-scaffold-path>` with real Synloq display copy, then place the resulting skeleton under `plugins/synloq`. Replace stub copy with generic instructions: initialize arbitrary roles, use only the assigned channel, use `QUESTION`/`TASK`/`RESULT`/`BLOCKED`/`NOTICE`, acknowledge after actual reading, reply in-thread, and request operator approval for risky actions. Do not put role IDs, absolute paths, ports, tokens, or CTO/Architect requirements in the template.

- [ ] **Step 2: Write failing engine tests**

Use roles such as `product` and `reviewer`, not only CTO/Architect. The principal case is:

```ts
const result = await initializeTeam({
  projectRoot: root,
  project: "example",
  roles: [
    { agentId: "product", title: "Product", role: "Own scope and priorities" },
    { agentId: "reviewer", title: "Reviewer", role: "Review evidence and risks" },
  ],
  pluginSourcePath,
  host,
  synloqHome: home,
  runtimeEntrypoint: join(root, "dist", "mcp", "stdio.js"),
});
expect(host.created).toHaveLength(2);
expect(host.created.every((input) => input.activate === false)).toBe(true);
expect(result.roles).toEqual([
  expect.objectContaining({ agentId: "product", conversationKey: "created-product" }),
  expect.objectContaining({ agentId: "reviewer", conversationKey: "created-reviewer" }),
]);
expect(JSON.stringify(result)).not.toContain(firstToken);
```

Add tests for rerun with zero additional creates, distinct conversation keys, persistence after the first create when the second fails, foreign plugin ownership rejection, duplicate supplied conversation rejection, and uncertain-create reconciliation by exact returned identity. The engine must never call a title-based lookup.

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run test/init`
Expected: FAIL because initialization modules do not exist.

- [ ] **Step 4: Implement the engine and renderer**

Public contracts:

```ts
export interface RoleInput {
  agentId: string;
  title: string;
  role: string;
  instructions?: string;
  conversationKey?: string;
}

export interface KimiWorkInitHost {
  create(input: KimiWorkCreateInput): Promise<KimiWorkConversationSummary>;
  list(options: KimiWorkListOptions): Promise<KimiWorkListResult>;
}

export interface InitializeTeamOptions {
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  pluginSourcePath: string;
  synloqHome?: string;
  runtimeEntrypoint: string;
  host: KimiWorkInitHost;
}

export interface InitializeTeamResult {
  project: string;
  manifestPath: string;
  statePath: string;
  pluginSourcePath: string;
  registrationRequired: boolean;
  roles: Array<{
    agentId: string;
    conversationKey: string;
    configPath: string;
    credentialPath: string;
  }>;
}
```

For each role, validate exact existing binding or supplied `conversationKey` through `list`; otherwise create and immediately persist. Reject a conversation already owned by another role. Build `clientInstructions` from common team rules plus the confirmed role description and optional additions.

The renderer copies only tracked template files, writes per-role agent Markdown, and updates existing manifest fields with one `synloq-<agentId>` MCP entry per role. Each generated config contains `relayUrl:"http://127.0.0.1:4100"`, an absolute token path, `synloqHome`, and the exact `kimiWork` binding. Tokens remain outside plugin source. A `.synloq-owner.json` in generated source stores only version, project, and canonical project root; a mismatch throws `INVALID_INPUT`.

Return `registrationRequired:true` after source changes. Registration is a separate supported command and never synonymous with installation or readiness.

- [ ] **Step 5: Run GREEN and plugin validation**

Run: `pnpm vitest run test/init`
Run: `python <plugin-builder>/scripts/validate_plugin.py plugins/synloq`
Expected: all initialization tests PASS; plugin validation reports 0 errors.

- [ ] **Step 6: Review checkpoint**

Inspect generated test output and source template for absolute local paths and secrets. Do not commit without approval.

---

### Task 4: CLI wizard, non-interactive parity, and user documentation

**Files:**

- Modify: `src/cli/main.ts`
- Modify: `src/cli/commands.ts`
- Create: `src/cli/init-wizard.ts`
- Create: `test/cli/init-wizard.test.ts`
- Modify: `test/cli/commands.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: `initializeTeam` and `KimiWorkInitHost` from Task 3.
- Produces: repeatable `--role <agent-id>:<title>:<role>` and optional `--role-instructions <agent-id>:<text>`, `--conversation <agent-id>:<conversationKey>`, `--plugin-source <path>`, `--synloq-home <path>` inputs.
- Produces: `runInitWizard(io, defaults): Promise<{project:string;roles:RoleInput[]}>` using injected readline question functions.

- [ ] **Step 1: Write failing CLI tests**

Cover wizard confirmation, empty roles rejection, malformed role IDs, repeatable arbitrary roles, and equivalent wizard/non-interactive engine inputs. Assert stdout parses as JSON and contains no token:

```ts
const exitCode = await runMain(
  [
    "init",
    "--project-root",
    root,
    "--project",
    "example",
    "--role",
    "product:Product:Own scope and priorities",
    "--role",
    "reviewer:Reviewer:Review evidence and risks",
    "--plugin-source",
    pluginSource,
  ],
  io,
  dependencies,
);
expect(exitCode).toBe(0);
expect(stdout).not.toContain(secretToken);
expect(JSON.parse(stdout).roles).toHaveLength(2);
```

Inject `initialize` and host factories in `MainDependencies`; no test needs a real Kimi mutation. Preserve existing legacy manifest initialization coverage by migrating it to explicit role inputs and non-secret output.

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run test/cli`
Expected: FAIL on missing options and wizard.

- [ ] **Step 3: Implement CLI flow**

If role arguments are absent and no manifest exists, ask project name and repeatedly collect role ID, display name, responsibility, and optional instruction additions; show the complete role list and require confirmation. If a valid manifest exists, use its roles non-interactively unless new role arguments explicitly replace it. The dialogue entry point calls the same argument parser/engine after obtaining equivalent confirmation through Kimi.

Default `--project-root` to the current directory and `--project` to the directory basename. Resolve the default source-plugin path from standard Kimi Work installation paths, with `SYNLOQ_PLUGIN_SOURCE` as an explicit override. Print role bindings, config paths, and a single Install/Update instruction; never print credential contents or claim readiness before channel verification.

- [ ] **Step 4: Update documentation**

Replace the hand-written role/token setup as the primary flow with one install and `synloq init` example. Keep advanced JSON reference only for unsupported/custom hosts. State that relay auto-start is introduced by the companion lifecycle change only after that change is actually merged; until then retain the existing relay prerequisite without requiring token edits.

- [ ] **Step 5: Run verification**

Run: `pnpm vitest run test/cli test/init test/config test/host/kimi-work/control-client.test.ts`
Run: `pnpm verify`
Expected: all tests PASS; format, typecheck, and build PASS. Record exact totals.

- [ ] **Step 6: Review checkpoint**

Run `git diff --check`, inspect `git status --short`, and report changed files and known limitations. Do not commit, register a generated plugin, or perform live chat creation without the operator's approval for that external/local mutation.

---

### Task 5: Isolated generic-init live smoke test

**Files:**

- Create: `docs/superpowers/specs/2026-11-11-synloq-generic-init-acceptance.md`

**Interfaces:**

- Consumes: built CLI, generic source plugin, existing compatible relay.
- Produces: sanitized observed evidence for arbitrary test roles.

- [ ] **Step 1: Initialize an isolated test project**

Use a temporary project under Synloq runtime, two non-production roles, an isolated `SYNLOQ_HOME`, and a separate generated source directory. Keep the current CTO/Architect bindings and managed plugin untouched. Run the real CLI and record its non-secret JSON.

- [ ] **Step 2: Validate and register only the isolated source**

Run `validate_plugin.py` with 0 errors and the supported personal registration command. Registration is not installation; ask the operator to click Install/Update if the host requires it.

- [ ] **Step 3: Verify exact visible chats and rerun**

Confirm both created chats are ordinary visible client conversations in the isolated workspace and the operator's active chat did not change. Repeat identical init and assert no additional chats or credential generations. Record real IDs only in local evidence if needed; sanitize the committed report.

- [ ] **Step 4: Record limits**

Document whether hot reload exposed both channels, whether registration/install remained manual, and that automatic relay/failover is not accepted until the companion plan passes. Do not claim full team readiness from creation alone.

- [ ] **Step 5: Review checkpoint**

Run `pnpm verify` after documentation formatting and report exact results. Do not commit without explicit approval.
