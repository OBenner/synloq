import { z } from "zod";
import { SynloqError } from "../../domain/errors.js";
import { isLoopbackHttpUrl } from "../../transport/loopback.js";

export interface OpenCodeSessionHost {
  createSession(input: {
    title: string;
    directory: string;
    denyTools: string[];
  }): Promise<{ id: string; permissionsApplied: boolean }>;
  getSession(id: string): Promise<boolean>;
  postPrompt(id: string, text: string): Promise<void>;
}

export interface OpenCodeFetchResponse {
  status: number;
  text(): Promise<string>;
}

export type OpenCodeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<OpenCodeFetchResponse>;

const sessionSchema = z.object({ id: z.string().min(1) }).passthrough();

function unavailable(): SynloqError {
  return new SynloqError("NOT_FOUND", "OpenCode service is unavailable");
}

export class OpencodeApiClient implements OpenCodeSessionHost {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetchImpl: OpenCodeFetch;

  constructor(baseUrl: string, options: { fetch?: OpenCodeFetch; authToken?: string } = {}) {
    if (!isLoopbackHttpUrl(baseUrl)) {
      throw new SynloqError(
        "INVALID_INPUT",
        "OpenCode service URL must be an explicit loopback origin",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? (fetch as unknown as OpenCodeFetch);
    if (options.authToken !== undefined) this.authToken = options.authToken;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let response: OpenCodeFetchResponse;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          // The OpenCode desktop service authenticates with HTTP Basic:
          // username "opencode", password from the service registration file.
          ...(this.authToken !== undefined
            ? {
                authorization: `Basic ${Buffer.from(`opencode:${this.authToken}`).toString("base64")}`,
              }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw unavailable();
    }
    let json: unknown;
    const text = await response.text();
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  // The desktop API wraps payloads in an envelope: {"data": ...}. Tolerate a
  // bare payload too, for forwards compatibility.
  private static unwrap(json: unknown): unknown {
    if (typeof json === "object" && json !== null && "data" in json) {
      return (json as { data: unknown }).data;
    }
    return json;
  }

  // Permissions grammar (action/resource/effect with wildcards) is verified on
  // the live stand (#31); until then a rejected ruleset falls back to a
  // session without host-level tool denies (fail-soft, R2).
  async createSession(input: {
    title: string;
    directory: string;
    denyTools: string[];
  }): Promise<{ id: string; permissionsApplied: boolean }> {
    const permissions = input.denyTools.map((pattern) => ({
      action: pattern,
      resource: "*",
      effect: "deny",
    }));
    const body = (withPermissions: boolean): Record<string, unknown> => ({
      title: input.title,
      location: { directory: input.directory },
      ...(withPermissions && permissions.length > 0 ? { permissions } : {}),
    });

    let result = await this.request("POST", "/api/session", body(true));
    if (
      permissions.length > 0 &&
      result.status >= 400 &&
      result.status < 500 &&
      result.status !== 401 &&
      result.status !== 404
    ) {
      result = await this.request("POST", "/api/session", body(false));
      const session = this.expectCreated(result);
      return { id: session.id, permissionsApplied: false };
    }
    const session = this.expectCreated(result);
    return { id: session.id, permissionsApplied: permissions.length > 0 };
  }

  private expectCreated(result: { status: number; json: unknown }): { id: string } {
    if (result.status >= 500) throw unavailable();
    if (result.status === 401 || result.status === 403) {
      throw new SynloqError(
        "INVALID_INPUT",
        "OpenCode service rejected the request as unauthorized (service password missing or wrong)",
      );
    }
    if (result.status !== 200 && result.status !== 201) {
      throw new SynloqError(
        "INVALID_INPUT",
        `OpenCode session creation failed with status ${result.status}`,
      );
    }
    const parsed = sessionSchema.safeParse(OpencodeApiClient.unwrap(result.json));
    if (!parsed.success) {
      throw new SynloqError("INVALID_INPUT", "OpenCode session response is invalid");
    }
    return parsed.data;
  }

  async getSession(id: string): Promise<boolean> {
    const result = await this.request("GET", `/api/session/${encodeURIComponent(id)}`);
    if (result.status === 404) return false;
    if (result.status >= 500) throw unavailable();
    if (result.status !== 200) {
      throw new SynloqError(
        "INVALID_INPUT",
        `OpenCode session lookup failed with status ${result.status}`,
      );
    }
    const parsed = sessionSchema.safeParse(OpencodeApiClient.unwrap(result.json));
    return parsed.success && parsed.data.id === id;
  }

  async postPrompt(id: string, text: string): Promise<void> {
    const result = await this.request("POST", `/api/session/${encodeURIComponent(id)}/prompt`, {
      text,
    });
    if (result.status >= 500) throw unavailable();
    if (result.status < 200 || result.status >= 300) {
      throw new SynloqError("INVALID_INPUT", `OpenCode prompt failed with status ${result.status}`);
    }
  }
}
