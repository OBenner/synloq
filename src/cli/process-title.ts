/**
 * Process titles make Synloq processes recognizable in OS monitors
 * (Process Explorer, Task Manager's command-line column, ps). Set after the
 * config/CLI arguments are parsed so the role or port is known. Setting a
 * title never writes to stdout — the MCP stdio protocol is unaffected.
 */

export function relayTitle(port: number): string {
  return `synloq-relay (port ${port})`;
}

export function mcpTitle(agentId: string): string {
  return `synloq-mcp: ${agentId}`;
}

export function adapterTitle(agentId: string): string {
  return `synloq-adapter: ${agentId}`;
}

export function hookTitle(host: "claude" | "codex"): string {
  return `synloq-hook: ${host}`;
}

/** Best effort: some embedders disallow title changes — never fail on it. */
export function setProcessTitle(title: string): void {
  try {
    process.title = title;
  } catch {
    // Intentionally ignored.
  }
}
