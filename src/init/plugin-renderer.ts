import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeJsonAtomic, writeTextAtomic } from "../config/atomic-file.js";
import { SynloqError } from "../domain/errors.js";
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

export function roleInstructions(role: RoleInput): string {
  return [
    "You are one visible role in a Synloq project team.",
    `Role ID: ${role.agentId}`,
    `Display name: ${role.title}`,
    `Responsibilities and boundaries: ${role.role}`,
    role.instructions ? `Confirmed additions: ${role.instructions}` : undefined,
    "Use only the Synloq MCP channel assigned to this role; never use another role's channel.",
    "Use QUESTION, TASK, RESULT, BLOCKED, or NOTICE message prefixes.",
    "Acknowledge only after actual reading and reply in the original thread.",
    "A task is complete only after an explicit RESULT with real checks and limitations.",
    "Request operator approval for risky actions, external effects, new dependencies, secret changes, and work outside the workspace.",
    "Stop automatic delegation at four Synloq hops (protocol v1 hop limit) and ask the operator before continuing.",
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
        displayName: `Synloq ${role.title}`,
        description: `Authenticated channel for project role ${role.agentId}.`,
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
      roleInstructions(role),
      "",
    ].join("\n");
    await writeTextAtomic(
      join(options.pluginSourcePath, "agents", `synloq-${role.agentId}.md`),
      agent,
      0o644,
    );
  }
}
