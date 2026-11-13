import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeJsonAtomic, writeTextAtomic } from "../config/atomic-file.js";
import { SynloqError } from "../domain/errors.js";
import { DEFAULT_LANGUAGE, translate, type Language } from "../i18n/index.js";
import { en } from "../i18n/locales/en.js";
import type { RoleInput, RenderPluginOptions } from "./types.js";

const OWNER_FILE = ".synloq-owner.json";
const TOOLS = [
  "synloq_list",
  "synloq_send",
  "synloq_reply",
  "synloq_inbox",
  "synloq_wait",
  "synloq_ack",
];

const ownerSchema = z
  .object({ version: z.literal(1), project: z.string().min(1), projectRoot: z.string().min(1) })
  .strict();

function defaultTemplatePath(): string {
  return fileURLToPath(new URL("../../plugins/synloq", import.meta.url));
}

// English canonical charter, pinned by tests (#16). Localized variants come
// from the dictionaries; this export stays as the single English source.
export const TEAM_CHARTER_SUMMARY: string = en["role.charter"];

export function roleInstructions(role: RoleInput, language: Language = DEFAULT_LANGUAGE): string {
  return [
    translate(language, "role.intro"),
    translate(language, "role.id", { agentId: role.agentId }),
    translate(language, "role.displayName", { title: role.title }),
    translate(language, "role.responsibilities", { role: role.role }),
    role.instructions
      ? translate(language, "role.confirmedAdditions", { instructions: role.instructions })
      : undefined,
    translate(language, "role.ownChannel"),
    translate(language, "role.prefixes"),
    translate(language, "role.ackRule"),
    translate(language, "role.resultRule"),
    translate(language, "role.approvalRule"),
    translate(language, "role.hopLimit"),
    translate(language, "role.charter"),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function assertPluginOwnership(
  pluginSourcePath: string,
  project: string,
  projectRoot: string,
): Promise<void> {
  const ownerPath = join(pluginSourcePath, OWNER_FILE);
  try {
    const owner = ownerSchema.parse(JSON.parse(await readFile(ownerPath, "utf8")));
    if (owner.project !== project || owner.projectRoot !== projectRoot) {
      throw new SynloqError("INVALID_INPUT", "Synloq plugin source belongs to another project");
    }
    return;
  } catch (error) {
    if (error instanceof SynloqError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SynloqError("INVALID_INPUT", "Synloq plugin ownership is invalid");
    }
  }

  try {
    await readFile(join(pluginSourcePath, "kimi.plugin.json"), "utf8");
    throw new SynloqError("INVALID_INPUT", "Synloq plugin source has no project ownership record");
  } catch (error) {
    if (error instanceof SynloqError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function renderKimiWorkPlugin(options: RenderPluginOptions): Promise<void> {
  const projectRoot = resolve(options.projectRoot);
  const language = options.language ?? DEFAULT_LANGUAGE;
  await assertPluginOwnership(options.pluginSourcePath, options.project, projectRoot);
  const templatePath = options.templatePath ?? defaultTemplatePath();
  await cp(templatePath, options.pluginSourcePath, {
    recursive: true,
    filter: (source) => {
      const path = relative(templatePath, source);
      return (
        path === "" ||
        (path !== "kimi.plugin.json" && path !== OWNER_FILE && !path.startsWith("agents"))
      );
    },
  });

  const manifest = JSON.parse(
    await readFile(join(templatePath, "kimi.plugin.json"), "utf8"),
  ) as Record<string, unknown> & {
    version: string;
    interface: Record<string, unknown> & { mcpOverrides?: Record<string, unknown> };
  };
  const servers = Object.fromEntries(
    options.roles.map(({ role, configPath }) => [
      `synloq-${role.agentId}`,
      {
        command: "node",
        args: [resolve(options.runtimeEntrypoint), resolve(configPath)],
        enabledTools: TOOLS,
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 35_000,
        enabled: true,
      },
    ]),
  );
  const overrides = Object.fromEntries(
    options.roles.map(({ role }) => [
      `synloq-${role.agentId}`,
      {
        displayName: translate(language, "channel.displayName", { title: role.title }),
        description: translate(language, "channel.description", { agentId: role.agentId }),
      },
    ]),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ projectRoot, servers, overrides }))
    .digest("hex")
    .slice(0, 12);
  manifest.version = `0.1.0+local.${options.projectKey}.${digest}`;
  manifest.interface.mcpOverrides = overrides;
  manifest.mcpServers = servers;

  await writeJsonAtomic(join(options.pluginSourcePath, "kimi.plugin.json"), manifest, 0o644);
  const locale = JSON.parse(
    await readFile(join(templatePath, "locales", "zh-CN.json"), "utf8"),
  ) as { mcpOverrides?: Record<string, unknown> };
  locale.mcpOverrides = overrides;
  await writeJsonAtomic(join(options.pluginSourcePath, "locales", "zh-CN.json"), locale, 0o644);
  await writeJsonAtomic(join(options.pluginSourcePath, OWNER_FILE), {
    version: 1,
    project: options.project,
    projectRoot,
  });
  for (const { role } of options.roles) {
    const agent = [
      "---",
      `name: synloq-${role.agentId}`,
      `description: ${role.title} — ${role.role}`,
      "---",
      "",
      `# ${role.title}`,
      "",
      roleInstructions(role, language),
      "",
    ].join("\n");
    await writeTextAtomic(
      join(options.pluginSourcePath, "agents", `synloq-${role.agentId}.md`),
      agent,
      0o644,
    );
  }
}
