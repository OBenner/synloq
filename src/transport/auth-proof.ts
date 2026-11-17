import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SynloqError } from "../domain/errors.js";

export const AUTH_VERSION = 2 as const;
export const CHALLENGE_TTL_MS = 30_000;
export const MAX_CHALLENGES = 1024;
export interface AuthContext {
  project: string;
  agentId: string;
}
const nonce = z.string().regex(/^[a-f0-9]{32}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const challengeRequestSchema = z
  .object({
    authVersion: z.literal(AUTH_VERSION),
    project: z.string().min(1).max(128),
    kid: digest,
    clientNonce: nonce,
  })
  .strict();
export const challengeSchema = challengeRequestSchema
  .extend({
    agentId: z.string().min(1).max(64),
    instanceId: nonce,
    bootId: nonce,
    serverNonce: nonce,
    expiresAt: z.number().int().positive(),
    proof: digest,
  })
  .strict();
export type Challenge = z.infer<typeof challengeSchema>;
export type ChallengeRequest = z.infer<typeof challengeRequestSchema>;
export type UnsignedChallenge = Omit<Challenge, "proof">;

/** Byte lengths, not JS character counts. Reject ambiguity and uint16 overflow. */
export function frame(fields: readonly string[]): Buffer {
  return Buffer.concat(
    fields.flatMap((field) => {
      const bytes = Buffer.from(field, "utf8");
      if (bytes.length > 65535) throw new SynloqError("INVALID_INPUT", "auth field too large");
      const size = Buffer.alloc(2);
      size.writeUInt16BE(bytes.length);
      return [size, bytes];
    }),
  );
}
export function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
export function keyId(verifier: string, context: AuthContext): string {
  return createHmac("sha256", Buffer.from(verifier, "hex"))
    .update(frame(["synloq-authv2/kid", context.project, context.agentId]))
    .digest("hex");
}
function key(verifier: string, context: AuthContext, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(verifier, "hex"),
      Buffer.from("synloq-authv2"),
      frame(["2", context.project, context.agentId, keyId(verifier, context), purpose]),
      32,
    ),
  );
}
function mac(verifier: string, context: AuthContext, purpose: string, fields: string[]): string {
  return createHmac("sha256", key(verifier, context, purpose))
    .update(frame(fields))
    .digest("hex");
}
export function equalProof(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
function transcript(c: UnsignedChallenge): string[] {
  return [
    String(c.authVersion),
    c.project,
    c.agentId,
    c.kid,
    c.instanceId,
    c.bootId,
    c.clientNonce,
    c.serverNonce,
    String(c.expiresAt),
  ];
}
export function challengeProof(verifier: string, c: UnsignedChallenge): string {
  return mac(verifier, c, "synloq-authv2/challenge", transcript(c));
}
export function requestDigest(
  c: Challenge,
  method: string,
  target: string,
  body: Uint8Array,
): string {
  return hash(frame([...transcript(c), method.toUpperCase(), target, hash(body)]));
}
export function requestProof(verifier: string, c: Challenge, requestHash: string): string {
  return mac(verifier, c, "synloq-authv2/request", [...transcript(c), requestHash]);
}
export function responseProof(
  verifier: string,
  c: Challenge,
  requestHash: string,
  status: number,
  body: Uint8Array,
): string {
  return mac(verifier, c, "synloq-authv2/response", [
    ...transcript(c),
    requestHash,
    String(status),
    hash(body),
  ]);
}
