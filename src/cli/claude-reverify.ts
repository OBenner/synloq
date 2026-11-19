import { stat } from "node:fs/promises";
import {
  claudeNudgerPaths,
  loadClaudeNudgerConfig,
  validateClaudeBinding,
} from "../config/claude-nudger.js";
import { loadManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { SynloqError } from "../domain/errors.js";
import { acquireClaudeOwnership } from "../host/claude/ownership.js";
import { noClaudeProcesses } from "../host/claude/process.js";
import { reverifyClaudeTranscript } from "../host/claude/proof.js";
import { NUDGE_UUID } from "../relay/nudge-identifiers.js";
import { acquireServeLock } from "../relay/serve-lock.js";
import { ClaudeNudgeLedger, type ClaudeReverification } from "../storage/claude-nudge-ledger.js";
import { SQLiteMessageStore } from "../storage/message-store.js";

type ReverifyStatus = ClaudeReverification | "unproven";

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function capturedTargets(value: string, targetId: string): string[] | undefined {
  try {
    const ids: unknown = JSON.parse(value);
    if (
      Array.isArray(ids) &&
      ids[0] === targetId &&
      ids.length <= 100 &&
      ids.every((id) => typeof id === "string" && NUDGE_UUID.test(id)) &&
      new Set(ids).size === ids.length
    )
      return ids;
  } catch {
    // A malformed attempt cannot establish its original target set.
  }
  return undefined;
}

export async function reverifyClaudeNudgeCommand(options: {
  projectRoot: string;
  synloqHome?: string;
  attemptId: string;
}): Promise<{ attemptId: string; status: ReverifyStatus }> {
  if (!NUDGE_UUID.test(options.attemptId))
    throw new SynloqError("INVALID_INPUT", "--attempt-id must be a UUID");
  const attemptId = options.attemptId.toLowerCase();
  const project = (await loadManifest(options.projectRoot))[0]?.project;
  if (!project) throw new SynloqError("INVALID_INPUT", "manifest must declare at least one agent");
  const paths = await projectPaths(options.projectRoot, options.synloqHome);
  const { ledger: ledgerPath, config } = claudeNudgerPaths(paths);
  if (!(await isExistingFile(paths.database)))
    throw new SynloqError("NOT_FOUND", "initialize the project relay database before re-verifying");
  const lock = await acquireServeLock(paths.database);
  const result = (status: ReverifyStatus) => ({ attemptId, status });
  try {
    if (!(await isExistingFile(ledgerPath))) return result("not-uncertain");
    const ledger = new ClaudeNudgeLedger(ledgerPath);
    try {
      const attempt = ledger.findAttempt(project, attemptId);
      if (attempt?.outcome !== "uncertain") return result("not-uncertain");
      if (attempt.corrected) return result("already-verified");
      const targetIds = capturedTargets(attempt.targets, attempt.targetId);
      if (!targetIds) return result("unproven");
      const current = await loadClaudeNudgerConfig(config, { includeDisabled: true });
      const binding = current?.bindings.find(
        (item) =>
          item.agentId === attempt.agentId &&
          item.sessionId.toLowerCase() === attempt.sessionId.toLowerCase(),
      );
      if (!binding) return result("unproven");
      await validateClaudeBinding(binding, project, options.projectRoot);
      if (!(await noClaudeProcesses()))
        throw new SynloqError("ALREADY_RUNNING", "close Claude sessions before re-verifying");
      const owner = await acquireClaudeOwnership(
        binding.transcript,
        binding.sessionId,
        "manual",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        if (error.code === "EEXIST")
          throw new SynloqError("ALREADY_RUNNING", "Claude transcript ownership lock is held");
        throw error;
      });
      if (!owner) return result("unproven");
      try {
        if (attempt.transcript !== null && attempt.transcript !== owner.transcript)
          return result("unproven");
        const messages = new SQLiteMessageStore(paths.database, undefined, { readOnly: true });
        try {
          const verified = await reverifyClaudeTranscript(owner.transcript, {
            ...attempt,
            targetIds,
            acknowledged: () =>
              targetIds.every((id) => messages.isMessageAcknowledged(id, project, attempt.agentId)),
          });
          return result(
            verified ? ledger.recordReverification(project, attemptId, Date.now()) : "unproven",
          );
        } finally {
          messages.close();
        }
      } finally {
        await owner.release();
      }
    } finally {
      ledger.close();
    }
  } finally {
    await lock.release();
  }
}
