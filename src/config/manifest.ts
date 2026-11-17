import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Participant } from "../domain/message.js";
import { DEFAULT_LANGUAGE, languageSchema, type Language } from "../i18n/index.js";
import { writeTextAtomic } from "./atomic-file.js";
import { hostSchema, type HostName } from "./hosts.js";
import { webhookConfigSchema, type WebhookConfig } from "./webhooks.js";

export interface ManifestRole extends Participant {
  host?: HostName;
  placement?: string;
  notes?: string;
}

const retentionSchema = z.object({ days: z.number().int().min(1).max(36_500) });

// Readers strip unknown fields so an older live relay can accept a newer,
// additive manifest. Doctor still reports these fields to catch typos.
const manifestSchema = z.object({
  // External effects must never be enabled by a committed/shared manifest.
  webhooks: z.never().optional(),
  version: z.literal(1).default(1),
  project: z.string().min(1).max(128),
  language: languageSchema.default(DEFAULT_LANGUAGE),
  retention: retentionSchema.optional(),
  agents: z.record(
    agentId,
    z.object({
      title: z.string(),
      role: z.string(),
      host: hostSchema.optional(),
      placement: z.string().min(1).optional(),
      notes: z.string().max(500).optional(),
    }),
  ),
});

const strictManifestSchema = z
  .object({
    webhooks: z.never().optional(),
    version: z.literal(1).default(1),
    project: z.string().min(1).max(128),
    language: languageSchema.default(DEFAULT_LANGUAGE),
    retention: retentionSchema.strict().optional(),
    agents: z.record(
      agentId,
      z
        .object({
          title: z.string(),
          role: z.string(),
          host: hostSchema.optional(),
          placement: z.string().min(1).optional(),
          notes: z.string().max(500).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export async function loadManifest(projectRoot: string): Promise<Participant[]> {
  return (await loadManifestRoles(projectRoot)).map(({ project, agentId, title, role, notes }) => ({
    project,
    agentId,
    title,
    role,
    ...(notes ? { notes } : {}),
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
    ...(agent.placement ? { placement: agent.placement } : {}),
    ...(agent.notes ? { notes: agent.notes } : {}),
  }));
}

export async function loadManifestLanguage(projectRoot: string): Promise<Language> {
  return (await readManifest(projectRoot)).language;
}

export async function loadManifestRetention(projectRoot: string): Promise<{ days: number }> {
  return (await readManifest(projectRoot)).retention ?? { days: 7 };
}

export async function loadManifestWebhooks(
  projectRoot: string,
): Promise<WebhookConfig | undefined> {
  return (await readManifest(projectRoot)).webhooks;
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
  return applyLocalOverlay(projectRoot, manifest.data);
}

export const LOCAL_OVERLAY_FILENAME = "synloq.local.yaml";

/**
 * A gitignored personal overlay merged over the committed manifest (issue #37).
 * Key-level precedence: an overlay agent overrides only the fields it names and
 * may add roles; `project` is the shared namespace and must not be overridden.
 * A malformed overlay fails loud — it never silently falls back to the
 * committed manifest.
 */
async function applyLocalOverlay(
  projectRoot: string,
  base: z.infer<typeof manifestSchema>,
): Promise<
  Omit<z.infer<typeof manifestSchema>, "webhooks"> & { webhooks?: WebhookConfig | undefined }
> {
  let source: string;
  try {
    source = await readFile(join(projectRoot, LOCAL_OVERLAY_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
    throw error;
  }
  let input: unknown;
  try {
    input = YAML.parse(source);
  } catch (error) {
    const line = (error as { linePos?: [{ line: number }] }).linePos?.[0]?.line;
    throw new SynloqError(
      "INVALID_INPUT",
      `${LOCAL_OVERLAY_FILENAME} contains malformed YAML${line ? ` at line ${line}` : ""}`,
    );
  }
  if (typeof input === "object" && input !== null && "project" in input) {
    throw new SynloqError(
      "INVALID_INPUT",
      `${LOCAL_OVERLAY_FILENAME} must not override 'project'; the namespace is shared`,
    );
  }
  const overlay = overlaySchema.safeParse(input);
  if (!overlay.success) {
    throw new SynloqError(
      "INVALID_INPUT",
      `${LOCAL_OVERLAY_FILENAME} does not match the overlay schema`,
    );
  }
  const agents = { ...base.agents };
  for (const [id, patch] of Object.entries(overlay.data.agents)) {
    const existing = agents[id];
    if (!existing) {
      if (patch.title === undefined || patch.role === undefined) {
        throw new SynloqError(
          "INVALID_INPUT",
          `${LOCAL_OVERLAY_FILENAME} adds role '${id}' without title and role`,
        );
      }
      agents[id] = {
        title: patch.title,
        role: patch.role,
        ...(patch.host ? { host: patch.host } : {}),
        ...(patch.placement ? { placement: patch.placement } : {}),
        ...(patch.notes ? { notes: patch.notes } : {}),
      };
    } else {
      agents[id] = {
        title: patch.title ?? existing.title,
        role: patch.role ?? existing.role,
        host: patch.host ?? existing.host,
        placement: patch.placement ?? existing.placement,
        notes: patch.notes ?? existing.notes,
      };
    }
  }
  return {
    ...base,
    ...(overlay.data.webhooks === undefined ? {} : { webhooks: overlay.data.webhooks }),
    agents,
    language: overlay.data.language ?? base.language,
    retention: overlay.data.retention ?? base.retention,
  };
}

const overlaySchema = z
  .object({
    webhooks: webhookConfigSchema.optional(),
    version: z.literal(1).default(1),
    language: languageSchema.optional(),
    retention: retentionSchema.optional(),
    agents: z
      .record(
        agentId,
        z
          .object({
            title: z.string().optional(),
            role: z.string().optional(),
            host: hostSchema.optional(),
            placement: z.string().min(1).optional(),
            notes: z.string().max(500).optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

/** Unknown keys are accepted by the relay but shown as doctor warnings. */
export async function manifestUnknownFields(projectRoot: string): Promise<string[]> {
  const source = await readFile(join(projectRoot, "synloq.yaml"), "utf8");
  let input: unknown;
  try {
    input = YAML.parse(source);
  } catch {
    return [];
  }
  const result = strictManifestSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues
    .filter((issue) => issue.code === "unrecognized_keys")
    .flatMap((issue) => {
      const prefix = issue.path.length === 0 ? "" : `${issue.path.join(".")}.`;
      return issue.keys.map((key) => `${prefix}${key}`);
    });
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
  let retention: { days: number } | undefined;
  try {
    const source = await readFile(join(projectRoot, "synloq.yaml"), "utf8");
    let previous: unknown;
    try {
      previous = YAML.parse(source);
    } catch {
      // Full-roster writes can repair malformed YAML, as before. Settings
      // cannot be recovered from an unparseable document; readers still fail loud.
    }
    if (previous && typeof previous === "object" && "retention" in previous) {
      const parsed = retentionSchema.safeParse(previous.retention);
      if (!parsed.success)
        throw new SynloqError("INVALID_INPUT", "invalid manifest retention policy");
      retention = parsed.data;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manifest = manifestSchema.parse({
    version: 1,
    project,
    language,
    ...(retention ? { retention } : {}),
    agents: Object.fromEntries(
      participants.map((participant) => [
        participant.agentId,
        {
          title: participant.title,
          role: participant.role,
          ...(participant.host ? { host: participant.host } : {}),
          ...(participant.placement ? { placement: participant.placement } : {}),
          ...(participant.notes ? { notes: participant.notes } : {}),
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
