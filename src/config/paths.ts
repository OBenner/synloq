import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ProjectPaths {
  key: string;
  home: string;
  database: string;
  credentials: string;
  runtime: string;
  bindings: string;
  tokens: string;
}

export async function projectPaths(
  projectRoot: string,
  synloqHome?: string,
): Promise<ProjectPaths> {
  const canonical = await realpath(projectRoot);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const home = resolve(synloqHome ?? process.env.SYNLOQ_HOME ?? join(homedir(), ".synloq"));
  return {
    key,
    home,
    database: join(home, "data", `${key}.sqlite`),
    credentials: join(home, "credentials", `${key}.json`),
    runtime: join(home, "runtime", key),
    bindings: join(home, "state", `${key}.json`),
    tokens: join(home, "credentials", key),
  };
}
