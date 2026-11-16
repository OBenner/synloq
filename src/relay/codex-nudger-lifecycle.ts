import { codexNudgerPaths, loadCodexNudgerConfig } from "../config/codex-nudger.js";
import type { ProjectPaths } from "../config/paths.js";
import { TeamStateStore } from "../config/team-state.js";
import { formatDiagnostic } from "../diagnostics.js";
import type { QueueNudgeOptions, QueueResult } from "../host/codex/queue.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import { NudgeLedger } from "../storage/nudge-ledger.js";
import type { SessionStore } from "../storage/session-store.js";
import { CodexQueueNudger } from "./codex-nudger.js";
import type { ParticipantDirectory } from "./participant-directory.js";

interface Options {
  project: string;
  paths: ProjectPaths;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  directory: ParticipantDirectory;
  now: () => number;
  diagnostic?: (line: string) => void;
  queue?: (options: QueueNudgeOptions) => Promise<QueueResult>;
}

/** Optional relay-owned service. Bad config disables nudging, never the inbox. */
export async function startCodexNudger(options: Options): Promise<() => Promise<void>> {
  const diagnostic = options.diagnostic ?? ((line) => process.stderr.write(`${line}\n`));
  let ledger: NudgeLedger | undefined;
  try {
    const paths = codexNudgerPaths(options.paths);
    const config = await loadCodexNudgerConfig(paths.config);
    if (!config) return async () => {};
    const team = new TeamStateStore(options.paths.bindings);
    const eligible = async (agentId: string) => {
      const state = await team.read();
      // #45 lives only in Kimi/OpenCode MCP children. An explicit Codex placement,
      // no push conversation and no active-delivery registration exclude overlap.
      return (
        state?.project === options.project &&
        state.placements?.[agentId]?.host === "codex-desktop" &&
        !state.conversations[agentId] &&
        (await options.directory.isParticipant(options.project, agentId)) &&
        !options.sessions
          .list(options.project)
          .some((session) => session.agentId === agentId && session.capabilities.activeDelivery)
      );
    };
    for (const binding of config.bindings) {
      if (!(await eligible(binding.agentId))) throw new Error("ineligible Codex placement");
    }
    ledger = new NudgeLedger(paths.ledger);
    const nudger = new CodexQueueNudger({ ...options, config, ledger, eligible });
    nudger.start();
    const openLedger = ledger;
    return async () => {
      await nudger.stop();
      openLedger.close();
    };
  } catch {
    ledger?.close();
    try {
      diagnostic(
        formatDiagnostic(
          "Synloq Codex nudger: NUDGER_DISABLED invalid config, placement or ledger; operator review required",
          new Date(options.now()),
        ),
      );
    } catch {
      /* Keep the relay available even with a closed diagnostic sink. */
    }
    return async () => {};
  }
}
