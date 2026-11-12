# Security Policy

## Scope and threat model summary

Synloq is a **local-first** message relay. All relay traffic stays on explicit loopback HTTP origins (`127.0.0.1` / `::1`); there is no remote listener by design. Every authenticated endpoint requires a per-role bearer credential. The full threat model, including what is deliberately out of scope, lives in [docs/security/threat-model.md](docs/security/threat-model.md).

In scope for vulnerability reports:

- Credential theft, forgery, or replay against the relay or the MCP channels.
- Bypass of the loopback-only enforcement (relay listener, MCP/adapter configuration, HTTP client).
- Cross-role authorization bypass (reading another role's inbox, spoofing `from`, acknowledging or answering as another role).
- State corruption or unauthorized delivery through the relay's HTTP API.
- Dependency vulnerabilities with a plausible exploit path in Synloq's usage.

Out of scope (accepted by design, see the threat model):

- Attacks that require code execution as the operating-system user who owns the Synloq home (such a process can already read the token files).
- Content-level trust between agents (prompt injection via message payloads): the relay is a transport, not a content filter.
- Deployments that expose the relay on non-loopback interfaces — such configurations are rejected fail-closed and unsupported.
- Denial of service by an authenticated participant of the same project.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories ("Report a vulnerability" on the repository's Security tab). Do not open public issues for security reports.

Include: affected version/commit, the threat-model assumption you believe is violated, reproduction steps or a proof of concept, and whether the issue requires local access.

## Response targets

- Acknowledgement: within 3 business days.
- Initial assessment and severity: within 14 days.
- Fix or mitigation: targeted by severity — critical (credential/authorization bypass) as soon as feasible, others in the next regular release.

We will credit reporters unless they prefer otherwise.

## Supported versions

Until 1.0, only the latest release receives security fixes. After 1.0, the latest minor release line is supported.

| Version          | Supported |
| ---------------- | --------- |
| latest 0.x / 1.x | yes       |
| older releases   | no        |

## Operational security docs

- Threat model: [docs/security/threat-model.md](docs/security/threat-model.md)
- Token rotation runbook: [docs/security/token-rotation.md](docs/security/token-rotation.md)
