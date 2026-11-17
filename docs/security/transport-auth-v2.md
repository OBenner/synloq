# Relay transport authentication v2

Status: implementation for issue #1 approved by architecture and security.
Final security sign-off on implementation `7e59e45` (2026-11-17) closes residual
risk R1 in this implementation; deployment still requires the coordinated upgrade.
This changes HTTP authentication only; the message envelope remains v1.

## Trust and key material

Each client receives trusted `project` and `agentId` from local configuration.
Manual CLI resolves the project from its local manifest and the role from the local
credential store. Neither value is learned from an unauthenticated relay response.
Every request, including health checks and direct clients, verifies a fresh relay
proof before sending its business body. There is no Bearer fallback.

Let V = SHA256(UTF8(token)), using the existing random 256-bit credential. The
credential store's hexadecimal V is decoded to 32 bytes for cryptographic use.
V is authentication-equivalent: disclosure permits impersonation of that role
and a relay to that role. A credentials.json leak requires rotating every affected
credential, including the operator credential. Do not log V, tokens or MAC keys.

F(s1, …, sn) concatenates each UTF-8 field preceded by its unsigned 16-bit
big-endian byte length. Reject fields larger than 65535 bytes; no JSON or Unicode
normalization. Hashes and MACs on the wire are lowercase hexadecimal.

`kid = HMAC-SHA256(V, F("synloq-authv2/kid", project, agentId))`.
For purpose P, derive a 32-byte key using RFC 5869 HKDF-SHA256 with IKM=V,
salt=UTF8("synloq-authv2"), info=F("2", project, agentId, kid, P).
P is exactly `synloq-authv2/challenge`, `synloq-authv2/request`, or
`synloq-authv2/response`. Operator and role credentials use separate material.

## Exchange and byte coverage

1. POST /v1/auth/challenge with JSON `{authVersion:2,project,kid,clientNonce}`.
   Client nonce is a fresh random 128-bit value, hex encoded.
2. Relay responds with those fields plus agentId, instanceId, bootId,
   serverNonce, expiresAt and proof. IDs/nonces are random 128-bit hex;
   expiresAt is an integer Unix timestamp in milliseconds (30-second TTL).
   Instance and boot identifiers are freshly generated for each server instance.
3. Let T be the ordered fields: authVersion as decimal, project, agentId, kid,
   instanceId, bootId, clientNonce, serverNonce, expiresAt as decimal.
   Challenge proof is HMAC(Kchallenge, F(T)). Client validates the strict schema,
   its trusted context, kid, echoed nonce, expiry, and proof before proceeding.
4. D = SHA256(F(T, uppercase method, exact request-target path+raw query,
   SHA256(exact body bytes))). Query order and encoding are significant.
   The request carries x-synloq-auth-version:2, x-synloq-challenge:serverNonce,
   x-synloq-proof:HMAC(Krequest,F(T,D)). Absent body is zero bytes.
5. Relay re-reads the credential store, verifies the request, then atomically
   consumes the challenge before dispatch. No asynchronous boundary separates
   the final lookup, MAC check and consume. Domain authorization remains unchanged.
6. Every response to an authenticated request, including domain errors, carries
   x-synloq-proof:HMAC(Kresponse,F(T,D,decimal status,SHA256(exact response bytes))).
   Client verifies it before interpreting JSON or an error. The echoed client
   nonce and request digest prevent substituting another request's response.

Origin is restricted locally to an explicit HTTP loopback origin; it is not a
MAC field. Keys identify the project/role, not a particular port. A transparent
forwarder can forward the complete exchange; binding a port would not provide
confidentiality or detect such a forwarder. Redirects are rejected at both steps.

## Failure and resource bounds

Challenges are one-use, in memory, capped at 1024 and issued at most 100 per
one-second window per relay. Expired entries are pruned during issuance.
The challenge endpoint is unauthenticated; local denial of service remains possible.
Requests have a 64 KiB body limit. Client challenge responses are capped at 4096
bytes and authenticated responses at 8 MiB (100 bounded inbox messages plus metadata).
No authentication failure retries with a Bearer token or trusts an unsigned error.
Audit denial details use fixed reasons including unknown_kid, stale_challenge,
mac_mismatch and version_mismatch; no request-controlled text.

Rotation changes V and kid, invalidating outstanding challenges. Restart discards
all outstanding challenges; the next operation performs a new exchange. A consumed
long-poll request may outlive its challenge TTL. Rotation/restart during an operation
may fail that operation; application retry and idempotency remain the caller's job.

## Rollout and limits

Update relay, all HTTP callers and generated MCP configs together. Configs now
require project and agentId. Old client/new relay and new client/old relay fail
closed; there is no dual-mode window. GET /v1/health is a public discovery marker,
never authentication evidence. Restart channels after regenerating their configs.

MACs provide authentication and integrity, not plaintext confidentiality. An active
forwarding proxy, including another local OS user's process, can observe, delay,
drop or forward traffic. The protocol does not detect an unmodified forwarder.
Same-user credential access and caller-chat isolation are separate unresolved
boundaries. Asymmetric relay keys or TLS could separate key disclosure impacts or
add confidentiality but would require key provisioning/lifecycle beyond this scope.

References: [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html) for HKDF;
[RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) for coverage considerations
only. This custom profile does not claim RFC 9421 conformance.
