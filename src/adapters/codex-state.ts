import type { SessionState } from "../domain/session.js";

export function mapCodexHook(event: string, source?: string): SessionState {
  if (event === "SessionStart") {
    if (source === "startup" || source === "resume" || source === "clear" || source === "fork") {
      return "idle";
    }
    return source === "compact" ? "busy" : "unknown";
  }
  if (event === "UserPromptSubmit" || event === "PreModelRequest") return "busy";
  if (event === "Stop") return "idle";
  if (event === "SessionEnd") return "closed";
  return "unknown";
}
