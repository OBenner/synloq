import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../adapters/types.js";
import { SynloqError } from "../domain/errors.js";
import { agentId as agentIdSchema } from "../domain/message.js";
import type { TeamState, TeamStateStore } from "./team-state.js";

/**
 * One-time claim codes (issue #42, ADR-0004 layer 3): a chat on a host
 * without session provisioning claims its prepared role locally. Codes are
 * human-readable, single-use, single-role, and short-lived; only the SHA-256
 * hash is persisted in the team state, never the code itself.
 */
export const CLAIM_CODE_TTL_MS = 15 * 60 * 1000;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CODE_PATTERN = /^synloq-claim-(.+)-([a-z2-7]{8})$/;

/** RFC 4648 base32, lowercase, no padding; 5 bytes encode to exactly 8 chars. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function digest(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

/** Extracts the role a well-formed code names; undefined when malformed. */
export function claimCodeAgentId(code: string): string | undefined {
  const match = CODE_PATTERN.exec(code);
  if (!match) return undefined;
  const parsed = agentIdSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
}

export interface IssuedClaimCode {
  agentId: string;
  code: string;
  expiresAt: string;
}

export type ClaimConsumeResult =
  | { status: "claimed" }
  | { status: "no-outstanding-code" }
  | { status: "expired"; expiresAt: string }
  | { status: "code-mismatch" };

export class ClaimCodeStore {
  constructor(
    private readonly states: TeamStateStore,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  /**
   * Issues a fresh code for the role, replacing any outstanding one. Requires
   * an initialized team state (synloq init ran first).
   */
  async issue(agentId: string): Promise<IssuedClaimCode> {
    agentIdSchema.parse(agentId);
    const code = `synloq-claim-${agentId}-${base32(randomBytes(5))}`;
    const now = this.clock.now();
    const expiresAt = new Date(now + CLAIM_CODE_TTL_MS).toISOString();
    const record = {
      codeHash: digest(code).toString("hex"),
      issuedAt: new Date(now).toISOString(),
      expiresAt,
    };
    await this.states.update((current): TeamState => {
      if (!current) {
        throw new SynloqError(
          "INVALID_INPUT",
          "no Synloq team state; run synloq init for this project first",
        );
      }
      return { ...current, claims: { ...current.claims, [agentId]: record } };
    });
    return { agentId, code, expiresAt };
  }

  /**
   * Consume-once: a matching live code is burned and reported as claimed. An
   * expired code is also cleared (it is operational noise, not a security
   * event); a mismatch leaves the outstanding code untouched.
   */
  async consume(agentId: string, code: string): Promise<ClaimConsumeResult> {
    agentIdSchema.parse(agentId);
    const state = await this.states.read();
    const record = state?.claims?.[agentId];
    if (!state || !record) return { status: "no-outstanding-code" };
    if (this.clock.now() > Date.parse(record.expiresAt)) {
      await this.remove(state, agentId);
      return { status: "expired", expiresAt: record.expiresAt };
    }
    const stored = Buffer.from(record.codeHash, "hex");
    const candidate = digest(code);
    if (stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) {
      return { status: "code-mismatch" };
    }
    await this.remove(state, agentId);
    return { status: "claimed" };
  }

  /**
   * Drops the role's outstanding code, if any. Token rotation/revocation
   * calls this so a code printed before the rotation can no longer claim.
   */
  async clear(agentId: string): Promise<boolean> {
    const state = await this.states.read();
    if (!state?.claims?.[agentId]) return false;
    await this.remove(state, agentId);
    return true;
  }

  private async remove(state: TeamState, agentId: string): Promise<void> {
    const claims = { ...state.claims };
    delete claims[agentId];
    const next: TeamState = { ...state };
    if (Object.keys(claims).length > 0) {
      next.claims = claims;
    } else {
      delete next.claims;
    }
    await this.states.write(next);
  }
}
