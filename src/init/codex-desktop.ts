import { createHash } from "node:crypto";
import { lstat, readFile, rmdir, unlink } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
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
import { ownedCodexConfig } from "./codex-config.js";
import { assertOrdinaryDirectories, resolvePlacement } from "./placement.js";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function desktopRoleDirectory(runtime: string, agentId: string): string {
  return join(runtime, "roles", agentId);
}

export async function inspectDesktopDirectory(
  runtime: string,
  agentId: string,
  hashes?: Record<string, string>,
  directory = desktopRoleDirectory(runtime, agentId),
) {
  try {
    await assertOrdinaryDirectories(join(directory, ".codex"));
  } catch {
    return { path: directory, ok: false, issue: "role directory must not be redirected" };
  }
  for (const path of [directory, join(directory, ".codex")]) {
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
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        return { path, ok: false, issue: "generated role file is not an ordinary file" };
      const content = await readFile(path, "utf8");
      const unchanged =
        file === ".codex/config.toml"
          ? configMatches(ownedCodexConfig(content, agentId).text, hashes[file])
          : digest(content) === hashes[file];
      if (!unchanged) {
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

function configMatches(owned: string, expected?: string): boolean {
  // Upgrade the original full-file hash when the old file contained only our table.
  return (
    owned !== "" && [owned, `${owned}\n`, `${owned}\r\n`].some((text) => digest(text) === expected)
  );
}

export async function provisionDesktopRoles(options: ReconcileOptions) {
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const store = new TeamStateStore(paths.bindings);
  const state = await store.read();
  const directories = new Map<string, string>();
  for (const role of options.roles) {
    const directory = await resolvePlacement(
      options.projectRoot,
      paths,
      role.agentId,
      role.placement,
    );
    const previous = state?.placements?.[role.agentId];
    if (
      previous &&
      relative(
        resolve(previous.directory ?? desktopRoleDirectory(paths.runtime, role.agentId)),
        directory,
      ) !== ""
    ) {
      throw new SynloqError(
        "INVALID_INPUT",
        `role ${role.agentId} placement changed; use explicit operator migration`,
      );
    }
    directories.set(role.agentId, directory);
  }
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
  await credentials.ensureOperatorCredential(options.project);
  for (const role of options.roles) {
    const directory = directories.get(role.agentId)!;
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    const files: Record<string, string> = {
      ".codex/config.toml": `[mcp_servers.synloq-${role.agentId}]\ncommand = "node"\nargs = ${JSON.stringify([resolve(options.runtimeEntrypoint), configPath])}\n`,
      "AGENTS.md": `${coreRules(
        role,
        options.language,
        options.roles.map((member) => ({ agentId: member.agentId, host: member.host })),
      ).join(
        "\n",
      )}\n\nProject source: ${options.projectRoot}\nUse only synloq-${role.agentId}. This role is reactive: check synloq_inbox when activated; there is no automatic wake-up.\n`,
    };
    for (const path of [directory, join(directory, ".codex")]) {
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
        if (!info.isFile() || info.isSymbolicLink())
          throw new SynloqError(
            "INVALID_INPUT",
            `refusing to overwrite non-regular role file: ${path}`,
          );
        const old = await readFile(path, "utf8");
        if (file === ".codex/config.toml") {
          const owned = ownedCodexConfig(old, role.agentId);
          const desired = ownedCodexConfig(content, role.agentId).text;
          if (
            owned.text !== "" &&
            owned.text !== desired &&
            !configMatches(owned.text, previous?.[file])
          )
            throw new SynloqError(
              "INVALID_INPUT",
              `refusing to overwrite modified role table: ${path}`,
            );
          files[file] = owned.replace(content);
          continue;
        }
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
      project: options.project,
      agentId: role.agentId,
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
          directory,
          desktopFiles: Object.fromEntries(
            Object.entries(files).map(([file, text]) => [
              file,
              digest(
                file === ".codex/config.toml" ? ownedCodexConfig(text, role.agentId).text : text,
              ),
            ]),
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
  directory = desktopRoleDirectory(runtime, agentId),
) {
  const report = await inspectDesktopDirectory(runtime, agentId, hashes, directory);
  if (!report.ok) return `Role directory retained: ${report.issue}`;
  const configPath = join(directory, ".codex/config.toml");
  const remaining = ownedCodexConfig(await readFile(configPath, "utf8"), agentId).replace("");
  if (remaining.trim()) await writeTextAtomic(configPath, remaining);
  else await unlink(configPath);
  await unlink(join(directory, "AGENTS.md"));
  try {
    await rmdir(join(directory, ".codex"));
    await rmdir(directory);
  } catch {
    return "Generated role files removed; additional user files retained";
  }
  return "Generated role directory removed";
}
