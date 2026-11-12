# Pre-publication audit — 2026-11-12

- Status: accepted
- Author: Security
- Scope: S1/S2 from production-plan M1 — a scan of the entire git history for secrets + a manual review of evidence documents before opening the repository.
- Method: gitleaks is not installed on the machine; an equivalent scan of the full `git log -p --all` dump (36,610 lines, 46 commits, both branches) was performed with a set of regular expressions + manual review of matches. The gitleaks CI gate (G3/S4) remains mandatory — this report is a one-off.

## S1. History scan

| Pattern                                          | Matches | Verdict                                                                                                        |
| ------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| base64url 43–44 chars (Synloq token shape)       | 21      | All false positives: md file names and `pnpm-lock.yaml` integrity hashes. No tokens.                           |
| PEM private key                                  | 0       | Clean.                                                                                                         |
| Bearer header with a value                       | 1       | Test constant `Bearer test-only-token` in a test. Clean.                                                       |
| password/secret/api_key assignments              | 3       | Test fixtures (`stdio-secret-token`, `nested-secret`). Clean.                                                  |
| token assignments of length ≥ 20                 | 4       | Test fixtures (`never-print-this-token`, `secret-operator-token-do-not-print`, `must-not-be-accepted`). Clean. |
| 64-char hex (sha256 token hash)                  | 0       | Clean.                                                                                                         |
| Home paths (`C:\Users\…`, `/home/…`, `/Users/…`) | 0       | Clean.                                                                                                         |

Additionally: the operator's author email is present in the commit metadata — not a secret, but it is for the operator to decide whether this is acceptable for a public history (see production-plan §5).

**S1 summary: the history is clean, no rewriting required.** There are no real tokens, keys, credential files, SQLite databases, or home paths in the history.

## S2. Evidence documents (conversationKey / sessionId / UUID / message bodies)

All files in `docs/superpowers/specs/*`, `test/e2e/*`, `docs/superpowers/plans/*`, and `docs/client-compatibility.md` were reviewed.

| File                                                       | Found                       | Verdict                                                               |
| ---------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| specs/2026-11-09-synloq-design.md                          | nothing                     | clean                                                                 |
| specs/2026-11-11-codex-adapter-design.md                   | nothing                     | clean                                                                 |
| specs/2026-11-11-deepseek-web-host-adapter-design.md       | nothing                     | clean                                                                 |
| specs/2026-11-11-kimi-work-visible-team-design.md          | 1 UUID (example)            | clean — illustrative identifier                                       |
| specs/2026-11-11-kimi-work-live-acceptance.md              | 8 UUIDs, 2 conversationKeys | sanitized: only local client identifiers, no message bodies or tokens |
| specs/2026-11-11-synloq-generic-init-acceptance.md         | 5 UUIDs, 2 conversationKeys | sanitized                                                             |
| specs/2026-11-11-synloq-relay-lifecycle-acceptance.md      | 4 UUIDs                     | sanitized                                                             |
| test/e2e/real-clients.md                                   | nothing                     | clean                                                                 |
| test/e2e/reference.e2e.test.ts                             | nothing                     | clean                                                                 |
| test/e2e/relay-lifecycle.test.ts                           | nothing                     | clean                                                                 |
| docs/client-compatibility.md                               | nothing                     | clean                                                                 |
| plans/2026-11-12-synloq-p1-1-relay-security-enforcement.md | nothing                     | clean                                                                 |

**Assessment of UUIDs/conversationKeys:** these are local identifiers of the operator's client instance (chat and message IDs), not secrets: without access to the operator's machine they reveal nothing. Publication is safe. A hygiene note: they tie the public repository to a specific Kimi Work instance — a privacy-level concern, not security; for the operator's awareness.

**S2 summary:** no message bodies, tokens, or secrets in the evidence; all files are fit for publication. If the operator adopts rule §4 of the plan (excluding `docs/superpowers/` from the public contour), these files still require only optional UUID cleanup, not mandatory.

## Residual actions (not closed by this report)

1. A gitleaks CI job on PRs + GitHub secret scanning/push protection — gates G3/S4, owner: dev.
2. Extending `.gitignore` (all of `.synloq/`, `*.token`, `.env*`, `*.log`) — gate G6, owner: dev.
3. A rule in CONTRIBUTING/PR template: evidence indexes only participant and message IDs, without bodies or tokens.
