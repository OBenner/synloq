import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadManifestRetention,
  manifestUnknownFields,
  mergeManifestParticipants,
  removeManifestParticipant,
  writeManifest,
} from "../../src/config/manifest.js";

const directories: string[] = [];
const role = { project: "test", agentId: "dev", title: "Dev", role: "Build" };
async function fixture(retention = "") {
  const root = await mkdtemp(join(tmpdir(), "synloq-retention-config-"));
  directories.push(root);
  await writeFile(
    join(root, "synloq.yaml"),
    `project: test\n${retention}agents:\n  dev:\n    title: Dev\n    role: Build\n`,
  );
  return root;
}
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

it("defaults to seven days and preserves explicit retention during init/add/remove", async () => {
  expect(await loadManifestRetention(await fixture())).toEqual({ days: 7 });
  const root = await fixture("retention:\n  days: 1\n");
  await writeManifest(root, [role]);
  expect(await loadManifestRetention(root)).toEqual({ days: 1 });
  await mergeManifestParticipants(root, [{ ...role, agentId: "staff" }]);
  await removeManifestParticipant(root, "staff");
  expect(await loadManifestRetention(root)).toEqual({ days: 1 });
  expect(await manifestUnknownFields(root)).toEqual([]);
});

it.each(["0", "-1", "1.5", "36501", "null", "'7'"])(
  "rejects invalid retention.days=%s without rewriting the manifest",
  async (value) => {
    const root = await fixture(`retention:\n  days: ${value}\n`);
    const original = await readFile(join(root, "synloq.yaml"), "utf8");
    await expect(loadManifestRetention(root)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(writeManifest(root, [role])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(join(root, "synloq.yaml"), "utf8")).toBe(original);
  },
);

it("reports unknown nested retention fields without rejecting additive configuration", async () => {
  const root = await fixture("retention:\n  days: 7\n  future: true\n");
  expect(await loadManifestRetention(root)).toEqual({ days: 7 });
  expect(await manifestUnknownFields(root)).toEqual(["retention.future"]);
});
