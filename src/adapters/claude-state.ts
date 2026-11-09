import type { SessionState } from "../domain/session.js";

export interface ClaudeHookMapping {
  event: string;
  state: SessionState;
}

export function mapClaudeHook(event: string): ClaudeHookMapping {
  switch (event) {
    case "SessionStart":
    case "Stop":
    case "StopFailure":
      return { event, state: "idle" };
    case "UserPromptSubmit":
      return { event, state: "busy" };
    case "SessionEnd":
      return { event, state: "closed" };
    default:
      return { event, state: "unknown" };
  }
}
