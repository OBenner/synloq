# Socket.dev supply-chain triage — synloq@0.0.2 (2026-11-13)

**Issue:** [#25](https://github.com/OBenner/synloq/issues/25)
**Source:** <https://socket.dev/npm/package/synloq/alerts/0.0.2?tab=dependencies>
**Triage:** CTO (automated, 2026-11-13) — [full breakdown comment](https://github.com/OBenner/synloq/issues/25#issuecomment-6846695623)
**Reachability analysis:** security role, 2026-11-13 (this document)

## Scope and method

139 alert instances across 13 alert types, 98 transitive packages + root, full
dependency tree snapshot taken via Socket.dev internal API. Each alert type was
classified as true positive / acceptable-by-design / false positive. The single
actionable alert (gptSecurity on `@modelcontextprotocol/sdk@1.32.2`) received a
dedicated reachability analysis against the installed package and the synloq
codebase (this document, §2).

No dependency versions were changed during triage (out-of-scope rule honored).

## 1. Verdict summary (all 13 alert types)

| #   | Alert type             | Category        | Severity | Instances | Verdict                                             |
| --- | ---------------------- | --------------- | -------- | --------- | --------------------------------------------------- |
| 1   | socketUpgradeAvailable | maintenance     | high\*   | 8         | Not a vulnerability (Socket upsell)                 |
| 2   | networkAccess          | supplyChainRisk | middle   | 33        | Acceptable by design (loopback HTTP/WS server, CLI) |
| 3   | usesEval               | supplyChainRisk | middle   | 6         | Acceptable (known `Function`-constructor patterns)  |
| 4   | shellAccess            | supplyChainRisk | middle   | 1         | Acceptable by design (cross-spawn for role CLI)     |
| 5   | gptSecurity            | supplyChainRisk | middle   | 1         | **Analyzed — not exploitable in our graph (§2)**    |
| 6   | unmaintained           | maintenance     | low      | 21        | Noise; small stable transitive utilities, monitor   |
| 7   | urlStrings             | supplyChainRisk | low      | 12        | Benign (loopback bind address, schema/doc URLs)     |
| 8   | gptAnomaly             | supplyChainRisk | low      | 16        | False positives (AI notes self-classify as legit)   |
| 9   | newAuthor              | supplyChainRisk | low      | 10        | Informational (known maintainer handoffs)           |
| 10  | envVars                | supplyChainRisk | low      | 20        | Acceptable by design (PATH/DEBUG/NODE_ENV)          |
| 11  | filesystemAccess       | supplyChainRisk | low      | 7         | Acceptable by design (CLI config writes, static fs) |
| 12  | debugAccess            | supplyChainRisk | low      | 3         | Benign (`module`, `async_hooks`)                    |
| 13  | dynamicRequire         | supplyChainRisk | low      | 1         | Benign (express lazy requires)                      |

\* The "high" on socketUpgradeAvailable is Socket's commercial priority, not a
vulnerability severity.

**No critical findings. No install scripts, obfuscation, typosquatting, or
telemetry detected by Socket.**

## 2. Actionable alert: gptSecurity on @modelcontextprotocol/sdk@1.32.2

**Alert (AI note, confidence 0.98):** "demo-server code … unauthenticated trust
in a client-controlled cookie, unescaped HTML interpolation, plaintext API-key
logging, weak elicitation/CSRF validation."

### 2.1 What the alert fires on

The npm tarball of `@modelcontextprotocol/sdk@1.32.2` ships compiled demo
servers under `dist/esm/examples/server/` (and the CJS mirror). The flagged
patterns are real in those files — verified directly:

- `examples/server/demoInMemoryOAuthProvider.js:47-58` — sets an unsigned JSON
  session cookie (`demo_session`) containing authorization data, with
  `secure: false`; session state is later trusted from this client-controlled
  cookie.
- `examples/server/elicitationUrlExample.js:305-322` — `/api-key-form` handler
  takes `session`/`elicitation` ids from the request body (client-controlled),
  logs the submitted API key in plaintext
  (`console.log(\`🔑 Received API key …\`)`), and interpolates values into HTML
  responses without escaping.

These are standalone Express demo applications; they execute only when
explicitly imported or run.

### 2.2 Reachability in the synloq dependency graph

Checked against the installed package and the synloq source tree:

1. **Our imports.** synloq imports only:
   `@modelcontextprotocol/sdk/server/index.js`, `/server/mcp.js`,
   `/server/stdio.js`, `/shared/transport.js` (type), `/types.js` (type) —
   in `src/adapters/claude-channel.ts`, `src/cli/adapter.ts`,
   `src/mcp/stdio.ts`, `src/mcp/tools.ts`. No other entry points.
2. **No transitive edge to `examples/`.** Grep over
   `dist/esm/{server,shared,client}/*.js` and the package root: no module
   outside `dist/esm/examples/` imports anything from `examples/`. The library
   code paths we load never touch the demo servers.
3. **Our build output** (`dist/`) contains no reference to `examples/`.
4. **Residual surface (theoretical).** The package's `exports` map contains a
   wildcard `"./*": "./dist/esm/*"`, so
   `@modelcontextprotocol/sdk/examples/server/…` is importable via a package
   specifier. Nothing in our code or our 98-package dependency tree does this;
   it would require someone to add such an import deliberately in the future.

### 2.3 Decision: ignore (not exploitable), with a hardening follow-up

- **Exploitability: none.** The flagged code is never loaded, let alone
  executed, in any synloq runtime path (relay, MCP stdio channels, CLI).
- **Pin: already in place.** `package.json` pins the exact version
  (`"@modelcontextprotocol/sdk": "1.32.2"`, no range operator).
- **Upgrade: not available.** 1.32.2 is the latest published version
  (npm, last publish 2026-10-23).
- **Re-triage rule:** on any future SDK version bump, this alert will re-fire
  while upstream keeps shipping `examples/` in the tarball; re-run the §2.2
  reachability check rather than re-analyzing from scratch.

### 2.4 Follow-up

- [ ] **#26 — P3 hardening:** CI guard rejecting any import of
      `@modelcontextprotocol/sdk/examples/*` (and generally
      `node_modules/**/examples/**` deep imports), so the theoretical residual in
      §2.2.4 becomes structurally impossible. Optionally report upstream: exclude
      `examples/` from the published tarball / the `exports` wildcard.

## 3. Notes on the remaining alerts (for future triage)

- **usesEval / zod@4.6.7** (3 gptAnomaly notes, conf 0.98): `Function`-based
  codegen is a zod v4 design feature; inputs are our own schemas. Not
  actionable.
- **unmaintained (21 pkgs):** small stable transitive utilities (once, wrappy,
  inherits, …); absence of releases >5 years is the norm for this class.
  Monitor only.
- **newAuthor (10 pkgs):** known ecosystem maintainer handoffs
  (dougwilson → ulisesgascon, isaacs → zkat). Informational.

## Evidence hygiene

This document contains no tokens, credentials, local user paths, or
conversation content. Package paths are relative to `node_modules/` and are
public upstream code.
