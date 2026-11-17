import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectPaths } from "./paths.js";
import type { WebhookSnapshot } from "../relay/webhook-nudger.js";

export const webhookStatusPath = (paths: ProjectPaths) =>
  join(paths.home, "state", `${paths.key}.webhook-status.json`);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z
  .object({
    relayInstance: z.string().uuid(),
    observedAt: z.string().datetime(),
    attempted: counter,
    failed: counter,
    dropped: counter,
    queued: counter.max(256),
    active: z.boolean(),
    stopped: z.boolean(),
  })
  .strict();

/** Offline-safe, bounded read; an old snapshot is an observation, not liveness. */
export async function readWebhookStatus(paths: ProjectPaths): Promise<WebhookSnapshot | undefined> {
  try {
    const file = await open(webhookStatusPath(paths), "r");
    try {
      const bytes = Buffer.alloc(4097);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 4096) return undefined;
      const parsed = schema.safeParse(
        JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
