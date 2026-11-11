import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface CodexRpcOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcCode?: number,
    readonly remoteDetail?: string,
  ) {
    super(rpcCode === undefined ? `${method} failed` : `${method} failed with JSON-RPC ${rpcCode}`);
    this.name = "CodexRpcError";
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: CodexRpcError) => void;
  timeout: NodeJS.Timeout;
}

export class CodexJsonRpcConnection {
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  private failure: CodexRpcError | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: CodexRpcOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 1_048_576;
    this.child.stdout.on("data", this.onStdoutData);
    this.child.stderr.on("data", this.onStderrData);
    this.child.on("exit", this.onProcessExit);
    this.child.on("error", this.onProcessError);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure !== undefined || this.closePromise !== undefined) {
      return Promise.reject(this.failure ?? new CodexRpcError("connection closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new CodexRpcError(`${method} write`));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure !== undefined || this.closePromise !== undefined) {
      throw this.failure ?? new CodexRpcError("connection closed");
    }
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private write(frame: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private readonly onStdoutData = (chunk: Buffer | string): void => {
    if (this.failure !== undefined || this.closePromise !== undefined) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferBytes) {
      this.buffer = "";
      this.failAll(new CodexRpcError("stdout buffer exceeded"));
      return;
    }

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") this.handleLine(line);
      if (this.failure !== undefined) return;
      newline = this.buffer.indexOf("\n");
    }
  };

  private readonly onStderrData = (chunk: Buffer | string): void => {
    this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-16_384);
  };

  private readonly onProcessExit = (): void => {
    this.failAll(new CodexRpcError("Codex app-server exited"));
  };

  private readonly onProcessError = (): void => {
    this.failAll(new CodexRpcError("Codex app-server process"));
  };

  private handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.failAll(new CodexRpcError("malformed JSON"));
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    if (Reflect.get(frame, "method") !== undefined) return;
    const id = Reflect.get(frame, "id");
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);

    const rpcError = Reflect.get(frame, "error");
    if (rpcError !== undefined) {
      let code: number | undefined;
      let detail: string | undefined;
      if (typeof rpcError === "object" && rpcError !== null && !Array.isArray(rpcError)) {
        const candidateCode = Reflect.get(rpcError, "code");
        if (typeof candidateCode === "number" && Number.isFinite(candidateCode)) {
          code = candidateCode;
        }
        const candidateDetail = Reflect.get(rpcError, "message");
        if (typeof candidateDetail === "string") detail = candidateDetail.slice(0, 1_024);
      }
      pending.reject(new CodexRpcError(pending.method, code, detail));
      return;
    }
    pending.resolve(Reflect.get(frame, "result"));
  }

  private failAll(error: CodexRpcError): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  private terminate(signal: NodeJS.Signals): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let finished = false;
      const finish = (exited: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.child.off("exit", onExit);
        this.child.off("error", onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.child.once("exit", onExit);
      this.child.once("error", onError);
      try {
        const signalled = this.child.kill(signal);
        if (!signalled && (this.child.exitCode !== null || this.child.signalCode !== null)) {
          finish(true);
        }
      } catch {
        finish(false);
      }
    });
  }

  private async performClose(): Promise<void> {
    let exited = await this.terminate("SIGTERM");
    if (!exited) exited = await this.terminate("SIGKILL");
    this.failAll(new CodexRpcError("connection closed"));
    this.child.stdout.off("data", this.onStdoutData);
    this.child.stderr.off("data", this.onStderrData);
    this.child.off("exit", this.onProcessExit);
    this.child.off("error", this.onProcessError);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (!exited) throw new CodexRpcError("Codex app-server cleanup");
  }
}
