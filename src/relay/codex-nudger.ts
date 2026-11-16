import type { CodexNudgerConfig } from "../config/codex-nudger.js";
import { formatDiagnostic } from "../diagnostics.js";
import { queueCodexNudge, type QueueNudgeOptions, type QueueResult } from "../host/codex/queue.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import type { NudgeLedger } from "../storage/nudge-ledger.js";

export const CODEX_NUDGE_INTERVAL_MS = 15_000;
interface Options {
  project: string;
  messages: SQLiteMessageStore;
  ledger: NudgeLedger;
  config: CodexNudgerConfig;
  eligible: (agentId: string) => Promise<boolean>;
  queue?: (options: QueueNudgeOptions) => Promise<QueueResult>;
  now?: () => number;
  diagnostic?: (line: string) => void;
}

export class CodexQueueNudger {
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly reportedBlocks = new Set<string>();
  private readonly abort = new AbortController();
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), CODEX_NUDGE_INTERVAL_MS);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= this.sweep()
      .catch(() => {
        // Storage/eligibility uncertainty must not become repeated CLI effects.
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.log("NUDGER_DISABLED storage or eligibility failure; operator review required");
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.inFlight;
  }

  private log(text: string): void {
    try {
      (this.options.diagnostic ?? ((line) => process.stderr.write(`${line}\n`)))(
        formatDiagnostic(`Synloq Codex nudger: ${text}`, new Date(this.now())),
      );
    } catch {
      /* A diagnostic sink never controls queue ownership. */
    }
  }

  private reportExhausted(agentId: string, messageId: string): void {
    if (this.options.messages.isMessageAcknowledged(messageId, this.options.project)) return;
    if (this.options.ledger.reportExhausted(this.options.project, messageId)) {
      this.log(
        `role=${agentId} messageId=${messageId} undelivered after 5 nudges; automatic nudges stopped; ack absent (turn/delivery not inferred)`,
      );
    }
  }

  private async sweep(): Promise<void> {
    const { project, messages, ledger, config } = this.options;
    for (const binding of config.bindings) {
      if (this.stopped) return;
      if (!(await this.options.eligible(binding.agentId))) continue;
      const head = messages.nudgeCandidate(project, binding.agentId);
      if (!head) continue;
      this.reportExhausted(binding.agentId, head.id);
      const count = ledger.reserve(
        project,
        binding.agentId,
        head.id,
        binding.threadId,
        this.now(),
        (id) => messages.isMessageAcknowledged(id, project),
      );
      if (count === undefined) {
        const reason = ledger.blockedReason(project, binding.agentId);
        const key = `${binding.agentId}:${head.id}:${reason}`;
        if (reason && !this.reportedBlocks.has(key)) {
          this.reportedBlocks.add(key);
          this.log(
            `role=${binding.agentId} messageId=${head.id} blocked=${reason}; no blind retry; operator review required`,
          );
        }
        continue;
      }
      const beforeQueue = async () =>
        !this.stopped &&
        (await this.options.eligible(binding.agentId)) &&
        messages.nudgeCandidate(project, binding.agentId)?.id === head.id;
      let result: QueueResult;
      try {
        result = await (this.options.queue ?? queueCodexNudge)({
          executable: config.executable,
          version: config.cliVersion,
          threadId: binding.threadId,
          message: `Synloq: pending messageId=${head.id}, threadId=${head.threadId}. Run synloq_inbox on your assigned channel, read the backlog, then ack and reply in the original Synloq thread.`,
          signal: this.abort.signal,
          beforeQueue,
        });
      } catch {
        result = { kind: "uncertain", code: "QUEUE_PROCESS_FAILURE" };
      }
      ledger.finish(project, binding.agentId, head.id, count, result);
      this.log(
        `role=${binding.agentId} messageId=${head.id} attempt=${count} ${result.kind === "accepted" ? `queue accepted queueId=${result.queueId}; nudge does not guarantee turn start` : `${result.kind} ${result.code}; no blind retry`}`,
      );
      this.reportExhausted(binding.agentId, head.id);
    }
  }
}
