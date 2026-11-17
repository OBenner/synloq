import { isIP } from "node:net";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";

/** Numeric loopback only: no DNS, redirects, proxy routing or credential-bearing URLs. */
export function webhookEndpoint(value: string, relayPort?: number): URL {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Check the source authority too: WHATWG normalization must not admit octal,
    // integer or short IPv4 aliases, or erase an explicit default port.
    const authority = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+):([0-9]+)(?:\/|$)/.exec(value);
    const numericV4 = isIP(host) === 4 && host.startsWith("127.");
    if (
      !authority ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (!numericV4 && host !== "::1") ||
      authority[1] !== url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      Number(authority[2]) < 1 ||
      Number(authority[2]) > 65_535 ||
      Number(authority[2]) === relayPort ||
      url.pathname.length > 128 ||
      !/^\/[A-Za-z0-9/_.~-]*$/.test(url.pathname)
    )
      throw new Error("invalid");
    return url;
  } catch {
    throw new SynloqError("INVALID_INPUT", "Webhook endpoint is invalid");
  }
}

export const webhookConfigSchema = z
  .object({
    enabled: z.boolean(),
    url: z
      .string()
      .max(256)
      .refine((value) => {
        try {
          webhookEndpoint(value);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
  })
  .strict()
  .refine((value) => !value.enabled || value.url !== undefined);

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
