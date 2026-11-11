import { SynloqError } from "../domain/errors.js";
import { agentId } from "../domain/message.js";
import type { RoleInput } from "../init/types.js";

export interface InitWizardIo {
  question(prompt: string): Promise<string>;
  write(line: string): void;
}

export interface InitWizardResult {
  project: string;
  roles: RoleInput[];
}

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new SynloqError("INVALID_INPUT", `${field} is required`);
  return result;
}

function confirmed(value: string): boolean {
  return ["y", "yes"].includes(value.trim().toLowerCase());
}

export async function runInitWizard(io: InitWizardIo): Promise<InitWizardResult> {
  const project = required(await io.question("Project name: "), "project name");
  const roles: RoleInput[] = [];
  for (;;) {
    const id = required(
      await io.question("Role ID (lowercase, for example reviewer): "),
      "role ID",
    );
    if (!agentId.safeParse(id).success || roles.some((role) => role.agentId === id)) {
      throw new SynloqError("INVALID_INPUT", "role ID is invalid or duplicated");
    }
    const title = required(await io.question("Display name: "), "display name");
    const responsibility = required(
      await io.question("Responsibilities and boundaries: "),
      "role responsibility",
    );
    const additions = (await io.question("Optional instruction additions: ")).trim();
    roles.push({
      agentId: id,
      title,
      role: responsibility,
      ...(additions ? { instructions: additions } : {}),
    });
    if (!confirmed(await io.question("Add another role? [y/N]: "))) break;
  }

  io.write("Confirm Synloq roles:");
  for (const role of roles) io.write(`- ${role.agentId}: ${role.title} — ${role.role}`);
  if (!confirmed(await io.question("Initialize these roles? [y/N]: "))) {
    throw new SynloqError("INVALID_INPUT", "initialization was not confirmed");
  }
  return { project, roles };
}
