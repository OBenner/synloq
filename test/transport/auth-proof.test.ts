import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  challengeSchema,
  challengeProof,
  requestProof,
  requestDigest,
  responseProof,
  keyId,
  frame,
} from "../../src/transport/auth-proof.js";

// Generated independently with Python hashlib/hmac and RFC 5869 extract/expand,
// not by the production helpers. Public sequential bytes, never a credential.
const vector = JSON.parse(readFileSync(new URL("./auth-v2-vector.json", import.meta.url), "utf8"));
const c = challengeSchema.parse(vector.challenge);
describe("auth v2 wire vectors", () => {
  it("matches the independent key selector and all three directional proofs", () => {
    expect(keyId(vector.verifier, c)).toBe(c.kid);
    expect(challengeProof(vector.verifier, c)).toBe(c.proof);
    expect(requestDigest(c, vector.method, vector.target, Buffer.from(vector.body))).toBe(
      vector.requestDigest,
    );
    expect(requestProof(vector.verifier, c, vector.requestDigest)).toBe(vector.requestProof);
    expect(
      responseProof(
        vector.verifier,
        c,
        vector.requestDigest,
        vector.status,
        Buffer.from(vector.responseBody),
      ),
    ).toBe(vector.responseProof);
  });
  it("frames UTF-8 byte lengths unambiguously and rejects overflow", () => {
    expect(frame(["a", "é"]).toString("hex")).toBe("0001610002c3a9");
    expect(frame(["ab", "c"])).not.toEqual(frame(["a", "bc"]));
    expect(() => frame(["a".repeat(65536)])).toThrow();
  });
  it("separates project, role, boot, client nonce, method, raw query, body, and status", () => {
    for (const changed of [
      { project: "other" },
      { agentId: "operator" },
      { bootId: "55".repeat(16) },
      { clientNonce: "66".repeat(16) },
    ]) {
      expect(challengeProof(vector.verifier, { ...c, ...changed })).not.toBe(c.proof);
    }
    expect(keyId(vector.verifier, { ...c, agentId: "operator" })).not.toBe(c.kid);
    expect(keyId(vector.verifier, { ...c, project: "other" })).not.toBe(c.kid);
    for (const [method, target, body] of [
      ["GET", vector.target, vector.body],
      ["POST", "/v1/messages?a=%2F&b=2", vector.body],
      ["POST", vector.target, vector.body + " "],
    ]) {
      expect(requestDigest(c, method, target, Buffer.from(body))).not.toBe(vector.requestDigest);
    }
    expect(
      responseProof(
        vector.verifier,
        c,
        vector.requestDigest,
        200,
        Buffer.from(vector.responseBody),
      ),
    ).not.toBe(vector.responseProof);
  });
});
