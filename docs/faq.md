# FAQ and troubleshooting

Short answers to the recurring operational questions. Deep references live in
the [operator guide](guide/operator.md), [installation guide](guide/installation.md),
and [adapters/](adapters/README.md).

## A role is not reacting to messages

Check `synloq status --project-root <project>` first: it shows per-role state,
queued counts, and the reason a role is waiting (`busy`, stale session,
awaiting ack, operator pause). A busy chat holds delivery at the state gate by
design; push-capable hosts (Kimi Work, OpenCode) nudge the chat after 15
minutes, other hosts report `no push on host <host> — check synloq_inbox
manually`. Messages are never lost: they sit in `stored` until the role reads
its inbox.

## 401 / UNAUTHORIZED after token rotation

Rotation rewrites the role's token file, but running channels keep their old
token in memory. Restart the affected role channel (or the whole client) after
`rotate-token`/`revoke-token`. See
[security/token-rotation.md](security/token-rotation.md).

## I changed `synloq.yaml` and nothing happened

Adding a role takes effect on a running relay (the participant registry is
hot-reloaded). Removing a role still warrants a relay restart to drop its
in-memory state. Changes that affect generated channel configurations or role
instructions (language, roster, hosts) require re-running `synloq init` and,
when the result's `nextStep` says so, the client's Install/Update action plus a
channel restart.

## How do I update the plugin after `init` or `add-role`?

Re-run the same `synloq init` command: it reconciles exact bindings without
creating duplicate chats. The JSON result carries `channelsChanged` and a
human-readable `nextStep` — Install/Update in the client is needed only when
the channel set changed; relay and role tokens need no restart.

## Where does Synloq keep its state?

Per project, by default:

```text
~/.synloq/credentials/<project-key>.json
~/.synloq/data/<project-key>.sqlite
```

Relocate with `synloq init --synloq-home <path>`. Never commit token files,
MCP configuration, SQLite files, logs, or evidence with message bodies.
Details: [operator guide — runtime paths](guide/operator.md#runtime-paths-and-external-state).

## A Codex Desktop role is not waking

The opt-in queue nudger must be enabled in
`state/<projectKey>.codex-queue.json` and the owning relay restarted after a
config change. `queue accepted` does not prove a turn started — unloaded chats
may stay inactive; the live acceptance runbook is
[runbooks/codex-queue-nudger.md](runbooks/codex-queue-nudger.md). Check the
nudge journal and diagnostics for `blocked=<state>` rows: a crash leaves a
durable `reserved` owner that is never stolen — it requests operator review.

## What is committed vs local in a cloned project?

The committed `synloq.yaml` declares the default roster and travels with the
repository; credentials, session bindings, and the relay database are always
machine-local. Two clones are two independent stands. Personal deviations go
into a gitignored `synloq.local.yaml` overlay (see the
[README](../README.md#clone-and-run-your-own-stand)).
