import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "../../src/config/credentials.js";
import { writeManifest } from "../../src/config/manifest.js";
import { SynloqError } from "../../src/domain/errors.js";
import type { Participant } from "../../src/domain/message.js";
import {
  ManifestParticipantDirectory,
  StaticParticipantDirectory,
} from "../../src/relay/participant-directory.js";
import { ProtectionPolicy } from "../../src/relay/protection.js";
import { RelayService } from "../../src/relay/relay-service.js";
import { SQLiteMessageStore } from "../../src/storage/message-store.js";
import { SessionStore } from "../../src/storage/session-store.js";

// Issue #36 (T2): the participant registry is hot — adding a role to
// synloq.yaml takes effect on a running relay without a restart.

const roots: string[] = [];
const stores: { close(): void }[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function roster(project: string, ids: string[]): Participant[] {
  return ids.map((agentId) => ({
    project,
    agentId,
    title: agentId.toUpperCase(),
    role: `${agentId} role`,
  }));
}

async function projectWith(ids: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "synloq-directory-"));
  roots.push(root);
  await writeManifest(root, roster("verdicta", ids));
  return root;
}

// Windows file systems can share one mtime tick between two rapid writes;
// push the manifest mtime forward so the cache observes the change.
async function touch(root: string): Promise<void> {
  const future = new Date(Date.now() + 5_000);
  await utimes(join(root, "synloq.yaml"), future, future);
}

describe("ManifestParticipantDirectory", () => {
  it("fails fast at startup when the manifest is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-directory-"));
    roots.push(root);
    await writeFile(join(root, "synloq.yaml"), "not: [valid");
    await expect(ManifestParticipantDirectory.load(root)).rejects.toThrow(SynloqError);
  });

  it("serves a newly added role on a live relay without a restart", async () => {
    const root = await projectWith(["cto", "arch"]);
    const directory = await ManifestParticipantDirectory.load(root);
    const messages = new SQLiteMessageStore(":memory:");
    const sessions = new SessionStore(":memory:");
    stores.push(messages, sessions);
    const relay = new RelayService(directory, messages, sessions, new ProtectionPolicy(messages));
    const cto: Identity = { project: "verdicta", agentId: "cto", operator: false };

    await expect(
      relay.send(cto, { to: "qa", text: "hello", expectsReply: false, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_RECIPIENT" });

    await writeManifest(root, roster("verdicta", ["cto", "arch", "qa"]));

    // The UNKNOWN_RECIPIENT retry path re-reads the manifest once.
    const sent = await relay.send(cto, {
      to: "qa",
      text: "hello",
      expectsReply: false,
      idempotencyKey: "k1",
    });
    expect(sent.to).toBe("qa");
    // ...and the mtime cache picks the change up for plain listings too.
    expect((await directory.list("verdicta")).map((p) => p.agentId)).toContain("qa");
  });

  it("picks up manifest changes through the mtime cache", async () => {
    const root = await projectWith(["cto"]);
    const directory = await ManifestParticipantDirectory.load(root);
    expect((await directory.list("verdicta")).map((p) => p.agentId)).toEqual(["cto"]);

    await writeManifest(root, roster("verdicta", ["cto", "arch"]));
    await touch(root);

    expect(await directory.isParticipant("verdicta", "arch")).toBe(true);
  });

  it("keeps serving the last good snapshot when the manifest breaks mid-run", async () => {
    const root = await projectWith(["cto", "arch"]);
    const onDegraded = vi.fn();
    const directory = await ManifestParticipantDirectory.load(root, { onDegraded });
    const messages = new SQLiteMessageStore(":memory:");
    const sessions = new SessionStore(":memory:");
    stores.push(messages, sessions);
    const relay = new RelayService(directory, messages, sessions, new ProtectionPolicy(messages));
    const cto: Identity = { project: "verdicta", agentId: "cto", operator: false };

    await writeFile(join(root, "synloq.yaml"), "not: [valid");
    await touch(root);

    // Existing roles keep working off the last good snapshot.
    const sent = await relay.send(cto, {
      to: "arch",
      text: "still here",
      expectsReply: false,
      idempotencyKey: "k2",
    });
    expect(sent.to).toBe("arch");
    expect(onDegraded).toHaveBeenCalledTimes(1);

    // A forced re-read does not clear the snapshot either.
    expect((await directory.refresh()).map((p) => p.agentId)).toEqual(["cto", "arch"]);
    expect(onDegraded).toHaveBeenCalledTimes(1);

    // Repairing the manifest recovers the directory.
    await writeManifest(root, roster("verdicta", ["cto", "arch", "qa"]));
    await touch(root);
    expect(await directory.isParticipant("verdicta", "qa")).toBe(true);
  });

  it("shares one re-read between concurrent requests", async () => {
    const root = await projectWith(["cto"]);
    const directory = await ManifestParticipantDirectory.load(root);
    await writeManifest(root, roster("verdicta", ["cto", "arch"]));
    const [first, second] = await Promise.all([directory.refresh(), directory.refresh()]);
    expect(first.map((p) => p.agentId)).toEqual(["cto", "arch"]);
    expect(second).toBe(first);
  });
});

describe("StaticParticipantDirectory", () => {
  it("answers from the fixed list and never changes", async () => {
    const directory = new StaticParticipantDirectory(roster("verdicta", ["cto"]));
    expect(await directory.isParticipant("verdicta", "cto")).toBe(true);
    expect(await directory.isParticipant("verdicta", "arch")).toBe(false);
    expect((await directory.refresh()).map((p) => p.agentId)).toEqual(["cto"]);
  });
});
