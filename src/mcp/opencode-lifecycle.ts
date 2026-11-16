import { HttpAdapterRunner, OutstandingTracker } from "../adapters/http-runner.js";
import { runOpenCodeAdapter, type OpenCodeAdapter } from "../adapters/opencode.js";
import { loadManifest } from "../config/manifest.js";
import { formatDiagnostic } from "../diagnostics.js";
import { SynloqError } from "../domain/errors.js";
import type { ResolvedOpenCodeBinding } from "../host/opencode/binding.js";
import { discoverOpenCodeHost } from "../host/opencode/discovery.js";
import type { RelayHttpClient } from "../transport/http-client.js";

export interface OpenCodeMcpBridge {
  runner: Pick<HttpAdapterRunner, "start" | "close"> & {
    onUnauthorized?: HttpAdapterRunner["onUnauthorized"];
  };
  adapter: Pick<OpenCodeAdapter, "close" | "ping">;
}

export interface OpenCodeFactoryOptions {
  binding: ResolvedOpenCodeBinding;
  relay: RelayHttpClient;
  token: string;
  /** Every token this channel has served (rotation history) — for masking. */
  knownTokens?: () => string[];
  signal: AbortSignal;
  onUnauthorized: (error: SynloqError) => void;
  outstanding: OutstandingTracker;
  diagnostics: { write(chunk: string): unknown };
}

export type OpenCodeFactory = (options: OpenCodeFactoryOptions) => Promise<OpenCodeMcpBridge>;

export async function defaultOpenCodeFactory(
  options: OpenCodeFactoryOptions,
): Promise<OpenCodeMcpBridge> {
  const { sessionId } = options.binding;
  if (!sessionId)
    throw new SynloqError("INVALID_INPUT", "OpenCode session binding is missing; run init");
  const participants = await loadManifest(options.binding.workspacePath);
  const project = participants[0]?.project;
  if (!project) throw new SynloqError("INVALID_INPUT", "Synloq manifest has no project");
  const endpoint = await discoverOpenCodeHost();
  options.signal.throwIfAborted();
  const adapter = await runOpenCodeAdapter(
    {
      project,
      agentId: options.binding.agentId,
      sessionId,
      baseUrl: endpoint.baseUrl,
      ...(endpoint.authToken ? { authToken: endpoint.authToken } : {}),
      ownership: "exclusive",
    },
    options.relay,
    undefined,
    options.onUnauthorized,
  );
  return {
    adapter,
    runner: new HttpAdapterRunner(
      options.relay,
      adapter,
      adapter.sessionBinding,
      undefined,
      undefined,
      options.outstanding,
      {
        output: options.diagnostics,
        secrets: [...(options.knownTokens?.() ?? [options.token]), endpoint.authToken ?? ""],
      },
    ),
  };
}

export interface OpenCodeLifecycleOptions {
  openCodeFactory?: OpenCodeFactory;
  openCodeStartupAttempts?: number;
  openCodeRetryDelayMs?: number;
  stderr?: { write(chunk: string): unknown };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A transport owned by this MCP child, never a second role writer. */
export function createOpenCodeLifecycle(
  binding: ResolvedOpenCodeBinding,
  relay: RelayHttpClient,
  token: string,
  options: OpenCodeLifecycleOptions,
  knownTokens?: () => string[],
) {
  const factory = options.openCodeFactory ?? defaultOpenCodeFactory;
  const output = options.stderr ?? process.stderr;
  const attempts = Math.max(1, Math.min(10, Math.floor(options.openCodeStartupAttempts ?? 5)));
  const retryDelay = Math.max(0, options.openCodeRetryDelayMs ?? 200);
  const outstanding = new OutstandingTracker();
  let bridge: OpenCodeMcpBridge | undefined;
  let startup: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let stopped = false;
  let blocked = false;
  let closePromise: Promise<void> | undefined;
  let cleanup = Promise.resolve();

  const diagnostic = (message: string) => {
    try {
      // Mask every token this channel has ever served (rotation history).
      let masked = message;
      for (const known of knownTokens?.() ?? (token === "" ? [] : [token])) {
        if (known !== "") masked = masked.split(known).join("[redacted]");
      }
      output.write(`${formatDiagnostic(`Synloq OpenCode ${binding.agentId}: ${masked}`)}\n`);
    } catch {
      /* Diagnostics must not take down MCP tools. */
    }
  };
  const closeBridge = async (value: OpenCodeMcpBridge | undefined) => {
    if (!value) return;
    try {
      try {
        await value.runner.close();
      } finally {
        await value.adapter.close();
      }
    } catch {
      diagnostic("delivery cleanup failed; the generation-fenced lease will expire");
    }
  };
  const unauthorized = (error: SynloqError) => {
    if (blocked || stopped) return;
    blocked = true;
    abort?.abort();
    // No re-registration after takeover, including same-session generation changes.
    diagnostic(
      `${error.code}: delivery ownership lost; sidecar stopped. Use explicit replace-session and restart the MCP child; no automatic takeover`,
    );
    const current = bridge;
    bridge = undefined;
    cleanup = closeBridge(current);
  };
  const start = () => {
    if (stopped || blocked || bridge || startup) return;
    if (!binding.sessionId) {
      blocked = true;
      diagnostic("visible delivery unavailable: missing session binding; run init");
      return;
    }
    const controller = new AbortController();
    abort = controller;
    const task = (async () => {
      for (let attempt = 1; attempt <= attempts && !controller.signal.aborted; attempt++) {
        let created: OpenCodeMcpBridge | undefined;
        try {
          created = await factory({
            binding,
            relay,
            token,
            ...(knownTokens ? { knownTokens } : {}),
            signal: controller.signal,
            onUnauthorized: unauthorized,
            outstanding,
            diagnostics: output,
          });
          if (controller.signal.aborted || stopped || blocked) {
            await closeBridge(created);
            return;
          }
          bridge = created;
          created.runner.onUnauthorized = unauthorized;
          created.runner.start();
          diagnostic("delivery sidecar started after exclusive registration");
          return;
        } catch (error) {
          bridge = undefined;
          await closeBridge(created);
          if (controller.signal.aborted || stopped) return;
          const code = error instanceof SynloqError ? error.code : "UNAVAILABLE";
          // Deliberately omit raw host error text: it can include service credentials.
          diagnostic(`startup attempt ${attempt}/${attempts} failed (${code})`);
          if (code === "DUPLICATE_SESSION" || code === "UNAUTHORIZED" || code === "NOT_WRITER") {
            blocked = true;
            diagnostic(
              "delivery blocked by existing owner; MCP tools remain available. Manual sidecar has priority; use explicit replace-session for takeover",
            );
            return;
          }
          if (attempt < attempts)
            await sleep(Math.min(30_000, retryDelay * 2 ** (attempt - 1)), controller.signal);
        }
      }
      if (!controller.signal.aborted)
        diagnostic(
          "visible delivery unavailable after bounded startup retries; restart the MCP child after resolving the failure",
        );
    })();
    startup = task;
    void task.finally(() => {
      if (startup === task) startup = undefined;
    });
  };
  const stop = async () => {
    abort?.abort();
    const current = bridge;
    bridge = undefined;
    await closeBridge(current);
    await startup;
    await cleanup;
  };
  return {
    start,
    stop,
    ping: (text: string) => bridge?.adapter.ping(text) ?? Promise.resolve(false),
    close: () => {
      if (!closePromise) {
        stopped = true;
        closePromise = stop();
      }
      return closePromise;
    },
  };
}
