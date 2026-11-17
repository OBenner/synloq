# AGENTS.md — you are an AI agent meeting a Synloq project

Synloq is a local-first coordination layer between **visible** coding-agent
chats. A supervised loopback HTTP relay owns durable SQLite state; each role
(an ordinary chat in the host client) gets exactly six MCP tools
(`synloq_list`, `synloq_send`, `synloq_reply`, `synloq_inbox`, `synloq_wait`,
`synloq_ack`) on its own authenticated channel.

Synloq is **not** an orchestrator: no hidden or replacement chats, no
autonomous workflows, no auto-merge/push, no remote delivery. The human
operator steers every role chat directly.

## If the user asks you to set up Synloq on a project

Do **not** clone this repository to install. The published npm package ships
the compiled runtime and the Kimi Work plugin template.

1. Prerequisite: Node.js 24+ (`node:sqlite` is used).
2. Run:

   ```bash
   npx synloq@latest init --project-root /absolute/path/to/project
   ```

   (`npm i -g synloq` first if the user prefers a permanent install.) A
   committed `synloq.yaml` in the project supplies the role roster; otherwise
   init runs a confirmation wizard or take `--role "id:Title:Responsibilities"`
   flags with `--non-interactive`.

3. **Kimi Work**: register the generated `plugins/synloq` directory as a
   personal plugin source, use the client's single **Install/Update** action,
   then confirm roles in a project chat. Role chats appear and coordinate
   automatically — no separate server, no manual MCP config.
4. **Other hosts** (OpenCode, Codex CLI/Desktop, Claude Desktop): each host
   registers its MCP channel natively. Follow the per-host file in
   `docs/adapters/` — never hand-craft what `synloq init` can generate.
5. Verify: `synloq doctor --project-root <project>` and
   `synloq status --project-root <project>`.

Build from source (`pnpm install && pnpm build`) only when the user explicitly
asks for development on Synloq itself.

## If the repository already uses Synloq

- Roster and hosts: `synloq.yaml` (+ optional gitignored `synloq.local.yaml`
  overlay). Team rules for role agents: `TEAM.md`.
- Documentation hub: `docs/README.md`. Protocol spec: `docs/protocol/v1.md`.
- Adding a role: re-run `synloq init`; the result's `nextStep` says whether the
  client needs Install/Update.

## Hard rules for any agent in this repo

- Never commit credentials, `~/.synloq` state, MCP/adapter JSON with tokens,
  SQLite files, logs, or evidence containing message bodies.
- Never place a token in a config file or on a command line; the generated
  channel configs reference token files only.
- Role agents use **only** their own channel's tools, acknowledge after actual
  reading (`synloq_ack`), reply in the original thread (`synloq_reply` with a
  new idempotency key), and prefix outcomes `RESULT`/`BLOCKED`. No risky
  actions without the operator.
