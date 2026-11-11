import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../config/atomic-file.js";
import { CredentialStore } from "../config/credentials.js";
import { writeManifest } from "../config/manifest.js";
import { projectPaths } from "../config/paths.js";
import { TeamStateStore, type TeamConversation, type TeamState } from "../config/team-state.js";
import { SynloqError } from "../domain/errors.js";
import { agentId, type Participant } from "../domain/message.js";
import type {
  KimiWorkConversationSummary,
  KimiWorkListResult,
} from "../host/kimi-work/control-client.js";
import {
  assertPluginOwnership,
  renderKimiWorkPlugin,
  roleInstructions,
} from "./plugin-renderer.js";
import type {
  InitializeTeamOptions,
  InitializeTeamResult,
  InitializedRole,
  KimiWorkInitHost,
  RenderPluginRole,
  RoleInput,
} from "./types.js";

const roleSchema = z
  .object({
    agentId,
    title: z.string().min(1).max(128),
    role: z.string().min(1).max(8_000),
    instructions: z.string().min(1).max(16_000).optional(),
    conversationKey: z.string().min(1).max(256).optional(),
  })
  .strict();

async function listClientConversations(
  host: KimiWorkInitHost,
  projectRoot: string,
): Promise<KimiWorkConversationSummary[]> {
  const conversations: KimiWorkConversationSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result: KimiWorkListResult = await host.list({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      workspacePath: projectRoot,
      limit: 100,
      includeTemporary: false,
      ...(cursor ? { cursor } : {}),
    });
    conversations.push(...result.conversations);
    if (!result.page.hasMore) return conversations;
    if (!result.page.nextCursor || result.page.nextCursor === cursor) {
      throw new SynloqError("INVALID_INPUT", "Kimi Work conversation pagination is invalid");
    }
    cursor = result.page.nextCursor;
  }
}

function eligible(conversation: KimiWorkConversationSummary, projectRoot: string): boolean {
  return (
    conversation.agentId === "main" &&
    conversation.sessionKey === "agent:main:main" &&
    conversation.origin === "client" &&
    conversation.workspacePath === projectRoot
  );
}

function binding(
  role: RoleInput,
  conversation: KimiWorkConversationSummary,
  projectRoot: string,
): TeamConversation {
  if (!eligible(conversation, projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Kimi Work conversation is not eligible for this role");
  }
  return {
    agentId: role.agentId,
    workAgentId: "main",
    sessionKey: "agent:main:main",
    conversationKey: conversation.conversationKey,
    conversationId: conversation.conversationId,
    ...(conversation.kernelSessionId ? { kernelSessionId: conversation.kernelSessionId } : {}),
    workspacePath: projectRoot,
  };
}

function exactConversation(
  conversations: KimiWorkConversationSummary[],
  conversationKey: string,
  projectRoot: string,
): KimiWorkConversationSummary {
  const matches = conversations.filter(
    (conversation) =>
      conversation.conversationKey === conversationKey && eligible(conversation, projectRoot),
  );
  if (matches.length !== 1) {
    throw new SynloqError("INVALID_INPUT", "Kimi Work conversation binding cannot be verified");
  }
  return matches[0]!;
}

export async function initializeTeam(
  options: InitializeTeamOptions,
): Promise<InitializeTeamResult> {
  const project = z.string().min(1).max(128).parse(options.project);
  const roles = z.array(roleSchema).min(1).parse(options.roles) as RoleInput[];
  const projectRoot = await realpath(options.projectRoot);
  const ids = new Set(roles.map((role) => role.agentId));
  if (ids.size !== roles.length) {
    throw new SynloqError("INVALID_INPUT", "Synloq role IDs must be unique");
  }
  const suppliedKeys = roles.flatMap((role) => role.conversationKey ?? []);
  if (new Set(suppliedKeys).size !== suppliedKeys.length) {
    throw new SynloqError("INVALID_INPUT", "one conversation cannot belong to multiple roles");
  }

  const paths = await projectPaths(projectRoot, options.synloqHome);
  const stateStore = new TeamStateStore(paths.bindings);
  let state = await stateStore.read();
  if (state && (state.project !== project || state.projectRoot !== projectRoot)) {
    throw new SynloqError("INVALID_INPUT", "Synloq project state ownership does not match");
  }
  await assertPluginOwnership(resolve(options.pluginSourcePath), project, projectRoot);

  const participants: Participant[] = roles.map((role) => ({
    project,
    agentId: role.agentId,
    title: role.title,
    role: role.role,
  }));
  await writeManifest(projectRoot, participants);
  const credentials = new CredentialStore(projectRoot, paths.home);
  await credentials.ensureCredential(project, "operator");

  const used = new Map<string, string>();
  for (const [id, conversation] of Object.entries(state?.conversations ?? {})) {
    used.set(conversation.conversationKey, id);
  }
  const bindings = new Map<string, TeamConversation>();
  let conversations: KimiWorkConversationSummary[] | undefined;
  const list = async (): Promise<KimiWorkConversationSummary[]> => {
    conversations = await listClientConversations(options.host, projectRoot);
    return conversations;
  };

  for (const role of roles) {
    const instructions = roleInstructions(role);
    const existing = state?.conversations[role.agentId];
    let conversation: KimiWorkConversationSummary;
    if (existing) {
      conversation = exactConversation(await list(), existing.conversationKey, projectRoot);
    } else if (role.conversationKey) {
      conversation = exactConversation(await list(), role.conversationKey, projectRoot);
    } else {
      try {
        conversation = await options.host.create({
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client",
          activate: false,
          workspacePath: projectRoot,
          clientInstructions: instructions,
        });
      } catch (error) {
        let candidates: KimiWorkConversationSummary[];
        try {
          candidates = (await list()).filter(
            (candidate) =>
              eligible(candidate, projectRoot) &&
              candidate.clientInstructions === instructions &&
              !used.has(candidate.conversationKey),
          );
        } catch {
          throw new SynloqError(
            "DELIVERY_UNCERTAIN",
            `Kimi Work chat creation for ${role.agentId} is uncertain`,
          );
        }
        if (candidates.length !== 1) throw error;
        conversation = candidates[0]!;
      }
    }

    const owner = used.get(conversation.conversationKey);
    if (owner && owner !== role.agentId) {
      throw new SynloqError("INVALID_INPUT", "one conversation cannot belong to multiple roles");
    }
    const nextBinding = binding(role, conversation, projectRoot);
    used.set(nextBinding.conversationKey, role.agentId);
    bindings.set(role.agentId, nextBinding);
    state = await stateStore.update((current): TeamState => {
      const base: TeamState = current ?? {
        version: 1,
        project,
        projectRoot,
        conversations: {},
      };
      return {
        ...base,
        project,
        projectRoot,
        pluginSourcePath: resolve(options.pluginSourcePath),
        conversations: { ...base.conversations, [role.agentId]: nextBinding },
      };
    });
    conversations = undefined;
  }

  const renderedRoles: RenderPluginRole[] = [];
  const initializedRoles: InitializedRole[] = [];
  for (const role of roles) {
    const roleBinding = bindings.get(role.agentId);
    if (!roleBinding) throw new SynloqError("INVALID_INPUT", "role binding was not initialized");
    const credential = await credentials.ensureCredential(project, role.agentId);
    const configPath = join(paths.runtime, "mcp", `${role.agentId}.json`);
    await writeJsonAtomic(configPath, {
      relayUrl: "http://127.0.0.1:4100",
      credentialPath: credential.tokenPath,
      synloqHome: paths.home,
      kimiWork: {
        projectRoot,
        agentId: role.agentId,
        conversationKey: roleBinding.conversationKey,
        workAgentId: roleBinding.workAgentId,
        ...(roleBinding.kernelSessionId ? { kernelSessionId: roleBinding.kernelSessionId } : {}),
      },
    });
    renderedRoles.push({ role, binding: roleBinding, configPath });
    initializedRoles.push({
      agentId: role.agentId,
      conversationKey: roleBinding.conversationKey,
      configPath,
      credentialPath: credential.tokenPath,
    });
  }

  await renderKimiWorkPlugin({
    ...(options.templatePath ? { templatePath: options.templatePath } : {}),
    pluginSourcePath: resolve(options.pluginSourcePath),
    project,
    projectRoot,
    projectKey: paths.key,
    runtimeEntrypoint: options.runtimeEntrypoint,
    roles: renderedRoles,
  });
  return {
    project,
    manifestPath: join(projectRoot, "synloq.yaml"),
    statePath: paths.bindings,
    pluginSourcePath: resolve(options.pluginSourcePath),
    registrationRequired: true,
    roles: initializedRoles,
  };
}

export type {
  InitializeTeamOptions,
  InitializeTeamResult,
  InitializedRole,
  KimiWorkInitHost,
  RoleInput,
} from "./types.js";
