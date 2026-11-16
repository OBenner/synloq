import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId } from "../domain/message.js";
import { CODEX_QUEUE_VERSIONS, CODEX_UUID } from "../host/codex/queue.js";
import type { ProjectPaths } from "./paths.js";

const configSchema = z
  .object({
    version: z.literal(1),
    enabled: z.literal(true),
    executable: z.string().min(1).refine(isAbsolute),
    cliVersion: z.enum(CODEX_QUEUE_VERSIONS),
    bindings: z
      .array(z.object({ agentId, threadId: z.string().regex(CODEX_UUID) }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.bindings.map((binding) => binding.agentId)).size === value.bindings.length &&
      new Set(value.bindings.map((binding) => binding.threadId)).size === value.bindings.length,
  );

export type CodexNudgerConfig = z.infer<typeof configSchema>;

export function codexNudgerPaths(paths: ProjectPaths): { config: string; ledger: string } {
  return {
    config: join(paths.home, "state", `${paths.key}.codex-queue.json`),
    ledger: join(paths.home, "data", `${paths.key}.codex-nudges.sqlite`),
  };
}

/** Local operator opt-in. This file never belongs in the repository/manifest. */
export async function loadCodexNudgerConfig(path: string): Promise<CodexNudgerConfig | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("oversized config");
    return configSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Zod/file errors can contain local paths or arbitrary values: keep them private.
    throw new SynloqError("INVALID_INPUT", "Codex nudger config is invalid; nudger disabled");
  }
}
