import { CredentialStore } from "../../src/config/credentials.js";
import { loadManifest } from "../../src/config/manifest.js";

/**
 * Issues operator and per-participant credentials for test fixtures.
 * Replaces the removed initCommand export: tokens stay inside the test
 * process and are never returned through a command result.
 */
export async function issueTestCredentials(projectRoot: string): Promise<Map<string, string>> {
  const participants = await loadManifest(projectRoot);
  const project = participants[0]?.project;
  if (!project) throw new Error("manifest must declare at least one agent");
  const store = new CredentialStore(projectRoot);
  const tokens = new Map<string, string>();
  tokens.set("operator", await store.issue(project, "operator"));
  for (const participant of participants) {
    tokens.set(participant.agentId, await store.issue(project, participant.agentId));
  }
  return tokens;
}
