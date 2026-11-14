import type { KimiWorkTeamConversation } from "../config/team-state.js";
import type { Language } from "../i18n/index.js";
import type {
  KimiWorkConversationSummary,
  KimiWorkCreateInput,
  KimiWorkListOptions,
  KimiWorkListResult,
} from "../host/kimi-work/control-client.js";

export interface RoleInput {
  agentId: string;
  title: string;
  role: string;
  instructions?: string;
  conversationKey?: string;
}

export interface KimiWorkInitHost {
  create(input: KimiWorkCreateInput): Promise<KimiWorkConversationSummary>;
  list(options: KimiWorkListOptions): Promise<KimiWorkListResult>;
  close?(): Promise<void>;
}

export interface InitializeTeamOptions {
  projectRoot: string;
  project: string;
  roles: RoleInput[];
  pluginSourcePath: string;
  synloqHome?: string;
  runtimeEntrypoint: string;
  host: KimiWorkInitHost;
  templatePath?: string;
  language?: Language;
}

export interface InitializedRole {
  agentId: string;
  conversationKey: string;
  configPath: string;
  credentialPath: string;
}

export interface InitializeTeamResult {
  project: string;
  manifestPath: string;
  statePath: string;
  pluginSourcePath: string;
  registrationRequired: boolean;
  // Issue #36 (a): deterministic plugin version and change detection, so the
  // operator sees whether an Install/Update is actually needed.
  pluginVersion: string;
  previousPluginVersion?: string;
  channelsChanged: boolean;
  nextStep: string;
  roles: InitializedRole[];
}

export interface RenderPluginRole {
  role: RoleInput;
  binding: KimiWorkTeamConversation;
  configPath: string;
}

export interface RenderPluginOptions {
  templatePath?: string;
  pluginSourcePath: string;
  project: string;
  projectRoot: string;
  projectKey: string;
  runtimeEntrypoint: string;
  roles: RenderPluginRole[];
  language?: Language;
}
