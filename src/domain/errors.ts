export class SynloqError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "UNKNOWN_RECIPIENT"
      | "IDEMPOTENCY_CONFLICT"
      | "DUPLICATE_SESSION"
      | "INCOMPATIBLE_PROTOCOL"
      | "RATE_LIMITED"
      | "QUEUE_FULL"
      | "PAUSED"
      | "STORAGE_FAILURE"
      | "PERMISSION_DENIED"
      | "UNAUTHORIZED"
      | "DELIVERY_UNCERTAIN"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SynloqError";
  }
}

export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Fail-loud filesystem permission error (sandboxed runners, read-only homes):
 * always names the operation and the concrete path, and points at the
 * --synloq-home / SYNLOQ_HOME escape hatch.
 */
export function permissionDenied(operation: string, path: string, cause: unknown): SynloqError {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? "EPERM";
  const error = new SynloqError(
    "PERMISSION_DENIED",
    `permission denied (${code}) while ${operation} at '${path}'. ` +
      "Check the directory permissions or sandbox restrictions, " +
      "or use --synloq-home / SYNLOQ_HOME to point Synloq at a writable location.",
  );
  error.cause = cause;
  return error;
}
