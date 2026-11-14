/**
 * Diagnostic lines emitted by long-lived Synloq processes (the MCP stdio
 * bridge, the relay supervisor loop, adapters) go to stderr. Every line
 * carries an ISO 8601 UTC timestamp so an incident timeline can be
 * reconstructed from logs alone, without reading the relay database
 * (issue #24).
 */
export function formatDiagnostic(message: string, at: Date = new Date()): string {
  return `${at.toISOString()} ${message}`;
}
