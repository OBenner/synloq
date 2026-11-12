import { ensureRelay, type EnsureRelayOptions, type RelaySupervisorHandle } from "./supervisor.js";
import type { RelayHttpClient } from "../transport/http-client.js";

export interface StartRelaySupervisorOptions extends EnsureRelayOptions {
  retryDelayMs?: number;
  monitorIntervalMs?: number;
  maxReconnectAttempts?: number;
  onOwnerLost?: () => void | Promise<void>;
  onRecovered?: () => void | Promise<void>;
  onDiagnostic?: (message: string) => void;
  ensure?: typeof ensureRelay;
}

export interface RelaySupervisorLoop {
  readonly client: RelayHttpClient;
  readonly owned: boolean;
  close(): Promise<void>;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

class Supervisor implements RelaySupervisorLoop {
  readonly client: RelayHttpClient;
  private readonly abort = new AbortController();
  private readonly task: Promise<void>;
  private current: RelaySupervisorHandle | undefined;
  private recovery: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private unavailable = false;

  constructor(
    initial: RelaySupervisorHandle,
    private readonly options: StartRelaySupervisorOptions,
  ) {
    this.current = initial;
    this.client = initial.client;
    this.task = this.monitor();
  }

  get owned(): boolean {
    return !this.closed && this.current?.owned === true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abort.abort();
    this.closePromise = (async () => {
      await this.task;
      await this.recovery;
      const current = this.current;
      this.current = undefined;
      await current?.close();
    })();
    return this.closePromise;
  }

  private async monitor(): Promise<void> {
    while (!this.abort.signal.aborted && !this.unavailable) {
      await sleep(this.options.monitorIntervalMs ?? 1_000, this.abort.signal);
      if (this.abort.signal.aborted || this.unavailable) return;
      try {
        const probeTimeoutMs = this.options.probeTimeoutMs ?? 750;
        await this.client.health(probeTimeoutMs);
        await this.client.listParticipants(probeTimeoutMs);
      } catch {
        await this.recover();
      }
    }
  }

  private async recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.elect().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async elect(): Promise<void> {
    if (this.abort.signal.aborted) return;
    try {
      await this.options.onOwnerLost?.();
    } catch {
      this.options.onDiagnostic?.("Synloq host invalidation failed before relay recovery");
    }
    const previous = this.current;
    this.current = undefined;
    await previous?.close();

    const ensure = this.options.ensure ?? ensureRelay;
    const attempts = Math.max(1, Math.floor(this.options.maxReconnectAttempts ?? 8));
    const initialDelay = Math.max(0, this.options.retryDelayMs ?? 200);
    for (let attempt = 1; attempt <= attempts && !this.abort.signal.aborted; attempt += 1) {
      try {
        const next = await ensure(this.options);
        if (this.abort.signal.aborted) {
          await next.close();
          return;
        }
        this.current = next;
        try {
          await this.options.onRecovered?.();
        } catch {
          this.options.onDiagnostic?.("Synloq host restart failed after relay recovery");
        }
        return;
      } catch {
        if (attempt === attempts) {
          this.unavailable = true;
          this.options.onDiagnostic?.(
            "Synloq relay recovery exhausted; endpoint remains unavailable",
          );
          return;
        }
        await sleep(Math.min(5_000, initialDelay * 2 ** (attempt - 1)), this.abort.signal);
      }
    }
  }
}

export async function startRelaySupervisor(
  options: StartRelaySupervisorOptions,
): Promise<RelaySupervisorLoop> {
  const initial = await (options.ensure ?? ensureRelay)(options);
  return new Supervisor(initial, options);
}
