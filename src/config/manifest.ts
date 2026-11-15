import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Participant } from "../domain/message.js";
import { DEFAULT_LANGUAGE, languageSchema, type Language } from "../i18n/index.js";
import { writeTextAtomic } from "./atomic-file.js";
import { hostSchema, type HostName } from "./hosts.js";

export interface ManifestRole extends Participant {
  host?: HostName;
}

const manifestSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().min(1).max(128),
    language: languageSchema.default(DEFAULT_LANGUAGE),
    agents: z.record(
      agentId,
      z
        .object({
          title: z.string(),
          role: z.string(),
          host: hostSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

export async function loadManifest(projectRoot: string): Promise<Participant[]> {
  return (await loadManifestRoles(projectRoot)).map(({ project, agentId, title, role }) => ({
    project,
    agentId,
    title,
    role,
  }));
}

/** Host placement is local configuration, not part of the relay participant API. */
export async function loadManifestRoles(projectRoot: string): Promise<ManifestRole[]> {
  const manifest = await readManifest(projectRoot);
  return Object.entries(manifest.agents).map(([id, agent]) => ({
    project: manifest.project,
    agentId: id,
    title: agent.title,
    role: agent.role,
    ...(agent.host ? { host: agent.host } : {}),
  }));
}

export async function loadManifestLanguage(projectRoot: string): Promise<Language> {
  return (await readManifest(projectRoot)).language;
}

async function readManifest(projectRoot: string) {
  const source = await readFile(join(projectRoot, "synloq.yaml"), "utf8");
  let input: unknown;
  try {
    input = YAML.parse(source);
  } catch {
    throw new SynloqError("INVALID_INPUT", "manifest contains malformed YAML");
  }

  const manifest = manifestSchema.safeParse(input);
  if (!manifest.success) {
    throw new SynloqError("INVALID_INPUT", "manifest does not match the version 1 schema");
  }
  return manifest.data;
}

export async function writeManifest(
  projectRoot: string,
  participants: ManifestRole[],
  language: Language = DEFAULT_LANGUAGE,
): Promise<void> {
  const project = participants[0]?.project;
  if (!project || participants.some((participant) => participant.project !== project)) {
    throw new SynloqError("INVALID_INPUT", "manifest participants must share one project");
  }
  const ids = new Set(participants.map((participant) => participant.agentId));
  if (ids.size !== participants.length) {
    throw new SynloqError("INVALID_INPUT", "manifest contains duplicate role IDs");
  }
  const manifest = manifestSchema.parse({
    version: 1,
    project,
    language,
    agents: Object.fromEntries(
      participants.map((participant) => [
        participant.agentId,
        {
          title: participant.title,
          role: participant.role,
          ...(participant.host ? { host: participant.host } : {}),
        },
      ]),
    ),
  });
  await writeTextAtomic(join(projectRoot, "synloq.yaml"), YAML.stringify(manifest), 0o644);
}

/**
 * Issue #32 (gap G1): init with an explicit --role list must EXTEND the
 * existing manifest, not overwrite it — that is what makes `synloq init
 * --role x` a working add-role. New entries override same-id ones; a project
 * mismatch fails loud via writeManifest's single-project validation. Returns
 * the merged roster so callers can reason about the whole team (gap G3).
 */
export async function mergeManifestParticipants(
  projectRoot: string,
  participants: ManifestRole[],
  language: Language = DEFAULT_LANGUAGE,
): Promise<ManifestRole[]> {
  let existing: ManifestRole[] = [];
  try {
    existing = await loadManifestRoles(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const byId = new Map(existing.map((participant) => [participant.agentId, participant]));
  for (const participant of participants) {
    byId.set(participant.agentId, { ...byId.get(participant.agentId), ...participant });
  }
  const merged = [...byId.values()];
  await writeManifest(projectRoot, merged, language);
  return merged;
}

/**
 * Removes one role from the manifest (remove-role). Refuses to empty the
 * manifest — a project with zero roles is deleted by removing the file, not
 * by writing an invalid one.
 */
export async function removeManifestParticipant(projectRoot: string, role: string): Promise<void> {
  const existing = await loadManifestRoles(projectRoot);
  if (!existing.some((participant) => participant.agentId === role)) {
    throw new SynloqError("INVALID_INPUT", `unknown role: ${role}`);
  }
  const remaining = existing.filter((participant) => participant.agentId !== role);
  if (remaining.length === 0) {
    throw new SynloqError("INVALID_INPUT", "cannot remove the last role from the manifest");
  }
  await writeManifest(projectRoot, remaining, await loadManifestLanguage(projectRoot));
}
