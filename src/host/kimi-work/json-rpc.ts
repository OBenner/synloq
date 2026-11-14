import WebSocket from "ws";
import type { ZodType } from "zod";
import type { KimiWorkControlEndpoint } from "./control-status.js";

export class KimiWorkRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    readonly reasonCode?: string,
  ) {
    super(`Kimi Work RPC failed with code ${rpcCode}`);
    this.name = "KimiWorkRpcError";
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface KimiWorkJsonRpcOptions {
  timeoutMs?: number;
}

export class KimiWorkJsonRpcConnection {
  private readonly socket: WebSocket;
  private readonly opened: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private nextId = 1;
  private closed = false;

  constructor(endpoint: KimiWorkControlEndpoint, options: KimiWorkJsonRpcOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.socket = new WebSocket(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      // Visible-chat histories carry full turn payloads (prompts, tool output);
      // the last-50-messages frame of an active role exceeds 1 MiB in practice
      // (observed 1.1-2.5 MiB on 2026-11-14: the ws library dropped the
      // connection mid-delivery and visible delivery stalled for that role).
      maxPayload: 64 * 1_048_576,
    });
    let markOpen!: () => void;
    let failOpen!: (error: Error) => void;
    this.opened = new Promise<void>((resolve, reject) => {
      markOpen = resolve;
      failOpen = reject;
    });
    this.opened.catch(() => undefined);
    this.socket.once("open", markOpen);
    this.socket.on("message", (data) => this.receive(String(data)));
    this.socket.on("error", () => {
      const error = new Error("Kimi Work RPC connection failed");
      failOpen(error);
      this.rejectAll(error);
    });
    this.socket.on("close", () => {
      const error = new Error("Kimi Work RPC connection closed");
      failOpen(error);
      this.rejectAll(error);
    });
  }

  async request<T>(
    method: string,
    params: object,
    schema: ZodType<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) throw new Error("Kimi Work RPC connection closed");
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    await this.opened;
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const signal = options.signal;
      let aborted: (() => void) | undefined;

      const complete = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal && aborted) signal.removeEventListener("abort", aborted);
        callback();
      };

      const request: PendingRequest = {
        resolve: (value) => {
          try {
            const parsed = schema.parse(value);
            complete(() => resolve(parsed));
          } catch {
            complete(() => reject(new Error("Kimi Work RPC response is invalid")));
          }
        },
        reject: (error) => complete(() => reject(error)),
      };

      this.pending.set(id, request);
      timer = setTimeout(
        () => request.reject(new Error("Kimi Work RPC timed out")),
        this.timeoutMs,
      );

      if (signal) {
        aborted = () => request.reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      }

      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (error) request.reject(new Error("Kimi Work RPC send failed"));
      });
    });
  }

  private receive(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.rejectAll(new Error("Kimi Work RPC response is invalid"));
      return;
    }
    if (typeof frame !== "object" || frame === null || !("id" in frame)) return;
    const id = (frame as { id?: unknown }).id;
    if (typeof id !== "number") {
      this.rejectAll(new Error("Kimi Work RPC response is invalid"));
      return;
    }
    const request = this.pending.get(id);
    if (!request) return;
    if ("error" in frame) {
      const remote = (frame as { error?: { code?: unknown; data?: { reasonCode?: unknown } } })
        .error;
      const reason = remote?.data?.reasonCode;
      request.reject(
        new KimiWorkRpcError(
          typeof remote?.code === "number" ? remote.code : -32603,
          typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : undefined,
        ),
      );
      return;
    }
    request.resolve((frame as { result?: unknown }).result);
  }

  private rejectAll(error: Error): void {
    for (const request of [...this.pending.values()]) request.reject(error);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Kimi Work RPC connection closed"));
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}
