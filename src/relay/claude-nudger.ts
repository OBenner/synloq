import type { ClaudeBinding, ClaudeNudgerConfig } from "../config/claude-nudger.js";
import { ClaudeNudgeLedger } from "../storage/claude-nudge-ledger.js";
import { acquireClaudeOwnership } from "../host/claude/ownership.js";
import {
  checkpointTranscript,
  claudeNudgePrompt,
  transcriptDelta,
  verifyClaudeTurn,
} from "../host/claude/proof.js";
import {
  claudeNudgeArgs,
  classifyClaudeResult,
  noClaudeProcesses,
  runClaudeProcess,
  type ClaudeRunner,
} from "../host/claude/process.js";

export interface ClaudeNudgerOptions {
  project: string;
  config: ClaudeNudgerConfig;
  ledger: ClaudeNudgeLedger;
  now: () => number;
  candidate: (agentId: string) => { id: string; threadId: string; ids?: string[] } | undefined;
  acknowledged: (id: string) => boolean;
  eligible: (binding: ClaudeBinding) => Promise<boolean>;
  processClear?: () => Promise<boolean>;
  run?: ClaudeRunner;
}

/** Relay-owned, event-driven, bounded to one queued hint per configured role. No timer/backfill. */
export class ClaudeNudger {
  private readonly owners = new Map<string, Awaited<ReturnType<typeof acquireClaudeOwnership>>>();
  private readonly pending = new Set<string>();
  private readonly abort = new AbortController();
  private flight: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly options: ClaudeNudgerOptions) {}

  async start(): Promise<void> {
    try {
      for (const binding of this.options.config.bindings) {
        const owner = await acquireClaudeOwnership(binding.transcript, binding.sessionId, "nudger");
        this.owners.set(binding.agentId, owner);
        await checkpointTranscript(owner.transcript, binding.sessionId);
        this.options.ledger.ownership(
          this.options.project,
          binding.agentId,
          binding.sessionId,
          true,
        );
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  notify(agentId: string): void {
    if (this.stopped || !this.owners.has(agentId)) return;
    this.pending.add(agentId);
    if (!this.flight)
      this.flight = this.drain().finally(() => {
        this.flight = undefined;
      });
  }
  async settled(): Promise<void> {
    await this.flight;
  }
  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.size) {
      const agentId = this.pending.values().next().value!;
      this.pending.delete(agentId);
      const binding = this.options.config.bindings.find((b) => b.agentId === agentId)!;
      try {
        await this.attempt(binding);
      } catch {
        /* Retain any reserved attempt on ambiguity; never leak diagnostics. */
      }
    }
  }
  private async attempt(binding: ClaudeBinding): Promise<void> {
    const { options } = this,
      run = options.run ?? runClaudeProcess;
    const candidate = options.candidate(binding.agentId);
    if (!candidate || !(await options.eligible(binding)) || this.stopped) return;
    const targetIds = candidate.ids ?? [candidate.id];
    if (!(await (options.processClear ?? noClaudeProcesses)()) || this.stopped) return;
    const version = await run(options.config.executable, ["--version"], {
      cwd: binding.cwd,
      signal: this.abort.signal,
      timeoutMs: 5000,
      limit: 1024,
    });
    if (
      version.interrupted ||
      version.exitCode !== 0 ||
      version.stdout.trim() !== `${options.config.cliVersion} (Claude Code)`
    )
      return;
    const owner = this.owners.get(binding.agentId)!;
    const checkpoint = await checkpointTranscript(owner.transcript, binding.sessionId);
    // Re-check after asynchronous preflight. Cooperating launchers are excluded by our held lock.
    if (
      this.stopped ||
      !(await options.eligible(binding)) ||
      options.candidate(binding.agentId)?.id !== candidate.id ||
      this.stopped
    )
      return;
    const attempt = options.ledger.reserve({
      project: options.project,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      targetId: candidate.id,
      targetIds,
      transcript: owner.transcript,
      now: options.now(),
    });
    if (!attempt) return;
    let outcome: ReturnType<typeof classifyClaudeResult> = "uncertain",
      proof = false;
    try {
      const result = await run(
        options.config.executable,
        claudeNudgeArgs(binding, claudeNudgePrompt(targetIds, attempt.marker)),
        { cwd: binding.cwd, signal: this.abort.signal, timeoutMs: 60_000 },
      );
      outcome = classifyClaudeResult(result, binding.sessionId);
      if (outcome === "complete") {
        proof = verifyClaudeTurn({
          delta: await transcriptDelta(owner.transcript, checkpoint),
          sessionId: binding.sessionId,
          agentId: binding.agentId,
          targetId: candidate.id,
          targetIds,
          marker: attempt.marker,
          previousUuid: checkpoint.previousUuid,
          parentLinks: checkpoint.parentLinks ?? [],
          acknowledged: () => targetIds.every((id) => options.acknowledged(id)),
        });
      }
    } finally {
      options.ledger.finish(
        attempt.id,
        proof ? "success" : outcome === "complete" ? "uncertain" : outcome,
        proof,
      );
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    this.abort.abort();
    await this.flight;
    for (const [agent, owner] of this.owners) {
      await owner.release();
      const binding = this.options.config.bindings.find((b) => b.agentId === agent)!;
      this.options.ledger.ownership(this.options.project, agent, binding.sessionId, false);
      this.owners.delete(agent);
    }
  }
}
