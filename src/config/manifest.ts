import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Participant } from "../domain/message.js";
import { DEFAULT_LANGUAGE, languageSchema, type Language } from "../i18n/index.js";
import { writeTextAtomic } from "./atomic-file.js";

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
        })
        .strict(),
    ),
  })
  .strict();

export async function loadManifest(projectRoot: string): Promise<Participant[]> {
  const manifest = await readManifest(projectRoot);
  return Object.entries(manifest.agents).map(([id, agent]) => ({
    project: manifest.project,
    agentId: id,
    title: agent.title,
    role: agent.role,
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
  participants: Participant[],
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
        { title: participant.title, role: participant.role },
      ]),
    ),
  });
  await writeTextAtomic(join(projectRoot, "synloq.yaml"), YAML.stringify(manifest), 0o644);
}
