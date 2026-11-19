import { statfs } from "node:fs/promises";

/**
 * Issue #112: SQLite WAL is documented to be unsafe on network filesystems
 * (NFS and friends) — a synloq home on a corporate share risks silent
 * corruption. doctor surfaces a loud warning naming the path and the risk.
 * Detection is best-effort and fail-soft: when the filesystem type cannot be
 * determined, the path counts as local (no false alarms).
 */

export interface FilesystemLocality {
  path: string;
  local: boolean;
  /** Detected filesystem family, when known (e.g. "nfs", "cifs"). */
  fsType?: string;
  warning?: string;
}

export interface FilesystemLocalityOptions {
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to fs.statfs. */
  statfs?: (path: string) => Promise<{ type: number | bigint }>;
}

// Linux/POSIX f_type magics for network filesystems (statfs.h).
const NETWORK_FS_TYPES = new Map<bigint, string>([
  [0x6969n, "nfs"],
  [0xff534d42n, "cifs/smb"],
  [0x65735546n, "sshfs"],
  [0x5346414fn, "afs"],
]);

function warningFor(path: string, fsType: string): string {
  return (
    `${path} is on a network filesystem (${fsType}): SQLite WAL is not safe there — ` +
    "move the Synloq home / project to a local disk (see README, SQLite storage) " +
    "or accept the risk of silent corruption."
  );
}

export async function checkFilesystemLocality(
  path: string,
  options: FilesystemLocalityOptions = {},
): Promise<FilesystemLocality> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Node exposes no GetDriveType: only UNC paths are detectably remote.
    // Mapped drive letters stay undetected — documented in the PR.
    const isUnc = path.startsWith("\\\\") || path.startsWith("//");
    if (isUnc) {
      return { path, local: false, fsType: "unc", warning: warningFor(path, "unc share") };
    }
    return { path, local: true };
  }
  try {
    const probe = options.statfs ?? (async (p: string) => statfs(p));
    const { type } = await probe(path);
    const fsType = NETWORK_FS_TYPES.get(BigInt(type));
    if (fsType === undefined) return { path, local: true };
    return { path, local: false, fsType, warning: warningFor(path, fsType) };
  } catch {
    // Unknown is not a warning: fail soft, never break doctor.
    return { path, local: true };
  }
}
