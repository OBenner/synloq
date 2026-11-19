import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorCommand } from "../../src/cli/commands.js";
import { checkFilesystemLocality } from "../../src/diagnostics/fs-locality.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("checkFilesystemLocality (#112)", () => {
  it("flags NFS via statfs f_type on POSIX", async () => {
    const locality = await checkFilesystemLocality("/mnt/share", {
      platform: "linux",
      statfs: async () => ({ type: 0x6969 }),
    });
    expect(locality.local).toBe(false);
    expect(locality.fsType).toBe("nfs");
    expect(locality.warning).toContain("network filesystem");
    expect(locality.warning).toContain("SQLite WAL");
  });

  it("flags CIFS/SMB and sshfs magics", async () => {
    for (const [magic, name] of [
      [0xff534d42, "cifs/smb"],
      [0x65735546n, "sshfs"],
    ] as const) {
      const locality = await checkFilesystemLocality("/mnt/share", {
        platform: "linux",
        statfs: async () => ({ type: magic }),
      });
      expect(locality.local).toBe(false);
      expect(locality.fsType).toBe(name);
    }
  });

  it("treats unknown filesystem types as local (no false alarms)", async () => {
    const locality = await checkFilesystemLocality("/home/user", {
      platform: "linux",
      statfs: async () => ({ type: 0xef53 }), // ext4
    });
    expect(locality).toEqual({ path: "/home/user", local: true });
  });

  it("flags UNC paths on Windows without touching statfs", async () => {
    const locality = await checkFilesystemLocality("\\\\server\\share\\synloq", {
      platform: "win32",
      statfs: async () => {
        throw new Error("must not be called for UNC paths");
      },
    });
    expect(locality.local).toBe(false);
    expect(locality.fsType).toBe("unc");
  });

  it("fails soft when statfs errors: local, no warning", async () => {
    const locality = await checkFilesystemLocality("/gone", {
      platform: "linux",
      statfs: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(locality.local).toBe(true);
    expect(locality.warning).toBeUndefined();
  });
});

describe("doctor filesystem warnings (#112)", () => {
  it("reports a loud warning entry when the home sits on a network filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-fs-doctor-"));
    dirs.push(root);
    await writeFile(
      join(root, "synloq.yaml"),
      "project: verdicta\nagents:\n  cto:\n    title: CTO\n    role: Strategy\n",
      "utf8",
    );
    const home = join(root, ".synloq");

    const report = await doctorCommand({
      projectRoot: root,
      synloqHome: home,
      hostVersionProbe: async () => ({}),
      filesystemLocality: async (path) =>
        path === home
          ? {
              path,
              local: false,
              fsType: "nfs",
              warning: `${path} is on a network filesystem (nfs): SQLite WAL is not safe there — move it.`,
            }
          : { path, local: true },
    });

    expect(report.filesystemWarnings).toHaveLength(1);
    expect(report.filesystemWarnings![0]).toMatchObject({ path: home, fsType: "nfs" });
    expect(report.filesystemWarnings![0]!.warning).toContain("SQLite WAL");
  });

  it("stays silent on local filesystems", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-fs-local-"));
    dirs.push(root);
    await writeFile(
      join(root, "synloq.yaml"),
      "project: verdicta\nagents:\n  cto:\n    title: CTO\n    role: Strategy\n",
      "utf8",
    );

    const report = await doctorCommand({
      projectRoot: root,
      synloqHome: join(root, ".synloq"),
      hostVersionProbe: async () => ({}),
      filesystemLocality: async (path) => ({ path, local: true }),
    });

    expect(report.filesystemWarnings).toBeUndefined();
  });
});
