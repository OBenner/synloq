import { SynloqError } from "../domain/errors.js";

export function hasErrorCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === code) return true;
  if ("cause" in error && hasErrorCode(error.cause, code, depth + 1)) return true;
  return (
    "errors" in error &&
    Array.isArray(error.errors) &&
    error.errors.some((nested) => hasErrorCode(nested, code, depth + 1))
  );
}

/** Never include untrusted exception text, request bodies, or credentials. */
export function relayConnectionError(cause: unknown): SynloqError {
  const reason =
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].find((code) =>
      hasErrorCode(cause, code),
    ) ?? "transport failure";
  const error = new SynloqError(
    "STORAGE_FAILURE",
    `Synloq relay unreachable (${reason}). Check the relay process and its startup diagnostics; run synloq doctor for this project.`,
  );
  error.cause = cause;
  return error;
}
