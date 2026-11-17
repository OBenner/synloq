import { open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { agentId } from "../domain/message.js";
import { NUDGE_UUID } from "../relay/nudge-identifiers.js";
import type { ProjectPaths } from "./paths.js";

const path = z.string().min(1).max(4096).refine(isAbsolute);
export const claudeNudgerSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    executable: path,
    cliVersion: z.literal("2.1.326"),
    bindings: z
      .array(
        z
          .object({
            agentId,
            sessionId: z.string().regex(NUDGE_UUID),
            cwd: path,
            transcript: path,
            mcpConfig: path,
            settings: path,
            adapterConfig: path,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.bindings.map((b) => b.agentId)).size === c.bindings.length &&
      new Set(c.bindings.map((b) => b.sessionId)).size === c.bindings.length,
  );
export type ClaudeNudgerConfig = z.infer<typeof claudeNudgerSchema>;
export type ClaudeBinding = ClaudeNudgerConfig["bindings"][number];
export function claudeNudgerPaths(paths: ProjectPaths) {
  return {
    config: join(paths.home, "state", `${paths.key}.claude-nudges.json`),
    ledger: join(paths.home, "data", `${paths.key}.claude-nudges.sqlite`),
  };
}
export async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size > 65536) throw new Error("oversized config");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("oversized config");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
export async function loadClaudeNudgerConfig(
  path: string,
): Promise<ClaudeNudgerConfig | undefined> {
  try {
    const config = claudeNudgerSchema.parse(await readBoundedJson(path));
    return config.enabled ? config : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("invalid Claude nudger config");
  }
}

/** Validate trusted local binding without loading any credential values. */
export async function validateClaudeBinding(
  binding: ClaudeBinding,
  project: string,
  projectRoot: string,
  relayUrl: string,
): Promise<void> {
  const adapter = z
    .object({
      kind: z.literal("claude"),
      project: z.literal(project),
      agentId: z.literal(binding.agentId),
      sessionId: z.literal(binding.sessionId),
      projectRoot: path,
      relayUrl: z.literal(relayUrl),
      credentialPath: path,
    })
    .passthrough()
    .parse(await readBoundedJson(binding.adapterConfig));
  if ((await realpath(adapter.projectRoot)) !== (await realpath(projectRoot)))
    throw new Error("wrong project");
  const mcp = z
    .object({
      mcpServers: z.record(
        z.string(),
        z
          .object({
            command: z.string(),
            args: z.array(z.string()),
            env: z.record(z.string(), z.string()).optional(),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(await readBoundedJson(binding.mcpConfig));
  const keys = Object.keys(mcp.mcpServers),
    server = mcp.mcpServers[`synloq-${binding.agentId}`];
  if (
    keys.length !== 1 ||
    !server ||
    server.args.at(-2) !== "--config" ||
    !server.args.includes("adapter") ||
    (await realpath(server.args.at(-1)!)) !== (await realpath(binding.adapterConfig))
  )
    throw new Error("wrong MCP binding");
  // The operator supplies existing generated hook settings, never inline secrets.
  await readBoundedJson(binding.settings);
  await realpath(binding.cwd);
}
