import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectPaths } from "../config/paths.js";
import { SynloqError } from "../domain/errors.js";

export function isWithin(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) &&
      suffix !== ".." &&
      !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

/** Check every existing ancestor, including junctions on Windows. Missing paths are allowed. */
export async function assertOrdinaryDirectories(directory: string): Promise<void> {
  let current = resolve(directory);
  for (;;) {
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new SynloqError(
          "INVALID_INPUT",
          "placement must not traverse a symlink or non-directory",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function resolvePlacement(
  projectRoot: string,
  paths: ProjectPaths,
  agentId: string,
  requested?: string,
): Promise<string> {
  const fallback = join(paths.runtime, "roles", agentId);
  const directory = resolve(projectRoot, requested ?? fallback);
  const serviceDirectories = ["data", "credentials", "state", "runtime"].map((name) =>
    join(paths.home, name),
  );
  if (
    relative(fallback, directory) !== "" &&
    (serviceDirectories.some(
      (service) => isWithin(service, directory) || isWithin(directory, service),
    ) ||
      isWithin(directory, projectRoot))
  ) {
    throw new SynloqError(
      "INVALID_INPUT",
      "placement must not be the project root, its ancestors, or Synloq home service directories",
    );
  }
  await assertOrdinaryDirectories(directory);
  await assertOrdinaryDirectories(join(directory, ".codex"));
  return directory;
}
