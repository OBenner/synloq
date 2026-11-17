# Installation and initialization

## Requirements

- Node.js 24 or newer (SQLite support is provided by `node:sqlite`).
- pnpm 12.18.0 for a repository checkout.

## Install without a checkout (published package)

One command:

```bash
npx synloq@latest init --project-root /absolute/path/to/project
```

`npx` downloads the published package, which ships the compiled `dist` runtime
and the Kimi Work plugin template; `init` renders the role channels from that
template directly. To install the command permanently: `npm i -g synloq` (or
prefix any command below with `npx synloq@latest`).

From a clean checkout instead:

```bash
pnpm install --frozen-lockfile
pnpm build
```

To create a local installable archive without publishing:

```bash
pnpm pack --pack_destination .tmp-pack
```

(The flag is `--pack-destination`.) The archive contains the compiled `dist`
runtime, the `plugins` template, README, and package metadata. It excludes
sources, tests, runtime databases, credentials, logs, IDE state, and message
bodies.

## 1. Install the plugin and initialize roles

For Kimi Work, register `plugins/synloq` through the supported personal-plugin
source flow and install it in the client. Ask the agent to **Initialize Synloq
for this project**. The skill confirms the project name and each role's stable
ID, display name, responsibilities, boundaries, and optional instructions before
running `synloq init`.

With no role arguments, `synloq init` starts the same confirmation wizard
directly:

```bash
synloq init --project-root /absolute/path/to/project
```

A non-interactive example with two arbitrary roles:

```bash
synloq init \
  --project-root /absolute/path/to/project \
  --project example \
  --role "product:Product:Own scope and priorities" \
  --role "reviewer:Reviewer:Review evidence and risks" \
  --plugin-source /secure/synloq-plugin \
  --synloq-home /secure/synloq-home \
  --non-interactive
```

Initialization creates ordinary visible Kimi Work client chats without
activating them, binds each exact conversation to its role, writes resumable
state after every creation, and renders the personal plugin source with one
authenticated MCP channel per role. Re-running the same command reconciles
exact bindings and does not create duplicate chats. Use
`--conversation <role-id:conversationKey>` to bind an existing visible chat
instead.

The JSON result contains role bindings and generated file paths, but no
plaintext tokens. Per-role token files are reused from the explicit Synloq home
and never copied into plugin source. Do not commit token files, MCP
configuration, SQLite files, logs, evidence containing message bodies, or IDE
state.

When the result contains `registrationRequired: true`, use the client's single
**Install/Update** action for the generated personal plugin. The result also
carries `channelsChanged` and a human-readable `nextStep`: when a re-init did
not change the channel set, no Install/Update is needed; when it did, the next
step says so explicitly (relay and role tokens need no restart). Source
registration, plugin installation, channel availability, and end-to-end
readiness are different states: do not claim readiness until both generated
role channels have been checked. Adding a role to a live project is covered by
[add-role.md](../add-role.md).

An existing `synloq.yaml` can supply the same role declarations without
`--role` arguments:

```yaml
version: 1
project: example
language: en # en | ru — agent-facing wrapper and role instructions (default en)
retention:
  days: 7 # optional; acknowledged message retention (default 7)
agents:
  product:
    title: Product
    role: Own scope and priorities
  reviewer:
    title: Reviewer
    role: Review evidence and risks
```

The optional top-level `language` field (`en` or `ru`, fail-loud on any other
value) selects the language of the delivered-message wrapper and the generated
role instructions. Protocol frames, reason codes, and relay notices stay
English. Init also accepts `--language en|ru`; re-running init without the flag
preserves the language already in `synloq.yaml`. A language change takes effect
after re-init and a channel restart, like any other manifest change. A missing
locale key falls back to English with a warning.

The optional `retention.days` setting accepts integers from 1 to 36500
(default 7). The relay periodically removes only acknowledged messages older
than that many days; unread messages remain available. Idempotency records last
the full seven-day window even when a shorter policy removes bodies earlier.
Init preserves this setting; restart the relay after changing it. See
[retention, migration and limits](../storage-retention.md).

## 2. Automatic relay lifecycle

Generated Kimi Work role channels reuse or start the project relay
automatically at `http://127.0.0.1:4100`; no separate `synloq serve` terminal
is required. The first compatible MCP process owns the loopback listener and
SQLite writer, while other roles reuse it after authenticated project
validation. If the owner stops, a surviving channel performs bounded
reconnection and listener election, invalidates its old host registration, and
registers a new generation after recovery. Durable messages remain in SQLite.

Only explicit loopback HTTP origins with nonzero ports are accepted. An
unrelated listener, wrong project, invalid credential, malformed response, or
ambiguous endpoint fails closed instead of starting a second writer. A Kimi
Work delivery failure does not remove the six MCP inbox tools while the relay
remains healthy.

For advanced diagnostics or a custom standalone topology, `serve` remains
available:

```bash
synloq serve \
  --project-root /absolute/path/to/project \
  --host 127.0.0.1 \
  --port 4100
```

The command prints a `relayUrl` and runs until SIGINT or SIGTERM. Port `0`
selects a free port for automated tests. Run exactly one writer for a project
database; do not start this command alongside the generated automatic topology
unless they intentionally share the single compatible relay.

### Kimi Work embedded visible delivery

Generic initialization writes a strict `kimiWork` binding and explicit
`synloqHome` for each role. The same MCP child process then supervises the
relay and owns the active-delivery runner; no separate adapter process is
required:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/synloq-home/tokens/reviewer.token",
  "synloqHome": "/secure/synloq-home",
  "kimiWork": {
    "projectRoot": "/absolute/path/to/project",
    "agentId": "reviewer",
    "conversationKey": "agent:main:main:conversation:exact-client-conversation-uuid",
    "workAgentId": "main"
  }
}
```

`agentId` is the Synloq role declared in `synloq.yaml`; it is distinct from
Kimi Work's `workAgentId`. The relay authenticates the role token and validates
its project, role, and session binding during adapter registration.
`conversationKey` must identify an existing visible `origin: "client"`
conversation in the same canonical project workspace. The installed Kimi Work
local-control endpoint and token are discovered in memory through
`kimi-daimon status --json`; tokens are never added to role JSON.
`KIMI_WORK_EXECUTABLE`, `KIMI_WORK_CLI`, and `KIMI_WORK_CONFIG` are optional
installation overrides.

The bridge revalidates exact metadata and fresh idle state before one
`conversations.send`. `delivered` means visible user-turn admission only, not
model completion, reading, acknowledgement, or task completion. The receiving
agent must call `synloq_ack` after actual reading and use `synloq_reply` for
the original thread. Ambiguous sends receive bounded read-only history
reconciliation; they are never blindly replayed. Risky actions still require
operator approval.

If host initialization fails, all six MCP inbox tools remain available while
relay startup succeeds. Closing the MCP process closes its runner, adapter, and
Synloq registration without closing Kimi Work; it closes only a relay listener
owned by that process, allowing surviving roles to recover.

## 3. The six agent-facing tools

| Tool           | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `synloq_list`  | List project participants and role descriptions.                     |
| `synloq_send`  | Send one direct message with an idempotency key.                     |
| `synloq_reply` | Reply to an incoming message in its original thread.                 |
| `synloq_inbox` | Read the authenticated role's incoming history.                      |
| `synloq_wait`  | Bounded long poll for the next incoming message; timeout is normal.  |
| `synloq_ack`   | Acknowledge a delivered message addressed to the authenticated role. |

There are no agent-facing registration, credential, pause, resume, replacement,
doctor, permission, or capability-management tools.

The application-level message protocol between roles and the relay (message
types, envelope, idempotency, hop limit, failure handling) is specified in
[protocol/v1.md](../protocol/v1.md) (status: Accepted).

### Manual MCP configuration (advanced)

Generic initialization writes these files automatically. For a manual legacy
setup, create a strict JSON file outside Git, for example
`/secure/reviewer-mcp.json`:

```json
{
  "relayUrl": "http://127.0.0.1:4100",
  "credentialPath": "/secure/reviewer.token"
}
```

This legacy shape requires a compatible relay to be running already. Automatic
startup is enabled only for generated configuration with an explicit
`synloqHome` and exact `kimiWork` binding. The stdio command is:

```bash
synloq mcp --config /secure/reviewer-mcp.json
```

(From a repo checkout the same command is
`node /absolute/path/to/synloq/dist/cli/main.js mcp --config /secure/reviewer-mcp.json`.)

Use the recipient role's own credential in each chat. Do not place a token in
JSON or on a command line.
