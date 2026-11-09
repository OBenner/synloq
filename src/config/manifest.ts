import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Participant } from "../domain/message.js";

const manifestSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().min(1).max(128),
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

  return Object.entries(manifest.data.agents).map(([id, agent]) => ({
    project: manifest.data.project,
    agentId: id,
    title: agent.title,
    role: agent.role,
  }));
}
