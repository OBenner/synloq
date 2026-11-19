#!/usr/bin/env node
// Guard for test hermeticity as secret hygiene (issue #35).
//
// Tests must never resolve or reference the real user home, real user
// config/credential locations, or OS account paths: a failing test prints its
// values into logs, and logs travel (issues, support bundles, backups). The
// 2026-11-13 incident — a real OpenCode service password landing in test
// output — is the canonical example. Tests inject paths via fixtures,
// vi.stubEnv, or mkdtemp instead.
//
// This script fails when a file under test/ contains a high-signal real-state
// pattern: os.homedir(), tilde home paths, %WINDOWS% account variables, or
// direct reads of home-related env vars. Synthetic absolute fixtures such as
// "/home/test/..." or "C:\\Users\\test\\..." are fine — they never resolve to
// real state. A justified exception carries an inline `allow-real-home: <why>`
// comment on the same line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scannedDirectories = ["test"];
const sourceExtension = /\.(?:[cm]?[jt]s)$/;
const escapeMarker = "allow-real-home";

const patterns = [
  { label: "os.homedir()", regex: /\bos\.homedir\s*\(/ },
  { label: "tilde home path", regex: /~\/(?:\.synloq|\.config|\.local|\.ssh|\.npmrc|\.env)\b/ },
  { label: "Windows account variable", regex: /%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%/ },
  {
    label: "direct home env read",
    regex:
      /\bprocess\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_STATE_HOME)\b/,
  },
];

// Exported for tests: find real-state references with their 1-based line numbers.
export function findHermeticityViolations(content) {
  const violations = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    if (line.includes(escapeMarker)) return;
    for (const { label, regex } of patterns) {
      if (regex.test(line)) {
        violations.push({ label, line: index + 1 });
        break;
      }
    }
  });
  return violations;
}

function* walk(directory) {
  for (const entry of readdir(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      yield* walk(path);
    } else if (sourceExtension.test(entry)) {
      yield path;
    }
  }
}

function readdir(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function main() {
  const violations = [];
  for (const directory of scannedDirectories) {
    for (const file of walk(join(root, directory))) {
      const content = readFileSync(file, "utf8");
      for (const violation of findHermeticityViolations(content)) {
        violations.push(`${relative(root, file)}:${violation.line} references ${violation.label}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      "Tests must not touch real user state (issue #35); inject paths or stub env instead:",
    );
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("No real user state references in tests found.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
