# MCP annotations and child-process audit (#72)

Scope: findings transcribed into [issue #72](https://github.com/OBenner/synloq/issues/72)
from M8ven's audit of `c798857`; rechecked against `1d93b22` and this change.
CTO confirmed that the issue contains the findings and no separate report copy
is held in the repository. This is a scoped code audit, not a new external
penetration test or directory submission. The reported directory rejection rule
was not independently verified; the MCP SDK serialization is tested directly.
No Synloq v1 envelope, tool input schema, relay authorization or dependency changes.

## Annotation decisions

All six tools expose four explicit booleans through MCP `tools/list`. The
[MCP ToolAnnotations specification](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)
defines them as descriptive hints, not authorization. Destructive/idempotent
hints apply to mutations; read-only tools also supply booleans for a complete
catalog entry. Classification below follows the actual Synloq effects.

| Tool           | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| -------------- | ------------ | --------------- | -------------- | ------------- |
| `synloq_list`  | true         | false           | true           | false         |
| `synloq_inbox` | true         | false           | true           | false         |
| `synloq_wait`  | true         | false           | true           | false         |
| `synloq_send`  | false        | false           | true           | true          |
| `synloq_reply` | false        | false           | true           | true          |
| `synloq_ack`   | false        | true            | true           | false         |

- Reads inspect the configured project's roster/mailbox. `wait` may hold a
  request open but does not consume or acknowledge mail. A changed result on a
  later read is not an additional mutation. Their interaction domain is the
  existing project data, not arbitrary external lookup.
- Send/reply append a message, and can cause delivery into another participant's
  host chat. `openWorldHint: true` conservatively communicates this external
  interaction; a fixed participant registry does not make a send a local read.
  Identical requests with the same key are idempotent within the existing
  **seven-day dedup window**. Tool descriptions state that limit. Reusing a key
  with a changed payload is rejected; a new key is a new send. These hints do not
  extend dedup retention or promise idempotency after expiry.
- Ack changes an existing delivery state and removes the message from unread
  results; it also makes it eligible for configured retention. Therefore
  `destructiveHint: true` is the conservative choice rather than claiming an
  additive-only operation. Repeating an ack does not repeat the mutation. Its
  direct interaction domain is the authenticated recipient's relay record.

These annotations neither grant permissions nor bypass writer proof, token
validation, recipient isolation or host confirmations. Receiving hosts remain
responsible for their tool-use policy. Existing behavioral tests remain in place;
the new SDK `tools/list` test pins all six entries and all four boolean values.

## The three reported process calls

The local variables named `exec` are injectable wrappers around Node
`execFile`, not `child_process.exec(commandString)`. No shell command is assembled.
Both production wrappers now explicitly set `shell: false` (previously Node's
default), retain separate executable/argv values and preserve resource bounds.
According to [Node's child-process API](https://nodejs.org/api/child_process.html),
`execFile` launches the executable directly by default. Manual shell quoting is
neither needed nor added. Windows `.cmd`/`.bat` shims are not supported through a
shell fallback; use a native executable.

| Reported site                                                                        | Inputs and execution boundary                                                                                                                                                                                                                                                                                                                                             | Decision                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/host/kimi-work/control-status.ts`, `loadKimiWorkControlEndpoint` (old line 140) | Executable/CLI/config come from local installation paths or operator environment. The argv tokens are CLI path, `--config`, config path, `status`, `--json` on Windows; fixed command tokens on POSIX. `execFile`, 5-second timeout, 1 MiB output cap, hidden window; raw failure output is suppressed. Parsed endpoint must be a credential-free loopback WebSocket URL. | Retain host status CLI: it supplies live endpoint/auth data; parsing private installation state or inventing a replacement host API is not a safer equivalent. Explicit no-shell option and boundary tests added.                |
| `src/host/opencode/discovery.ts`, `pathCli` (old line 171)                           | Fixed `where`/`which` executable and the single literal argument `opencode`; 5-second timeout and 1 MiB cap. Returned candidate is used only as a separate executable argument.                                                                                                                                                                                           | Retain platform locator. A manual PATH/PATHEXT search or added resolver library would change portability/search behavior; no input is interpolated into shell source. Explicit no-shell option is shared with the service probe. |
| `src/host/opencode/discovery.ts`, `serviceBaseUrl` (old line 190)                    | CLI candidate from operator override, version-validated bundle directory or PATH locator; fixed argv `api`, `get`, `/api/info`. 10-second timeout, 1 MiB cap; generic errors; returned service URL restricted to loopback HTTP without embedded credentials.                                                                                                              | Retain discovery CLI: the SDK requires the base URL that this step discovers. Bypassing it through guessed private state is not an equivalent library replacement. Boundary tests cover override and locator paths.              |

Tests mock the native `child_process.execFile` boundary (not the higher-level
injected wrapper), preserving spaces and inert `;`, `&`, `$()` values as complete
arguments. They verify both locator platforms, override paths, no-shell options,
timeouts/output caps and sanitized failures. No host executable or payload command
is run by these tests. Existing discovery tests also cover malformed/non-loopback
outputs and candidate fallbacks.

## Current inventory beyond the historical findings

- `src/host/codex/queue.ts` was added after the old audit. It uses argument-array
  `spawn` with explicit `shell: false`, absolute executable/UUID/version guards,
  a 10-second process timeout and an 8 KiB output bound. Its reminders contain IDs,
  not task bodies; existing tests exercise timeouts, output bounds and exact argv.
  Retained unchanged; see [the queue adapter contract](../adapters/codex-queue.md).
- `scripts/probe-codex-app-server.ts` uses `execFile` for metadata and argument-array
  `spawn` for `app-server`, both without shell opt-in. `cwd` is a separate option;
  thread values travel as JSON-RPC data. `scripts/probe-kimi-acp.ts` spawns fixed
  `kimi`, `acp` argv and sends session data via JSON-RPC. These are explicitly
  invoked probe scripts, not ordinary MCP tool handlers. They are retained and
  were not run against live hosts for this audit.
- Other `.exec(...)` matches are SQLite statements or regular expressions, not
  process execution. Search used `rg -n 'child_process|execFile|spawn|shell:' src scripts`;
  there is no production `child_process.exec`/shell-string call in this inventory.

## Remaining trust boundary

No shell-source interpolation was found in the three reported sites, but this is
**not** executable provenance validation. Local executable overrides, CLI script
paths, environment, PATH and platform executable search (including current-directory
search where applicable) must be trusted. An attacker controlling them can select
code to execute even with `shell: false`. Native binary authenticity and sandboxing
are outside this patch; inherited environment is not a secret-isolation boundary.
Tool message text is not used to select executables or construct these discovery
arguments. Tokens discovered on stdout remain private return data, not logs or argv.

No claim of OpenAI directory acceptance, universal subprocess safety or live
host revalidation is made. External contact with M8ven remains with CTO and the
operator-approved publication workflow.
