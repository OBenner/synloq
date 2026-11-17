import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { WebhookEvent } from "../relay/webhook-nudger.js";

/** Deliberately separate from RelayHttpClient: no challenges/auth/cookies/proxy. */
export function postWebhook(
  url: URL,
  event: WebhookEvent,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("ABORTED");
      return;
    }
    const body = JSON.stringify(event);
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      request.destroy();
      resolve(outcome);
    };
    const abort = () => finish("ABORTED");
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (response) => {
        const status = response.statusCode ?? 500;
        response.destroy(); // Never follow redirects or consume receiver-controlled bodies.
        finish(`HTTP_${status}`);
      },
    );
    request.on("error", () => finish("NETWORK_ERROR"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);
    request.end(body);
  });
}
