# ADR 0001: Project boundaries and message routing

- Status: accepted
- Date: 2026-11-13
- Deciders: Architect (proposal), operator (approval)
- Related: `docs/protocol/v1.md` §2 (participants), §5 (idempotency)

## Context

Recurring questions from operators evaluating Synloq:

1. Must all roles that talk to each other live in one project?
2. How does the relay know which concrete chat a message addressed to a role
   goes to?
3. What happens if two stands use the same role ids or similar chat names?

These are architecture-level facts, but they were previously only implied
across the spec, README, and code — never stated in one place.

## Decision

### One project = one team = one relay

A project is the namespace and the trust boundary: one `synloq.yaml`
participant registry, one relay, one SQLite store. Protocol v1 has no notion
of "another project" — cross-project messaging (relay federation) is
explicitly out of scope for v1 and would require a new major protocol version.

### Routing resolves the role, not the chat

A message is addressed to a **role id** (`to: "arch"`), never to a chat name.
The relay resolves it in order:

1. Registry: the role must be a registered participant of the project
   (`requireParticipant`).
2. Binding: team state maps the role to one exact host session
   (`conversationKey` / `sessionId`).
3. Credentials: a bearer token is issued per (project, role); the channel
   authenticates as that role in that project only.
4. The adapter bound to that session performs the visible delivery.

Chat titles shown in host UIs play no role in routing.

### Same role ids across stands are safe

Everything is scoped by project:

- A role id in project A and the same role id in project B are distinct
  identities with distinct credentials; project A's relay answers
  `unknown_recipient` for roles it does not register.
- Two projects on one machine run two relays on distinct ports and two
  separate databases.
- One host chat cannot be silently bound to two projects or two roles:
  rebinding requires the operator's explicit `replace-session`.

The only real ambiguity of identical names is human: two chats titled
"Architect" in different projects look alike in the host UI. That is a
labeling concern, not a routing one.

## Consequences

- Adding a cross-stand chat means adding its role to the stand's
  `synloq.yaml` (via `init` / `add-role`), not "connecting" anything
  externally.
- Federation, if ever wanted, is a new design (cross-project addressing,
  credential trust between relays, spec major version) — not an extension of
  the current routing.
- Role ids should be treated as project-local identifiers everywhere:
  credentials, logs, evidence, and docs must always carry the project context
  alongside a role id.

## Alternatives considered

- **Global role registry across projects** — rejected: breaks the trust
  boundary (a token valid everywhere) and complicates revocation for no
  concrete use case.
- **Addressing chats by conversation identity directly** — rejected: leaks
  host-specific identifiers into the protocol and makes rebinding a protocol
  event instead of an operator action.
