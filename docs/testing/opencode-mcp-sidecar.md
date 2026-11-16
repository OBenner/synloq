# OpenCode MCP sidecar live checklist (#67)

Status: pending operator window. Automated tests are not live conformance.
Use one isolated role and a known visible OpenCode session. Coordinate the window
through dev; do not launch production CLI commands from a development worktree.

1. Record the reviewed commit, installed runtime path/version, OpenCode desktop
   version, role, exact visible session ID, and the generated MCP configuration
   path. Keep credentials and service passwords out of captured evidence. Have
   the operator install/build the reviewed runtime through the normal deployment
   workflow, then restart the role's MCP child against it.
2. Stop any manual delivery process for that role. Wait until its lease expires
   (15 seconds after the last heartbeat or close). Confirm the generated binding
   contains the intended `sessionId`; a missing ID requires init/reconciliation.
   Inventory processes: there should be no extra `adapter --config` child.
3. Open the existing visible role session and allow MCP startup. Record its child
   PID, stderr startup line, audit `registerSession` with `surface 'opencode-mcp'`,
   resulting generation, and doctor registration/lease/state fields. There must
   be one accepted registration and one generation, no registration loop.
4. Leave that session idle without typing into or manually reactivating it. Send
   one uniquely marked Synloq message from the coordinating role. Correlate the
   relay message ID, claim/generation, queued prompt admission, client message
   ID, and the visible turn in the exact target session. Require the role to read
   its inbox and acknowledge/reply itself. HTTP success alone does not pass.
5. While the role is busy, send a second marked message. Check there is no steering
   and no second simultaneous runner. Once idle, verify normal FIFO admission and
   exactly one reply. Exercise stored-ping separately if mail remains stored;
   never treat a ping as acknowledgement of its message body.
6. Briefly restart the relay through the approved operator procedure. The child
   retains its binding/tracker during transient transport failure; after recovery
   verify delivery resumes without a new registration generation. Record any
   incomplete receipt and ensure it is completed without a duplicate prompt.
7. Start a manual sidecar for the same visible session. Its normal registration
   advances generation. Verify the old MCP runner/heartbeat rejects the stale
   generation, stops, and does not re-register. Closing that old MCP child must
   leave the manual owner's generation and state unchanged.
8. While that manual lease is live, restart the role MCP child. Expect one
   `DUPLICATE_SESSION`, an stderr ownership diagnostic, and doctor's last MCP
   registration outcome `blocked`. Manual delivery must continue; ordinary MCP
   inbox/list must remain available. Repeat the duplicate-child case. Test a
   different writer session only on the isolated role using operator takeover;
   its write checks must still return `NOT_WRITER` to the old visible session.
9. Restore the intended binding through operator `replace-session` if needed.
   Stop the prior transport, wait for lease expiry, and restart the intended MCP
   child. Confirm registration and delivery recover. A stopped child does not
   automatically attempt takeover after generation rejection.
10. Close the role/MCP child. Confirm its event stream, heartbeat, runner, and
    stored-ping timer stop; the matching generation reports closed. No orphan
    delivery process should remain. Save sanitized timestamps, IDs, process
    observations, doctor/audit output, and the visible-turn evidence per row.

Limitations: restarting an MCP child while its previous lease is live deliberately
fails closed, even if both use the same session ID. Doctor's registration field
records the latest attempt, not current runtime ownership; compare its timestamp
with heartbeat and host checks. No host capability flag or prompt API contract
changes in this increment. Fault-injection rows without operator evidence remain
pending; Codex and Claude work is tracked separately.
