import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isPermissionError, permissionDenied } from "../domain/errors.js";

export async function writeTextAtomic(path: string, value: string, mode = 0o600): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const file = await open(temporary, "wx", mode);
      try {
        await file.writeFile(value, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      // Windows does not expose directory fsync through node:fs. On POSIX,
      // persist the rename too; an error here means publication may have happened.
      if (process.platform !== "win32") {
        const directory = await open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
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
