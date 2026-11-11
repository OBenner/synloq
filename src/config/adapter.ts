import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";
import { agentId } from "../domain/message.js";
import { PROTOCOL_VERSION } from "../domain/session.js";
import { CredentialStore } from "./credentials.js";

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      ["127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const loopbackHttp = z
  .string()
  .url()
  .refine(isLoopbackHttp, "only an HTTP loopback URL is allowed");
const commonFields = {
  version: z.literal(1),
  project: z.string().min(1).max(128),
  projectRoot: z.string().min(1),
  agentId,
  sessionId: z.string().min(1).max(256),
  relayUrl: loopbackHttp,
  credentialPath: z.string().min(1),
  protocolVersion: z.literal(PROTOCOL_VERSION),
};

const claudeSchema = z
  .object({
    ...commonFields,
    kind: z.literal("claude"),
    activationVerifiedAt: z.string().datetime({ offset: true }).optional(),
    acceptanceMessageId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (
      configuration.activationVerifiedAt !== undefined &&
      configuration.acceptanceMessageId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "controlled acceptance and verified activation are mutually exclusive",
      });
    }
  });

const openCodeSchema = z
  .object({
    ...commonFields,
    kind: z.literal("opencode"),
    baseUrl: loopbackHttp,
    heartbeatIntervalMs: z.number().int().min(1).max(60_000).optional(),
  })
  .strict();

const codexSchema = z
  .object({
    ...commonFields,
    kind: z.literal("codex"),
  })
  .strict();

const configurationSchema = z.union([claudeSchema, openCodeSchema, codexSchema]);

export type StandaloneAdapterConfiguration = z.infer<typeof configurationSchema>;

export interface LoadedAdapterConfiguration {
  configuration: StandaloneAdapterConfiguration;
  token: string;
}

export async function loadAdapterConfiguration(
  configPath: string,
): Promise<LoadedAdapterConfiguration> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SynloqError("INVALID_INPUT", "adapter configuration contains malformed JSON");
    }
    throw error;
  }

  const parsed = configurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new SynloqError("INVALID_INPUT", "adapter configuration does not match the schema");
  }

  const configuration = {
    ...parsed.data,
    projectRoot: resolve(dirname(configPath), parsed.data.projectRoot),
    credentialPath: resolve(dirname(configPath), parsed.data.credentialPath),
  };
  const token = (await readFile(configuration.credentialPath, "utf8")).trim();
  if (token === "") {
    throw new SynloqError("INVALID_INPUT", "adapter credential file is empty");
  }
  const identity = await new CredentialStore(configuration.projectRoot).authenticate(
    configuration.project,
    token,
  );
  if (identity.operator || identity.agentId !== configuration.agentId) {
    throw new SynloqError(
      "UNAUTHORIZED",
      "adapter configuration identity does not match its credential",
    );
  }
  return { configuration, token };
}
