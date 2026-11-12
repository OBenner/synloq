# Synloq Threat Model

- Status: accepted
- Date: 2026-11-12
- Author: Security
- Supersedes: section 1 of `docs/security/review-2026-11-12.md`

Synloq is a local-first message relay between visible coding-agent chats: a loopback
HTTP relay (`127.0.0.1:4100` by default) with durable SQLite state, and per-role MCP
stdio channels authenticated by bearer tokens.

## Assets

1. **Role and operator bearer tokens** (`<synloqHome>/credentials/`). The operator
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
- **Health marker before credentials**: a role channel verifies the unauthenticated
  `GET /v1/health` marker before ever sending its bearer token, so an unrelated
  process that merely occupies the port does not receive credentials (added in
  `56bfeae`; residual risk R1 below).
- **No sender spoofing**: `from` is derived from the authenticated identity, never
  from client input. Inbox reads, acknowledgements, and reply parents are authorized
  per recipient.
- **Tokens**: 256-bit random, stored at rest as SHA-256 hashes, compared with
  `timingSafeEqual`; token files are written with mode `0600` and never copied into
  plugin sources.
- **Delivery fail-closed**: claims are bound to `(sessionId, generation)`;
  `DELIVERY_UNCERTAIN` without client idempotency quarantines the message and pauses
  the participant instead of replaying blindly.
- **Storage**: SQLite WAL with immediate transactions; dedup on
  `(project, sender, idempotencyKey)`.

## Known limitations (accepted, tracked in `docs/backlog.md`)

- **R1 — health marker is static and public.** A _targeted_ squatting process that
  mimics the `/v1/health` response can still capture a role token during a probe or
  reconnect cycle. On multi-user machines, treat the relay port as untrusted. Mutual
  relay authentication (per-project challenge) is the planned hardening.
- **Single relay writer is a discipline, not a mechanism.** Running two writers for
  one project database preserves storage integrity (SQLite serializes writes) but
  splits in-memory rate limiting and dispatching.
- **No per-identity connection limits.** An authenticated participant can exhaust
  relay resources with parallel long polls (tracked as M2).
- **Token files are plaintext at rest** (hashes protect the store, not the files);
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
