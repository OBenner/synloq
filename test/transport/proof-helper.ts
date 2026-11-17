import {
  challengeSchema,
  hash,
  keyId,
  newNonce,
  requestDigest,
  requestProof,
  type AuthContext,
} from "../../src/transport/auth-proof.js";

/** Raw HTTP conformance helper. Deliberately returns even unsigned denials. */
export async function proofRequest(
  url: string,
  token: string,
  context: AuthContext,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(url);
  const verifier = hash(token);
  const response = await fetch(`${target.origin}/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authVersion: 2,
      project: context.project,
      kid: keyId(verifier, context),
      clientNonce: newNonce(),
    }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!response.ok) return response;
  const challenge = challengeSchema.parse(await response.json());
  if (init.body !== undefined && typeof init.body !== "string")
    throw new Error("test helper requires exact string body");
  const digest = requestDigest(
    challenge,
    init.method ?? "GET",
    target.pathname + target.search,
    Buffer.from(init.body ?? ""),
  );
  const headers = new Headers(init.headers);
  headers.set("x-synloq-auth-version", "2");
  headers.set("x-synloq-challenge", challenge.serverNonce);
  headers.set("x-synloq-proof", requestProof(verifier, challenge, digest));
  return fetch(url, { ...init, headers });
}
