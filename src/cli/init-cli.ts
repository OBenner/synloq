import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadManifest } from "../config/manifest.js";
import { SynloqError } from "../domain/errors.js";
import { languageSchema, SUPPORTED_LANGUAGES } from "../i18n/index.js";
import { OpencodeApiClient, type OpenCodeSessionHost } from "../host/opencode/client.js";
import { discoverOpenCodeHost } from "../host/opencode/discovery.js";
import { initializeTeam } from "../init/initialize-team.js";
import { createKimiWorkInitHost } from "../init/kimi-work-host.js";
import { initializeOpenCodeTeam } from "../init/opencode-host.js";
import type { InitializeTeamOptions, KimiWorkInitHost, RoleInput } from "../init/types.js";
import { runInitWizard, type InitWizardResult } from "./init-wizard.js";

export interface GenericInitDependencies {
  initialize?: (options: InitializeTeamOptions) => ReturnType<typeof initializeTeam>;
  initializeOpenCode?: (
    options: Parameters<typeof initializeOpenCodeTeam>[0],
  ) => ReturnType<typeof initializeOpenCodeTeam>;
  initHost?: () => Promise<KimiWorkInitHost>;
  openCodeHost?: () => Promise<OpenCodeSessionHost>;
  initWizard?: () => Promise<InitWizardResult>;
  runtimeEntrypoint?: string;
  environment?: NodeJS.ProcessEnv;
}

async function defaultOpenCodeHost(): Promise<OpenCodeSessionHost> {
  const discovered = await discoverOpenCodeHost();
  return new OpencodeApiClient(discovered.baseUrl, {
    ...(discovered.authToken !== undefined ? { authToken: discovered.authToken } : {}),
  });
}

interface InitIo {
  stdout: { write(chunk: string): boolean };
}

function invalid(message: string): never {
  throw new SynloqError("INVALID_INPUT", message);
}

function splitAssignment(value: string, name: string): [string, string] {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    invalid(`--${name} must be <agent-id>:<value>`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseRole(value: string): RoleInput {
  const first = value.indexOf(":");
  const second = first < 0 ? -1 : value.indexOf(":", first + 1);
  if (first < 1 || second < 0 || second === value.length - 1) {
    invalid("--role must be <agent-id>:<title>:<role>");
  }
  return {
    agentId: value.slice(0, first),
    title: value.slice(first + 1, second),
    role: value.slice(second + 1),
  };
}

function defaultPluginSource(environment: NodeJS.ProcessEnv): string {
  if (environment.SYNLOQ_PLUGIN_SOURCE) return resolve(environment.SYNLOQ_PLUGIN_SOURCE);
  if (process.platform === "win32") {
    const appData = environment.APPDATA;
    if (!appData)
      throw new SynloqError("NOT_FOUND", "Kimi Work plugin source cannot be discovered");
    return join(
      appData,
      "kimi-desktop",
      "daimon-share",
      "daimon",
      "plugin-sources",
      "personal",
      "synloq",
    );
  }
  return join(
    environment.HOME ?? homedir(),
    ".kimi",
    "daimon",
    "plugin-sources",
    "personal",
    "synloq",
  );
}

async function defaultWizard(): Promise<InitWizardResult> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runInitWizard({
      question: (prompt) => readline.question(prompt),
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  } finally {
    readline.close();
  }
}

async function existingManifestRoles(
  projectRoot: string,
): Promise<{ project: string; roles: RoleInput[] } | undefined> {
  try {
    await readFile(join(projectRoot, "synloq.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const participants = await loadManifest(projectRoot);
  const project = participants[0]?.project;
  if (!project) invalid("manifest must declare at least one role");
  return {
    project,
    roles: participants.map(({ agentId, title, role }) => ({ agentId, title, role })),
  };
}

export async function runGenericInit(
  args: string[],
  io: InitIo,
  dependencies: GenericInitDependencies,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "project-root": { type: "string" },
      project: { type: "string" },
      role: { type: "string", multiple: true },
      "role-instructions": { type: "string", multiple: true },
      conversation: { type: "string", multiple: true },
      "plugin-source": { type: "string" },
      "synloq-home": { type: "string" },
      host: { type: "string" },
      "relay-url": { type: "string" },
      language: { type: "string" },
      "non-interactive": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.stdout.write(
      "Usage: synloq init [--project-root <path>] [--project <name>] [--host kimi-work|opencode] [--role <id:title:role> ...] [--role-instructions <id:text> ...] [--conversation <id:conversationKey> ...] [--plugin-source <path>] [--synloq-home <path>] [--relay-url <url>] [--language en|ru] [--non-interactive]\n",
    );
    return;
  }

  const hostName = values.host ?? "kimi-work";
  if (hostName !== "kimi-work" && hostName !== "opencode") {
    invalid("--host must be kimi-work or opencode");
  }
  const languageResult = languageSchema.safeParse(values.language ?? "en");
  if (!languageResult.success) {
    invalid(`--language must be one of: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }
  const language = values.language === undefined ? undefined : languageResult.data;

  const environment = dependencies.environment ?? process.env;
  const projectRoot = resolve(values["project-root"] ?? process.cwd());
  const manifest = values.role?.length ? undefined : await existingManifestRoles(projectRoot);
  let project = values.project ?? manifest?.project;
  let roles: RoleInput[] = values.role?.length
    ? values.role.map(parseRole)
    : (manifest?.roles ?? []);
  if (!roles.length) {
    if (values["non-interactive"])
      invalid("at least one --role or an existing manifest is required");
    const wizard = await (dependencies.initWizard ?? defaultWizard)();
    project ??= wizard.project;
    roles = wizard.roles;
  }

  const instructions = new Map(
    (values["role-instructions"] ?? []).map((entry) => splitAssignment(entry, "role-instructions")),
  );
  const conversations = new Map(
    (values.conversation ?? []).map((entry) => splitAssignment(entry, "conversation")),
  );
  roles = roles.map((role) => {
    const instruction = instructions.get(role.agentId);
    const conversationKey = conversations.get(role.agentId);
    return {
      ...role,
      ...(instruction !== undefined ? { instructions: instruction } : {}),
      ...(conversationKey !== undefined ? { conversationKey } : {}),
    };
  });
  for (const id of [...instructions.keys(), ...conversations.keys()]) {
    if (!roles.some((role) => role.agentId === id)) invalid(`unknown role assignment: ${id}`);
  }

  const runtimeEntrypoint =
    dependencies.runtimeEntrypoint ?? fileURLToPath(new URL("../mcp/stdio.js", import.meta.url));

  if (hostName === "opencode") {
    const openCodeHost = await (dependencies.openCodeHost ?? defaultOpenCodeHost)();
    const initializeOpenCode = dependencies.initializeOpenCode ?? initializeOpenCodeTeam;
    const result = await initializeOpenCode({
      projectRoot,
      project: project ?? basename(projectRoot),
      roles,
      ...(values["synloq-home"] ? { synloqHome: resolve(values["synloq-home"]) } : {}),
      ...(values["relay-url"] ? { relayUrl: values["relay-url"] } : {}),
      ...(language ? { language } : {}),
      runtimeEntrypoint,
      host: openCodeHost,
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const host = await (dependencies.initHost ?? createKimiWorkInitHost)();
  try {
    const initialize = dependencies.initialize ?? initializeTeam;
    const result = await initialize({
      projectRoot,
      project: project ?? basename(projectRoot),
      roles,
      pluginSourcePath: values["plugin-source"]
        ? resolve(values["plugin-source"])
        : defaultPluginSource(environment),
      ...(values["synloq-home"] ? { synloqHome: resolve(values["synloq-home"]) } : {}),
      ...(language ? { language } : {}),
      runtimeEntrypoint,
      host,
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await host.close?.();
  }
}
