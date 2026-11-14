import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isPermissionError, permissionDenied } from "../domain/errors.js";

export async function writeTextAtomic(path: string, value: string, mode = 0o600): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    if (isPermissionError(error)) throw permissionDenied("writing a file atomically", path, error);
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}
