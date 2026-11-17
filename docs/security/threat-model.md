# Synloq Threat Model

- Status: accepted
- Date: 2026-11-17 (auth-v2 implementation; final security sign-off approved)
- Author: Security
- Supersedes: section 1 of `docs/security/review-2026-11-12.md`

Synloq is a local-first message relay between visible coding-agent chats: a loopback
HTTP relay (`127.0.0.1:4100` by default) with durable SQLite state, and per-role MCP
stdio channels authenticated by credential-derived auth-v2 MAC proofs.

## Assets

1. **Role and operator credentials** (`<synloqHome>/credentials/`). The operator
   token controls pause gates, session replacement, and operator diagnostics — it is
   the single most sensitive secret of a project.
2. **Message content** stored in the project SQLite database.
3. **Delivery-state integrity** (claims, generations, pause gates): corruption can
   duplicate, drop, or misroute messages between agents.
4. **Availability of the relay**: without it, cross-role coordination stops.

## Trust boundaries

- **Loopback HTTP, no TLS.** Correct for local-first; it means the security boundary
  is the machine, not the network.
- **Per-role MCP stdio channels** hold one role token each and talk to the relay over
  loopback HTTP.
- **The SQLite database and credential store** are local files under the Synloq home.

## Attackers considered

1. **Unrelated local process** (any OS user on the machine) that can connect to — or
   bind — the relay port.
2. **A compromised or malfunctioning project role** holding a valid role token.
3. **Accidental operator errors**: leaked tokens, moved state, downgraded binaries.

## Security properties (current mitigations)

- **Loopback-only, enforced three times, fail-closed**: the HTTP listener rejects
  non-loopback addresses; the relay supervisor validates the configured origin; the
  MCP/adapter configuration schemas and the HTTP client constructor reject any
  non-loopback relay URL.
- **Mutual auth-v2 proofs**: every HTTP client verifies a fresh challenge bound to
  trusted local project/role, boot ID and nonce before sending a business body.
  Request proofs cover method, raw path/query and exact body bytes; response proofs
  cover the request digest, status and exact response bytes. Tokens are never sent.
  Challenges are consumed atomically before dispatch and bounded by TTL, rate and
  capacity. Rotation invalidates outstanding challenges; restart discards them.
  `GET /v1/health` is public discovery, never authentication evidence. See the
  [wire profile](transport-auth-v2.md) for coverage and limits.
- **No sender spoofing**: `from` is derived from the authenticated identity, never
  from client input. Inbox reads, acknowledgements, and reply parents are authorized
  per recipient.
- **Tokens**: 256-bit random, stored at rest as SHA-256 hashes, compared with
  `timingSafeEqual`; token files are written with mode `0600` and never copied into
  plugin sources. The SHA-256 store is authentication-equivalent key material,
  not a safe-to-disclose password verifier. A store leak requires rotation of all
  affected role/operator credentials.
- **Delivery fail-closed**: claims are bound to `(sessionId, generation)`;
  `DELIVERY_UNCERTAIN` without client idempotency quarantines the message and pauses
  the participant instead of replaying blindly.
- **Storage**: SQLite WAL with immediate transactions; dedup on
  `(project, sender, idempotencyKey)`.
- **OpenCode MCP delivery ownership (#67)**: opt-in exclusive registration
  checks the role's lease in the registration transaction, including same-session
  attempts. Generation-fenced heartbeat and close prevent a superseded child
  from updating or closing its successor. A rejected child stops delivery while
  its MCP tools retain their ordinary writer checks. This is cooperative process
  coordination, not a new credential boundary: legacy/manual role clients can
  still re-register the same session without the exclusive flag, and omission of
  optional heartbeat/close generation retains legacy behavior. Expired leases
  permit exclusive registration; cross-role session-ID reuse is still refused.
- **Config placement (#58)**: custom role directories are explicit manifest
  configuration. Init refuses redirected ancestors, project roots, Synloq
  service paths, overlapping role directories, and implicit placement moves.
  Doctor/removal use the recorded location. Codex edits/removal are confined to
  the owned MCP TOML subtree and unchanged generated instructions; foreign
  settings and modified files are retained. These are accidental-overwrite
  protections, not protection against an owning OS user racing filesystem
  changes between validation and writing.

## R1 remediation

**R1 closed in this implementation**: auth-v2 addresses the static-marker
credential-capture path. Security approved implementation `7e59e45` on
2026-11-17 after reviewing the wire profile, key derivation, server/client changes
and conformance evidence. Architecture accepted the contract; the full local
verification passed 111 files / 979 tests. Deployment requires the coordinated
relay/client/config upgrade documented in the [wire profile](transport-auth-v2.md).
This verdict does not establish that an existing installation has been upgraded.

## Known limitations (accepted, tracked in `docs/backlog.md`)

- **No confidentiality against an active forwarding proxy**, even under another
  OS user: MACs prevent undetected alteration, not observation, delay or forwarding
  of plaintext. This profile does not detect an unmodified forwarder.
- **Unauthenticated local denial of service remains possible**: challenge issuance
  has a global rate/cap but a local attacker can occupy those resources.
- **Single relay writer is a discipline, not a mechanism.** Running two writers for
  one project database preserves storage integrity (SQLite serializes writes) but
  splits in-memory rate limiting and dispatching.
- **Resource caps are not availability guarantees.** Per-identity and relay-wide
  long-poll caps (M2) and auth-v2 challenge limits bound admitted work; a local
  attacker can still compete for capacity or hold unauthenticated connections.
- **Token files and authentication-equivalent hashes are secrets at rest**;
  file permissions are the only barrier.

## Explicitly out of scope

- **Compromise of the owning OS user**: a process running as the user who owns the
  Synloq home can read token files and rewrite `credentials.json` directly.
  _Compromise of any of the user's processes means compromise of all project roles._
- **Content-level trust**: message payloads are opaque text. Prompt injection or
  social engineering between agents is a workflow concern, not a relay vulnerability.
- **Non-loopback deployment**: the relay refuses non-loopback listeners; running it
  behind a tunnel/proxy that exposes it externally is unsupported.
- **Denial of service by an authenticated project participant** beyond the existing
  send-path rate limits.
