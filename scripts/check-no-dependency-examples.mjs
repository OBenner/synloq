#!/usr/bin/env node
// Guard against importing dependency `examples/` code (issue #26).
//
// @modelcontextprotocol/sdk publishes its demo servers and exposes them
// through a wildcard "./*" export, so `@modelcontextprotocol/sdk/examples/…`
// is importable even though nothing in this repository should ever do that.
// This script fails when any source file imports a bare package specifier
// that contains an `/examples/` path segment.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scannedDirectories = ["src", "test", "scripts"];
const sourceExtension = /\.(?:[cm]?[jt]s)$/;
const specifierPattern =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

// Exported for tests: extract bare package specifiers that reference a
// dependency's examples/ path, with their 1-based line numbers.
export function findExamplesImports(content) {
  const violations = [];
  for (const match of content.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (/(^|\/)examples(\/|$)/.test(specifier)) {
      violations.push({
        specifier,
        line: content.slice(0, match.index).split("\n").length,
      });
    }
  }
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
      for (const violation of findExamplesImports(content)) {
        violations.push(`${relative(root, file)}:${violation.line} imports ${violation.specifier}`);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
