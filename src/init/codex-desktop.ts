import { createHash } from "node:crypto";
import { lstat, readFile, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeTextAtomic, writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { mergeManifestParticipants } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { ClaimCodeStore } from "../config/claim-codes.js";
import { TeamStateStore } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import { FileSecurityAuditLog, auditLogPath } from "../relay/audit-log.js";
import { coreRules } from "./role-prompt.js";
import { relativeHomePaths } from "./runtime-config.js";
import type { ReconcileOptions } from "./reconcile.js";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function desktopRoleDirectory(runtime: string, agentId: string): string {
  return join(runtime, "roles", agentId);
}

export async function inspectDesktopDirectory(
  runtime: string,
  agentId: string,
  hashes?: Record<string, string>,
) {
  const directory = desktopRoleDirectory(runtime, agentId);
  for (const path of [runtime, join(runtime, "roles"), directory, join(directory, ".codex")]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        return { path: directory, ok: false, issue: "role directory is not an ordinary directory" };
    } catch {
      return { path: directory, ok: false, issue: "role directory is missing or unreadable" };
    }
  }
  if (!hashes)
    return { path: directory, ok: false, issue: "role directory has no provisioning record" };
  for (const file of [".codex/config.toml", "AGENTS.md"]) {
    try {
      const path = join(directory, file);
      if (
        !(await lstat(path)).isFile() ||
        (await lstat(path)).isSymbolicLink() ||
        digest(await readFile(path, "utf8")) !== hashes[file]
      ) {
        return { path: path, ok: false, issue: "generated role file drifted" };
      }
    } catch {
      return {
        path: join(directory, file),
        ok: false,
        issue: "generated role file is missing or unreadable",
      };
    }
  }
  return { path: directory, ok: true };
}

export async function provisionDesktopRoles(options: ReconcileOptions) {
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const store = new TeamStateStore(paths.bindings);
  const credentials = new CredentialStore(
    options.projectRoot,
    paths.home,
    new FileSecurityAuditLog(auditLogPath(paths.home, paths.key)),
  );
  const roles = [];
  await mergeManifestParticipants(
    options.projectRoot,
    options.manifestParticipants ??
      options.roles.map((role) => ({ ...role, project: options.project })),
    options.language,
  );
  await credentials.ensureCredential(options.project, "operator");
  for (const role of options.roles) {
    const directory = desktopRoleDirectory(paths.runtime, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    const files = {
      ".codex/config.toml": `[mcp_servers.synloq-${role.agentId}]\ncommand = "node"\nargs = ${JSON.stringify([resolve(options.runtimeEntrypoint), configPath])}\n`,
      "AGENTS.md": `${coreRules(role, options.language).join("\n")}\n\nProject source: ${options.projectRoot}\nUse only synloq-${role.agentId}. This role is reactive: check synloq_inbox when activated; there is no automatic wake-up.\n`,
    };
    for (const path of [
      paths.runtime,
      join(paths.runtime, "roles"),
      directory,
      join(directory, ".codex"),
    ]) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new SynloqError("INVALID_INPUT", "role directory must not be redirected");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const previous = (await store.read())?.placements?.[role.agentId]?.desktopFiles;
    for (const [file, content] of Object.entries(files)) {
      const path = join(directory, file);
      try {
        const info = await lstat(path);
        const old = await readFile(path, "utf8");
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (old !== content && digest(old) !== previous?.[file])
        )
          throw new SynloqError(
            "INVALID_INPUT",
            `refusing to overwrite modified role file: ${path}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const credential = await credentials.ensureCredential(options.project, role.agentId);
    await writeJsonAtomic(configPath, {
      relayUrl: options.relayUrl,
      credentialPath: relativeHomePaths(paths.key, role.agentId).credentialPath,
      language: options.language,
    });
    for (const [file, content] of Object.entries(files))
      await writeTextAtomic(join(directory, file), content);
    await store.update((current) => ({
      ...(current ?? {
        version: 1,
        project: options.project,
        projectRoot: options.projectRoot,
        conversations: {},
      }),
      placements: {
        ...current?.placements,
        [role.agentId]: {
          host: "codex-desktop",
          state: "configured",
          desktopFiles: Object.fromEntries(
            Object.entries(files).map(([file, text]) => [file, digest(text)]),
          ),
        },
      },
    }));
    await new ClaimCodeStore(store).clear(role.agentId);
    roles.push({
      agentId: role.agentId,
      directory,
      configPath,
      credentialPath: credential.tokenPath,
    });
  }
  return {
    roles,
    nextSteps: roles.flatMap((role) => [
      `Open ${role.directory} in Codex Desktop`,
      "Trust the project and its MCP configuration",
      `Start a chat and check the synloq-${role.agentId} channel`,
    ]),
  };
}

/** Remove only unchanged generated files; never recursively erase user content. */
export async function removeDesktopDirectory(
  runtime: string,
  agentId: string,
  hashes?: Record<string, string>,
) {
  const report = await inspectDesktopDirectory(runtime, agentId, hashes);
  if (!report.ok) return `Role directory retained: ${report.issue}`;
  const directory = desktopRoleDirectory(runtime, agentId);
  for (const file of [".codex/config.toml", "AGENTS.md"]) await unlink(join(directory, file));
  try {
    await rmdir(join(directory, ".codex"));
    await rmdir(directory);
  } catch {
    return "Generated role files removed; additional user files retained";
  }
  return "Generated role directory removed";
}
