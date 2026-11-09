import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectPaths {
  key: string;
  database: string;
  credentials: string;
}

export async function projectPaths(projectRoot: string): Promise<ProjectPaths> {
  const canonical = await realpath(projectRoot);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const home = process.env.SYNLOQ_HOME ?? join(homedir(), ".synloq");
  return {
    key,
    database: join(home, "data", `${key}.sqlite`),
    credentials: join(home, "credentials", `${key}.json`),
  };
}
