import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestRoles, loadManifestWebhooks } from "../../src/config/manifest.js";
import { webhookEndpoint } from "../../src/config/webhooks.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(overlay = "", shared = "") {
  const root = await mkdtemp(join(tmpdir(), "synloq-webhook-config-"));
  roots.push(root);
  await writeFile(
    join(root, "synloq.yaml"),
    `project: test\nagents: {arch: {title: Architect, role: Review}}\n${shared}`,
  );
  if (overlay) await writeFile(join(root, "synloq.local.yaml"), overlay);
  return root;
}

describe("local-only webhook configuration", () => {
  it("is disabled by default and only accepts explicit local opt-in", async () => {
    expect(await loadManifestWebhooks(await fixture())).toBeUndefined();
    const root = await fixture("webhooks: {enabled: true, url: 'http://127.0.0.1:9911/events'}");
    expect(await loadManifestWebhooks(root)).toEqual({
      enabled: true,
      url: "http://127.0.0.1:9911/events",
    });
    expect(await loadManifestRoles(root)).toHaveLength(1);
  });
  it.each(["webhooks: {}", "webhooks: {enabled: false}", "webhooks: null"])(
    "rejects shared manifest external effects: %s",
    async (shared) => {
      await expect(loadManifestRoles(await fixture("", shared))).rejects.toThrow(/manifest/);
    },
  );
  it.each(["token: secret", "allowRemote: true", "events: [startup]"])(
    "rejects unsupported/secret config without leaking values: %s",
    async (extra) => {
      const root = await fixture(
        `webhooks: {enabled: true, url: 'http://127.0.0.1:9911/events', ${extra}}`,
      );
      await expect(loadManifestWebhooks(root)).rejects.toThrow("overlay schema");
      await expect(loadManifestWebhooks(root)).rejects.not.toThrow("secret");
    },
  );
  it.each([
    "http://localhost:9911/",
    "http://example.com:9911/",
    "http://169.254.169.254:80/",
    "http://100.64.0.1:9911/",
    "http://10.0.0.1:9911/",
    "http://[fe80::1]:9911/",
    "http://[::ffff:169.254.169.254]:9911/",
    "http://127.0.0.1/",
    "http://127.0.0.1:0/",
    "http://user:secret@127.0.0.1:9911/",
    "http://127.0.0.1:9911/?secret=1",
    "http://127.0.0.1:9911/#secret",
    "file:///tmp/file",
    "http://127.0.0.1:9911/" + "a".repeat(129),
  ])("blocks unsafe endpoint %s", (url) => {
    expect(() => webhookEndpoint(url)).toThrow("Webhook endpoint is invalid");
  });
  it("accepts literal loopback HTTP/HTTPS and rejects its own relay port", () => {
    expect(webhookEndpoint("https://127.0.0.2:9443/events").hostname).toBe("127.0.0.2");
    expect(webhookEndpoint("http://[::1]:9911/events").hostname).toBe("[::1]");
    expect(() => webhookEndpoint("http://127.0.0.2:9911/", 9911)).toThrow(
      "Webhook endpoint is invalid",
    );
  });
});
