# Synloq automatic relay lifecycle acceptance — 2026-11-11

## Scope

This record separates two kinds of evidence:

1. a real loopback/SQLite integration test of surviving-peer relay election;
2. a live Kimi Work process-loss and visible-delivery recovery check.

The live host restarted the stopped role MCP process itself. Therefore the live run proves automatic endpoint and visible-delivery recovery, but it does **not** prove that the surviving peer became owner. Peer election is supported by the integration test below, not relabelled as a live-host observation.

Credentials, local-control tokens, private runtime paths, and full private transcripts are omitted. The live stand used an isolated test-only loopback port and did not touch the production relay.

## Real loopback/SQLite peer election — PASS

`test/e2e/relay-lifecycle.test.ts` starts two real supervisors against one temporary project and SQLite home. It uses no standalone server and no fake HTTP transport.

The test verifies this sequence:

1. The first supervisor owns the loopback listener and SQLite writer.
2. The second supervisor reuses the compatible relay without owning it.
3. The first role stores a durable `QUESTION` for the second role.
4. Closing the first supervisor closes the owned listener.
5. The surviving supervisor detects loss, invalidates its old host registration, elects one new owner, and restarts its host registration.
6. The survivor reads the original question by the same message and thread IDs and acknowledges it.
7. The survivor sends a `RESULT` in the original thread.
8. The original sender's client reads that reply through the recovered endpoint.
9. The participant list still matches the original project manifest.

The test also checks the ordered lifecycle events `host-invalidated` and `host-restarted`. Temporary listeners, supervisors, and directories are closed after the test.

## Live MCP process loss and host recovery — PASS, with the stated boundary

Before fault injection, the only listener on the isolated endpoint belonged to the generated Reviewer `dist/mcp/stdio.js` process with the isolated Reviewer configuration. Its PID was `32644`. The command line was checked immediately before termination; no daemon, production MCP process, or unrelated process was stopped.

After that exact PID was stopped, one listener reappeared with PID `22752`. Its inspected command line was again the generated Reviewer MCP entrypoint and the same isolated Reviewer configuration. This identifies host respawn of the same role, not surviving-Product ownership.

A new visible Product turn then used its own `synloq_send` after recovery:

- message ID: `d54c5179-2bfc-47f1-8df5-0f25cbb0c36d`;
- thread ID: `96d221d0-c9ab-480e-b482-dc94baac3420`;
- idempotency key: `acceptance-live-failover-question-1`;
- created at: `2026-11-11T19:09:03.955Z`;
- `expectsReply: true`.

Reviewer automatically received one framed visible user turn with registration generation `6`, compared with generation `4` for its pre-failure delivery. Reviewer read and acknowledged the question, then replied in the same thread:

- message ID: `4f4cd1d0-2864-4612-abbf-4d17e26c58a4`;
- thread ID: `96d221d0-c9ab-480e-b482-dc94baac3420`;
- `inReplyTo: d54c5179-2bfc-47f1-8df5-0f25cbb0c36d`;
- created at: `2026-11-11T19:09:21.942Z`;
- text prefix `RESULT`.

Product automatically received that `RESULT` as one framed visible user turn with registration generation `4`, compared with generation `3` for its pre-failure delivery. Both new deliveries therefore used newer registrations; neither old recipient registration was reused.

Product read the result and acknowledged it through its own channel. Independent read-only inbox checks after the turn returned `deliveryState: "acked"` for both new messages. Product's inbox also returned the earlier reply `4946566a-e74f-4630-96c5-3997782df647`, demonstrating that pre-failure history remained available.

A final process inspection found exactly one listener on the isolated endpoint, owned by the respawned Reviewer MCP process. No standalone `synloq serve` was started.

## Limits

- A live surviving-peer ownership transfer was not observed because Kimi Work immediately respawned the stopped role process. The controlled real-transport integration test covers that separate branch.
- The live check intentionally stopped only the verified isolated test MCP process. It did not simulate daemon loss, host crash, machine restart, database corruption, or network partition.
- Registration generations are host-registration evidence, not proof of semantic model reading. Visible histories and subsequent role-initiated `acked` states provide the reading evidence.
- Host-enforced per-chat MCP isolation, broad multi-project routing, and other client hosts remain outside this acceptance.
