# Synloq

[![CI](https://github.com/OBenner/synloq/actions/workflows/ci.yml/badge.svg)](https://github.com/OBenner/synloq/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/synloq)](https://www.npmjs.com/package/synloq)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)
[![M8ven Score](https://m8ven.ai/badge/mcp/obenner-synloq-13lfif?v=217ad9235fa6c5a72917940b272eaa78)](https://m8ven.ai/mcp/obenner-synloq-13lfif?s=readme)

Synloq is a local-first coordination layer between **visible** coding-agent
chats. A supervised loopback HTTP relay owns durable SQLite state, starts
automatically with the generated role channels, and gives each role chat only
six agent-facing MCP tools (`synloq_list`, `synloq_send`, `synloq_reply`,
`synloq_inbox`, `synloq_wait`, `synloq_ack`).

Synloq is not an orchestrator. It does not hide work in replacement chats, run
one-shot model subprocesses, execute workflows autonomously, operate a
dashboard, merge or push changes, or deliver to remote clients. The operator
can inspect and steer every visible role conversation directly.

> **Alpha (0.x).** Synloq is pre-1.0: the wire protocol and on-disk formats may
> change between releases, and database migrations are forward-only. Pin a
> commit and read the release notes before upgrading.

## Quickstart

Prerequisite: Node.js 24+.

```bash
npx synloq@latest init --project-root /absolute/path/to/project
```

Then pick your host:

- **Kimi Work** — register the generated `plugins/synloq` as a personal plugin
  source and use the single Install/Update action. Role chats appear and
  coordinate through the local relay automatically.
- **Other hosts** (OpenCode, Codex CLI/Desktop, Claude Desktop) — each host
  registers its MCP channel natively; see
  [docs/adapters/](docs/adapters/README.md).

Verify with `synloq doctor --project-root <project>`. Full walkthrough
(installation, the `synloq.yaml` manifest, relay lifecycle, the six tools):
[docs/guide/installation.md](docs/guide/installation.md).

## How each host connects

Synloq is host-agnostic: the relay, the CLI, and the per-role MCP channels know
nothing about any specific client. A role joins a host by registering its MCP
server in whatever form that host natively supports — there are no per-IDE
plugin codebases.

| Host           | Connection mechanism                                                                                                                                                       | Live status                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kimi Work      | `synloq init` renders a personal plugin (the only MCP registration surface Kimi Work exposes) and creates the visible role chats through the client API                    | **Verified** on live stands (2026-11-11, 2026-11-14, 2026-11-16)                                                                                                                           |
| OpenCode       | init creates role sessions and MCP entries; the role MCP child starts delivery after exclusive registration                                                                | **Verified** — prompt delivery (2026-11-13); automatic MCP lifecycle live 10/10 (2026-11-16, `docs/testing/2026-11-16-opencode-mcp-sidecar-live-acceptance.md`)                            |
| Codex CLI      | per-role `CODEX_HOME` with hooks — the full-matrix reference track                                                                                                         | **Wake verified** via `codex queue` (idle/busy/fail-loud, 2026-11-16); hooks full-matrix run in progress                                                                                   |
| Codex Desktop  | per-role project directory with `.codex/config.toml`, provisioned by `synloq init` for `host: codex-desktop` roles ([ADR 0004](docs/adr/0004-role-placement-and-claim.md)) | **Verified** provisioning (2026-11-15); opt-in CLI queue nudger live full-cycle (2026-11-16, `docs/runbooks/codex-queue-nudger.md`) — a nudge does not guarantee a turn for unloaded chats |
| Claude Desktop | MCP config; inbox and lifecycle state; next-interaction reminder injection confirmed on the Code tab                                                                       | **Inbox + next-interaction verified** (2026-11-16); no autonomous wake — upstream request tracked (anthropics/claude-code#110364)                                                          |
| ZCode          | API-created chats do not load the workspace MCP config (vendor limitation)                                                                                                 | **Blocked** — manual UI retry pending                                                                                                                                                      |

Role placement is declared per role in `synloq.yaml` (the `host:` field) and
reconciled by `synloq init`
([ADR 0004](docs/adr/0004-role-placement-and-claim.md)). Where a host exposes
no session API, init emits an explicit next-steps checklist or a one-time
claim code — never a silent degradation.

## Clone and run your own stand

A clone of a project that commits a `synloq.yaml` is an **independent stand**,
not a node of someone else's team. The committed manifest declares the default
role roster; credentials, session bindings, and the relay database are always
machine-local under the Synloq home and are never committed.

1. Clone the repository.
2. Run `synloq init` against your checkout — it reconciles the manifest into
   _your_ hosts: your own role sessions, per-role tokens, and your own loopback
   relay.
3. The role chats appear in your client and coordinate through your local
   relay. Two clones never see each other: identical role names are different
   identities on different stands.

The project key is derived deterministically from the canonical project root
path, so two clones at the same absolute path on different machines share a key
value. This is harmless because the relay is loopback-only per machine; revisit
this assumption if remote relays are ever introduced.

Want a different roster or different hosts per role on your stand without
forking the committed manifest? Add a gitignored `synloq.local.yaml` overlay
next to `synloq.yaml` — it merges key by key over the committed manifest
(roles can be added or partially overridden; `project` is the shared namespace
and must not be redefined; a malformed overlay fails loud). Details:
[docs/guide/installation.md](docs/guide/installation.md).

## Support status

Verified live on stands 2026-11-11 through 2026-11-16: Kimi Work visible
delivery, generic init and relay recovery; OpenCode active delivery; Codex
Desktop provisioning and queue nudger; Claude Desktop inbox + next-interaction
reminders. Fault-injection rows and the remaining hosts are tracked in
[docs/client-compatibility.md](docs/client-compatibility.md) and the live
evidence matrix [test/e2e/real-clients.md](test/e2e/real-clients.md) — complete
it with an operator before changing any live support status.

## Documentation

- [docs/README.md](docs/README.md) — the documentation hub: guides per task,
  per-host adapters, protocol spec, ADRs, runbooks, security.
- [docs/guide/installation.md](docs/guide/installation.md) — installation,
  initialization, relay lifecycle, the six tools.
- [docs/guide/operator.md](docs/guide/operator.md) — sessions, single-writer,
  pause/resume, credentials, diagnostics, nudges.
- [docs/faq.md](docs/faq.md) — troubleshooting.
- [AGENTS.md](AGENTS.md) — **for AI assistants**: how to install and work with
  a Synloq project (including the no-clone `npx` install path).

## Security

All relay traffic stays on explicit loopback HTTP origins; every authenticated
endpoint requires a per-role credential. The full threat model, including the
accepted residual risks (R1 health-marker squatting — mutual authentication
tracked as follow-up hardening), operational notes, and the security audit
trail: [docs/security/threat-model.md](docs/security/threat-model.md). Never
commit credentials, `~/.synloq` state, or message bodies.

## Development and verification

Repository checkout: `pnpm install --frozen-lockfile`, then `pnpm verify`
(format, imports, typecheck, tests, build). The automated reference scenario
uses real relay/SQLite and in-memory MCP transport; it does not establish live
host support. Contributing rules: [CONTRIBUTING](CONTRIBUTING.md).
