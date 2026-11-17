import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { serveCommand } from "../../src/cli/commands.js";
import { CredentialStore } from "../../src/config/credentials.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import * as claude from "../../src/relay/claude-nudger-lifecycle.js";
import * as webhook from "../../src/relay/webhook-lifecycle.js";

it.each([false, true])(
  "composes webhook and Claude hints, ACK and shutdown (webhook throws: %s)",
  async (throws) => {
    const root = await mkdtemp(join(tmpdir(), "synloq-nudger-composition-"));
    const home = join(root, "home");
    const created = vi.fn(() => {
      if (throws) throw new Error("webhook observation failed");
    });
    const acknowledged = vi.fn(),
      notify = vi.fn();
    const closeWebhook = vi.fn(async () => {}),
      stopClaude = vi.fn(async () => {});
    const webhookStart = vi
      .spyOn(webhook, "startWebhook")
      .mockReturnValue({ observer: { created, acknowledged }, close: closeWebhook });
    const claudeStart = vi
      .spyOn(claude, "startClaudeNudger")
      .mockResolvedValue({ notify, stop: stopClaude });
    let handle: Awaited<ReturnType<typeof serveCommand>> | undefined;
    try {
      await writeFile(
        join(root, "synloq.yaml"),
        "project: test\nagents: {cto: {title: CTO, role: Send}, arch: {title: Arch, role: Read}}\n",
      );
      await writeFile(
        join(root, "synloq.local.yaml"),
        "webhooks: {enabled: true, url: 'http://127.0.0.1:12345/events'}\n",
      );
      handle = await serveCommand({ projectRoot: root, synloqHome: home });
      const credentials = new CredentialStore(root, home);
      const ctoToken = await credentials.issue("test", "cto"),
        archToken = await credentials.issue("test", "arch");
      const cto = new RelayHttpClient(handle.baseUrl, () => ctoToken, {
        project: "test",
        agentId: "cto",
      });
      const arch = new RelayHttpClient(handle.baseUrl, () => archToken, {
        project: "test",
        agentId: "arch",
      });
      const input = { to: "arch", text: "fixture", expectsReply: false, idempotencyKey: "one" };
      const first = await cto.send(input);
      expect(first.message.deliveryState).toBe("stored");
      expect(created).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledExactlyOnceWith("arch");
      await cto.send(input);
      expect(created).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      await arch.acknowledge(first.message.id);
      expect(acknowledged).toHaveBeenCalledTimes(1);
      expect(handle.messages.countUnacknowledged("test", "arch")).toBe(0);
      await handle.close();
      expect(closeWebhook).toHaveBeenCalledTimes(1);
      expect(stopClaude).toHaveBeenCalledTimes(1);
    } finally {
      await handle?.close();
      webhookStart.mockRestore();
      claudeStart.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
