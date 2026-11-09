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
      | "UNAUTHORIZED"
      | "DELIVERY_UNCERTAIN"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SynloqError";
  }
}
