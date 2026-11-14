#!/usr/bin/env node
// Guard against importing dependency `examples/` code (issue #26).
//
// @modelcontextprotocol/sdk publishes its demo servers and exposes them
// through a wildcard "./*" export, so `@modelcontextprotocol/sdk/examples/…`
// is importable even though nothing in this repository should ever do that.
// This script fails when any source file imports a bare package specifier
// that contains an `/examples/` path segment.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scannedDirectories = ["src", "test", "scripts"];
const sourceExtension = /\.(?:[cm]?[jt]s)$/;
const specifierPattern =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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

const violations = [];
for (const directory of scannedDirectories) {
  for (const file of walk(join(root, directory))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (/(^|\/)examples(\/|$)/.test(specifier)) {
        const line = content.slice(0, match.index).split("\n").length;
        violations.push(`${relative(root, file)}:${line} imports ${specifier}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Dependency examples/ imports are forbidden (issue #26):");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("No dependency examples/ imports found.");
}
