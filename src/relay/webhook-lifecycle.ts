import { writeJsonAtomic } from "../config/atomic-file.js";
import type { ProjectPaths } from "../config/paths.js";
import { webhookStatusPath } from "../config/webhook-status.js";
import { webhookEndpoint, type WebhookConfig } from "../config/webhooks.js";
import type { SQLiteMessageStore } from "../storage/message-store.js";
import { postWebhook } from "../transport/webhook-http.js";
import type { SecurityAuditLog } from "./audit-log.js";
import type { MessageObserver } from "./relay-service.js";
import { WebhookNudger } from "./webhook-nudger.js";

export function startWebhook(options: {
  config: WebhookConfig;
  project: string;
  relayPort: number;
  messages: SQLiteMessageStore;
  paths: ProjectPaths;
  audit: SecurityAuditLog;
}): { observer: MessageObserver; close(): Promise<void> } {
  const endpoint = webhookEndpoint(options.config.url!, options.relayPort);
  const worker = new WebhookNudger({
    project: options.project,
    audit: options.audit,
    send: (event, signal, timeout) => postWebhook(endpoint, event, signal, timeout),
  });
  let writing: Promise<void> | undefined;
  // Fixed-size snapshot replaces itself at most once per ten seconds, rather than
  // appending one log record per drop. Slow disk never creates a write backlog.
  const flush = () => {
    writing ??= writeJsonAtomic(webhookStatusPath(options.paths), worker.snapshot())
      .catch(() => {
        /* Diagnostics are best effort. */
      })
      .finally(() => {
        writing = undefined;
      });
    return writing;
  };
  void flush();
  const timer = setInterval(() => {
    void flush();
  }, 10_000);
  timer.unref();
  let closed = false;
  return {
    observer: {
      created: (message) => {
        // Count after commit: a sole new message means the previous backlog was
        // empty, even if it was emptied by retention while no observer ran.
        if (options.messages.countUnacknowledged(message.project, message.to) === 1)
          worker.backlogEmpty(message.project, message.to);
        worker.created(message);
      },
      acknowledged: (message) => {
        if (options.messages.countUnacknowledged(message.project, message.to) === 0)
          worker.backlogEmpty(message.project, message.to);
      },
    },
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await worker.stop();
      await writing;
      await flush();
    },
  };
}
