# Synloq — Production-Readiness Plan

- Status: accepted (operator, 2026-11-12)
- Date: 2026-11-12
- Authors: CTO (consolidation), Architect (architecture/GitHub), Security (security gates)
- Sources: arch thread b7d31611, security thread 4a9813e9, consolidated review thread bcc7b70f

## 0. Current state

- Branch `feat/synloq-mvp`, HEAD `c82f5e5`; `pnpm verify` green: 51 files / 451 tests.
- Protocol spec v1 accepted (`docs/protocol/v1.md`); spec↔code gaps recorded in §9 of the spec.
- H1/H2 closed (`56bfeae`): health marker before sending the token; fail-closed loopback validation on all paths.
- Team: 4 roles (cto, arch, security, dev); coordination via relay confirmed live.

## 1. Target milestones

| Milestone                  | Content                                    | Estimate               |
| -------------------------- | ------------------------------------------ | ---------------------- |
| **M1. Public alpha (0.x)** | GitHub gates G1–G8 + security must-haves   | **3–5 working days**   |
| **M2. v1.0 production**    | All items A–E + P1.1 + full security scope | **10–14 working days** |

Strategy: go public as a public alpha right after the M1 gates, without waiting for v1.0 — early publication is cheaper than late history cleanup.

## 2. GitHub gates (M1, must-have)

| #   | Item                                                                                                                                                                                                               | Owner        | Estimate |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------- |
| G1  | LICENSE (**decided: Apache-2.0**) + NOTICE; fix `license: "UNKNOWN"` in kimi.plugin.json                                                                                                                           | cto/dev      | 0.5 d    |
| G2  | Git history audit (46 commits): gitleaks across the full history, manual review of docs/superpowers/specs and test/e2e for conversationKey/sessionId/UUID. Security pre-check: history is clean, no rewrite needed | security     | 1 d      |
| G3  | CI: GitHub Actions — `pnpm verify` on push/PR, Node LTS matrix, `--frozen-lockfile`, `pnpm audit`, gitleaks job                                                                                                    | dev          | 1 d      |
| G4  | Branch protection on main: CI green required, 1 approve, no force-push, linear history                                                                                                                             | operator/cto | 0.5 d    |
| G5  | Templates: `.github/ISSUE_TEMPLATE`, `PULL_REQUEST_TEMPLATE` (checklist: docs updated? tests? protocol touched?)                                                                                                   | dev          | 0.5 d    |
| G6  | `.gitignore`: `.synloq/` entirely, `*.token`, `.env*`, `*.log`                                                                                                                                                     | dev          | 0.1 d    |
| G7  | `CONTRIBUTING.md` (verify, conventional commits, no DCO/CLA)                                                                                                                                                       | cto          | 0.5 d    |
| G8  | Public-quality README: quickstart install→init→roles, known limitations (R1, relay restart after synloq.yaml changes)                                                                                              | dev          | 1 d      |

### Security must-haves for M1 (block publication)

| #    | Item                                                                                                                                                                                    | Estimate   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S-G1 | **rotate-token + revoke** (command + runbook) — without rotation any leak means recreating the project                                                                                  | 2 d        |
| S-G2 | Remove the dead-code initCommand that returns plaintext tokens (L1)                                                                                                                     | 0.5 d      |
| S-G3 | Reconcile spec↔impl: hops 4 vs "8" in role instructions; operator escalation channel (operator is not a participant — NOTICE impossible); forward-compat (strict zod vs ignore unknown) | 1.5 d      |
| S-G4 | R1 (forgeable health marker) as a known limitation in README + threat model                                                                                                             | (in G8/D2) |
| S-G5 | `docs/security/threat-model.md` (public version)                                                                                                                                        | 0.5 d      |
| S-G6 | `SECURITY.md`: responsible disclosure, supported versions, threat model scope                                                                                                           | 0.5 d      |
| S-G7 | Supply chain: frozen-lockfile in CI, Dependabot, engines baseline (Node 24+)                                                                                                            | (in G3)    |
| S-G8 | `docs/security/token-rotation.md`: rotate/revoke runbook, 401 diagnostics                                                                                                               | 0.5 d      |

**Post-release (safe to defer):** M2 (long-poll limit), M3 (retention/GC), extended audit log, SBOM/release signing/SLSA.
**Exception:** M4-min (minimal audit: auth failures + operator actions + credential issue/rotate) — **before release**, because the rotation runbook is blind without audit (1.5 d).

## 3. v1.0 roadmap (M2)

### A. Protocol/API

- A1. Spec v1 implementation: `version/type/hops/reasonCode` fields in the domain and store — 3–4 d.
- A2. Spec v1.1 (requireParticipant also checks the sender; reserve sender ids `relay`/`operator`) + implementation — 1–2 d.
- A3. Protocol conformance suite as a standalone set — 1 d.
- A4. Compatibility policy (minor = extension, major = new version) in the spec — 0.5 d.

### B. State/credentials migrations

- B1. version field in state/credentials (modeled on `.synloq-owner.json`), forward-only, fail-loud — 1–2 d.
- B2. Rule + first sample "old state → new binary" test — 0.5 d.

### C. Observability

- C1. P1.1: relay-side enforcement (role-token ↔ conversationKey), deny-audit JSONL, conformance tests, threat model — 2–3 d (plan: docs/superpowers/plans/2026-11-12-synloq-p1-1-relay-security-enforcement.md).
- C2. Metrics: accepted/denied/delivered counters, supervisor-loop state, protocol version in health — 1–2 d.
- C3. Runbook for the audit log and delivery_uncertain diagnostics — 0.5 d.

### D. Packaging/distribution

- D1. Single artifact: install → init → roles with no manual edits; idempotent init for 4+ roles — 2–3 d (least predictable item).
- D2. Release semver; plugin regeneration preserves projectKey (digest stability) — 0.5–1 d.
- D3. Upgrade-path test: plugin update does not break runtime configs and chats — 1 d.

### E. Hosts

- E1. Host contract as a document (capabilities, session lifecycle, delivery receipt) — 1 d.
- E2. Kimi Work — production; other hosts — beta/post-1.0 (CTO decision: **accepted, P2**).

## 4. Documentation governance (in effect since plan acceptance)

**Required set:** README.md (root), docs/protocol/v1.md, CHANGELOG.md (Keep-a-Changelog), docs/adr/ (Status/Context/Decision/Consequences), docs/runbooks/, docs/security/threat-model.md, SECURITY.md.

**Rules:**

1. Documentation is updated in the same commit as the code; a PR without updates to affected docs is not merged (an item in the PR-template review checklist).
2. Ownership: protocol spec — CTO + Architect (dual approve); runbooks — subsystem owner; README/CHANGELOG — CTO; security documents — Security.
3. Documents are versioned by git; only the protocol is versioned separately (the `version` field). Every document carries a date and a status (draft/accepted/superseded).
4. Internal materials (docs/superpowers/plans, research) stay out of the public contour or move to docs/design after cleanup.
5. Spec changes only via PR with the protocol version stated.

## 5. Open decisions (operator)

1. **License — decided: Apache-2.0** (2026-11-12).
2. **Publishing `docs/superpowers/` — decided: publish with full history** (content audited, no secrets; 2026-11-12).
3. Repository name/organization on GitHub (working default: `synloq`).

## 6. Risks and estimate limitations

- Team velocity estimated from the last 2 days; D1 (init UX) is the least predictable item.
- Multi-user machines: residual R1 remains (known limitation; mutual relay authentication is in the backlog).
- All estimates in person-days; dev+arch+security parallelism is already reflected in the milestone ranges.
