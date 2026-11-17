import { watch } from "node:fs";
import { dirname } from "node:path";
import {
  claudeNudgerPaths,
  loadClaudeNudgerConfig,
  validateClaudeBinding,
} from "../config/claude-nudger.js";
import type { ProjectPaths } from "../config/paths.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { SessionStore } from "../storage/session-store.js";
import { ClaudeNudgeLedger } from "../storage/claude-nudge-ledger.js";
import { ClaudeNudger } from "./claude-nudger.js";
import type { ParticipantDirectory } from "./participant-directory.js";

interface Options {
  project: string;
  projectRoot: string;
  paths: ProjectPaths;
  relayUrl: string;
  messages: SQLiteMessageStore;
  sessions: SessionStore;
  directory: ParticipantDirectory;
  now: () => number;
  diagnostic?: (line: string) => void;
}
export interface ClaudeNudgerHandle {
  notify(agentId: string): void;
  stop(): Promise<void>;
}
export async function startClaudeNudger(options: Options): Promise<ClaudeNudgerHandle> {
  let ledger: ClaudeNudgeLedger | undefined,
    nudger: ClaudeNudger | undefined,
    watcher: ReturnType<typeof watch> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      watcher?.close();
      await nudger?.stop();
      ledger?.close();
    })());
  const diagnostic = () => {
    try {
      (options.diagnostic ?? ((line) => process.stderr.write(line + "\n")))(
        "Synloq Claude nudger: DISABLED; inspect local ownership/configuration before restarting",
      );
    } catch {
      /* Closed sink does not affect inbox. */
    }
  };
  try {
    const paths = claudeNudgerPaths(options.paths),
      config = await loadClaudeNudgerConfig(paths.config);
    if (!config) return { notify: () => {}, stop: async () => {} };
    const signature = JSON.stringify(config);
    ledger = new ClaudeNudgeLedger(paths.ledger);
    nudger = new ClaudeNudger({
      project: options.project,
      config,
      ledger,
      now: options.now,
      candidate: (agent) => options.messages.claudeNudgeCandidates(options.project, agent),
      acknowledged: (id) => options.messages.isMessageAcknowledged(id, options.project),
      eligible: async (binding) => {
        if (JSON.stringify(await loadClaudeNudgerConfig(paths.config)) !== signature) return false;
        await validateClaudeBinding(
          binding,
          options.project,
          options.projectRoot,
          options.relayUrl,
        );
        const session = options.sessions
          .list(options.project)
          .find((s) => s.agentId === binding.agentId);
        return (
          !!session &&
          session.sessionId === binding.sessionId &&
          session.state === "closed" &&
          !session.capabilities.activeDelivery &&
          (await options.directory.isParticipant(options.project, binding.agentId))
        );
      },
    });
    await nudger.start();
    // Configuration removal/disable hands ownership back after the owned child exits.
    // No polling, no inference on file events; edits require a relay restart to enable.
    let checking = false;
    watcher = watch(dirname(paths.config), () => {
      if (checking || stopping) return;
      checking = true;
      void loadClaudeNudgerConfig(paths.config)
        .then((current) => {
          if (JSON.stringify(current) !== signature) return stop();
        })
        .catch(() => stop())
        .catch(diagnostic)
        .finally(() => {
          checking = false;
        });
    });
    watcher.on("error", () => {
      diagnostic();
      void stop().catch(diagnostic);
    });
    return {
      notify: (agent) => {
        if (!stopping) nudger?.notify(agent);
      },
      stop,
    };
  } catch {
    diagnostic();
    await stop();
    return { notify: () => {}, stop: async () => {} };
  }
}
