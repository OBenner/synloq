import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type SessionBinding,
  type SessionState,
} from "../domain/session.js";
import type { RelayHttpClient } from "../transport/http-client.js";
import { isLoopbackHttpUrl } from "../transport/loopback.js";
import { frameMessage } from "./reference.js";
import type {
  Clock,
  DeliveryAdapter,
  DeliveryReceipt,
  DeliverySubmissionContext,
} from "./types.js";

const INITIAL_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const STATE_FRESHNESS_MS = 5_000;

export interface OpenCodeAdapterConfig {
  project: string;
  agentId: string;
  sessionId: string;
  heartbeatIntervalMs?: number;
}

export interface OpenCodeRunConfig extends OpenCodeAdapterConfig {
  baseUrl: string;
  authToken?: string;
}

// The desktop service authenticates with HTTP Basic (username "opencode").
// Inject the header through a fetch wrapper so streamed endpoints (SSE) are
// covered too, not just request/response calls.
export function openCodeBasicAuthFetch(
  password: string,
  inner: (request: Request) => ReturnType<typeof fetch> = (request) => fetch(request),
): typeof fetch {
  const header = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", header);
    return inner(new Request(request, { headers }));
  };
  return wrapped as typeof fetch;
}

/**
 * Session liveness derived from the session record's time markers: the host
 * stamps `time.busy` when a turn starts and `time.idle` when it ends, so
 * busy > idle means a turn is currently running. Verified live against the
 * OpenCode desktop service 2.2.7 (#31).
 */
export interface OpenCodeSessionSnapshot {
  exists: boolean;
  busy: boolean;
}

/** Admission record as returned by the desktop service on POST prompt. */
export interface OpenCodeAdmission {
  id: string;
  sessionID: string;
  text?: string;
  delivery?: string;
}

/**
 * Minimal transport surface the adapter needs from an OpenCode host. The
 * default implementation targets the desktop service API (`/api/*`); tests
 * inject fakes.
 */
export interface OpenCodeApi {
  getSession(sessionId: string, signal?: AbortSignal): Promise<OpenCodeSessionSnapshot>;
  admit(sessionId: string, text: string, signal?: AbortSignal): Promise<OpenCodeAdmission>;
  subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<unknown>>;
}

function unavailable(): SynloqError {
  return new SynloqError("NOT_FOUND", "OpenCode service is unavailable");
}

function invalidResponse(detail: string): SynloqError {
  return new SynloqError("INVALID_INPUT", `OpenCode service response is invalid: ${detail}`);
}

// The desktop API wraps payloads in an envelope: {"data": ...}. Tolerate a
// bare payload too, for forwards compatibility.
function unwrap(json: unknown): unknown {
  if (typeof json === "object" && json !== null && "data" in json) {
    return (json as { data: unknown }).data;
  }
  return json;
}

function readTimeMarkers(payload: unknown): { busy: number; idle: number } {
  if (typeof payload !== "object" || payload === null) throw invalidResponse("not an object");
  const time = (payload as { time?: unknown }).time;
  if (typeof time !== "object" || time === null) throw invalidResponse("missing time markers");
  const { busy, idle } = time as { busy?: unknown; idle?: unknown };
  return {
    busy: typeof busy === "number" && Number.isFinite(busy) ? busy : 0,
    idle: typeof idle === "number" && Number.isFinite(idle) ? idle : 0,
  };
}

function readAdmission(payload: unknown): OpenCodeAdmission {
  if (typeof payload !== "object" || payload === null) throw invalidResponse("not an object");
  const record = payload as {
    id?: unknown;
    sessionID?: unknown;
    payload?: unknown;
    prompt?: unknown;
    delivery?: unknown;
  };
  if (typeof record.id !== "string" || typeof record.sessionID !== "string") {
    throw invalidResponse("missing admission id or sessionID");
  }
  // The desktop wire echoes the admitted text under payload.text; the SDK
  // types describe prompt.text. Accept both, prefer the observed wire shape.
  const textOf = (bag: unknown): unknown =>
    typeof bag === "object" && bag !== null ? (bag as { text?: unknown }).text : undefined;
  const text = textOf(record.payload) ?? textOf(record.prompt);
  return {
    id: record.id,
    sessionID: record.sessionID,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof record.delivery === "string" ? { delivery: record.delivery } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse("not JSON");
  }
}

async function* streamServerEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length === 0) continue;
        try {
          yield JSON.parse(data) as unknown;
        } catch {
          // Keep the stream alive on a malformed event; the next events and
          // the periodic status refresh keep the observed state truthful.
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * Default OpenCode API client, written against the desktop service wire
 * contract verified live on 2.2.7 (#31): endpoints live under `/api`,
 * responses are enveloped in {"data": ...}, the prompt body is flat
 * (`{text, delivery, resume}`), and SSE events carry their payload in `data`.
 */
export function createOpenCodeApi(
  baseUrl: string,
  options: { fetch?: typeof fetch } = {},
): OpenCodeApi {
  if (!isLoopbackHttpUrl(baseUrl)) {
    throw new SynloqError(
      "INVALID_INPUT",
      "OpenCode service URL must be an explicit loopback origin",
    );
  }
  const base = baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw unavailable();
    }
    return { status: response.status, json: await readJson(response) };
  };

  return {
    async getSession(sessionId, signal) {
      const result = await request(
        "GET",
        `/api/session/${encodeURIComponent(sessionId)}`,
        undefined,
        signal,
      );
      if (result.status === 404) return { exists: false, busy: false };
      if (result.status === 401 || result.status === 403) {
        throw new SynloqError(
          "INVALID_INPUT",
          "OpenCode service rejected the request as unauthorized (service password missing or wrong)",
        );
      }
      if (result.status >= 500) throw unavailable();
      if (result.status !== 200) {
        throw new SynloqError(
          "INVALID_INPUT",
          `OpenCode session lookup failed with status ${result.status}`,
        );
      }
      const markers = readTimeMarkers(unwrap(result.json));
      return { exists: true, busy: markers.busy > markers.idle };
    },

    async admit(sessionId, text, signal) {
      const result = await request(
        "POST",
        `/api/session/${encodeURIComponent(sessionId)}/prompt`,
        // queue never interrupts a running turn; resume schedules execution,
        // otherwise the admission would sit in the session inbox forever.
        { text, delivery: "queue", resume: true },
        signal,
      );
      if (result.status === 401 || result.status === 403) {
        throw new SynloqError(
          "INVALID_INPUT",
          "OpenCode service rejected the request as unauthorized (service password missing or wrong)",
        );
      }
      if (result.status >= 500) throw unavailable();
      if (result.status < 200 || result.status >= 300) {
        throw new SynloqError(
          "INVALID_INPUT",
          `OpenCode prompt failed with status ${result.status}`,
        );
      }
      return readAdmission(unwrap(result.json));
    },

    async subscribeEvents(signal) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/api/event`, {
          method: "GET",
          headers: { accept: "text/event-stream" },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw unavailable();
      }
      if (!response.ok || response.body === null) {
        throw new SynloqError(
          "INVALID_INPUT",
          `OpenCode event subscription failed with status ${response.status}`,
        );
      }
      return streamServerEvents(response.body, signal);
    },
  };
}

function backoffDelay(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
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

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("aborted", "AbortError"));
  });
  signal.addEventListener("abort", abort);
  return Promise.race([operation, aborted]).finally(() => {
    signal.removeEventListener("abort", abort);
  });
}

function eventBags(event: unknown): Array<Record<string, unknown>> {
  if (typeof event !== "object" || event === null) return [];
  const record = event as { data?: unknown; properties?: unknown };
  const bags: Array<Record<string, unknown>> = [];
  for (const bag of [record.data, record.properties]) {
    if (typeof bag === "object" && bag !== null) bags.push(bag as Record<string, unknown>);
  }
  return bags;
}

// Event payloads arrive under `data` on the desktop wire; the SDK types call
// the same bag `properties`. Read both.
function eventSessionId(event: unknown): string | undefined {
  for (const bag of eventBags(event)) {
    if (typeof bag.sessionID === "string") return bag.sessionID;
    const info = bag.info;
    if (typeof info === "object" && info !== null) {
      const id = (info as { id?: unknown }).id;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

function eventType(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function eventStatusType(event: unknown): string | undefined {
  for (const bag of eventBags(event)) {
    const status = bag.status;
    if (typeof status === "object" && status !== null) {
      const type = (status as { type?: unknown }).type;
      if (typeof type === "string") return type;
    }
  }
  return undefined;
}

export class OpenCodeAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities;

  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly uncertainMessages = new Set<string>();
  private observedState: SessionState = "unknown";
  private observedAt = Number.NaN;
  private abortController: AbortController | undefined;
  private heartbeatTask: Promise<void> | undefined;
  private eventTask: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private reportQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly api: OpenCodeApi,
    private readonly relay: RelayHttpClient,
    private readonly config: OpenCodeAdapterConfig,
    capabilities: AdapterCapabilities = {
      activeDelivery: true,
      stateReporting: true,
      clientIdempotency: true,
    },
    private readonly clock: Clock = { now: () => Date.now() },
  ) {
    this.capabilities = { ...capabilities };
  }

  start(): void {
    if (this.closed || this.abortController) return;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.heartbeatTask = this.heartbeatLoop(signal);
    this.eventTask = this.eventLoop(signal);
  }

  async state(sessionId: string): Promise<SessionState> {
    if (sessionId !== this.config.sessionId) return "unknown";
    return this.currentState();
  }

  private currentState(): SessionState {
    if (this.closed) return "closed";
    if (
      this.observedState === "idle" &&
      (!Number.isFinite(this.observedAt) || this.clock.now() - this.observedAt > STATE_FRESHNESS_MS)
    ) {
      return "unknown";
    }
    return this.observedState;
  }

  private currentReportedState(): SessionState {
    if (this.closed) return "closed";
    return this.observedState;
  }

  async submit(
    sessionId: string,
    message: Message,
    context?: DeliverySubmissionContext,
  ): Promise<DeliveryReceipt> {
    const original = this.receipts.get(message.id);
    if (original) return original;
    if (sessionId !== this.config.sessionId) {
      throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
    }
    if (this.uncertainMessages.has(message.id)) throw this.deliveryUncertain(message.id);
    if (this.closed) {
      throw new SynloqError("INVALID_INPUT", "OpenCode adapter is closed");
    }
    if (this.currentState() === "closed") {
      throw new SynloqError("INVALID_INPUT", "visible session is closed");
    }
    if (this.currentState() !== "idle") {
      // The event stream is the primary state source, but a quiet idle
      // session emits no events — verify the markers on demand instead of
      // stalling the delivery forever (#31 live evidence).
      await this.refreshStatus(context?.signal);
      if (this.currentState() !== "idle") {
        throw new SynloqError("INVALID_INPUT", "visible session is not idle");
      }
    }

    try {
      const admission = this.api.admit(sessionId, frameMessage(message), context?.signal);
      const admitted = context?.signal
        ? await raceWithAbort(admission, context.signal)
        : await admission;
      if (!this.isMatchingAdmission(admitted, sessionId, message)) {
        throw this.deliveryUncertain(message.id);
      }
      const receipt: DeliveryReceipt = {
        state: "delivered",
        clientMessageId: admitted.id,
      };
      this.receipts.set(message.id, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof SynloqError && error.code !== "DELIVERY_UNCERTAIN") throw error;
      throw this.deliveryUncertain(message.id);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.observedState = "closed";
    this.abortController?.abort();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private isMatchingAdmission(
    admitted: OpenCodeAdmission,
    sessionId: string,
    message: Message,
  ): boolean {
    return (
      admitted.id.trim() !== "" &&
      admitted.sessionID === sessionId &&
      admitted.text === frameMessage(message) &&
      admitted.delivery === "queue"
    );
  }

  private deliveryUncertain(messageId: string): SynloqError {
    this.uncertainMessages.add(messageId);
    this.capabilities.clientIdempotency = false;
    return new SynloqError(
      "DELIVERY_UNCERTAIN",
      `OpenCode admission for ${messageId} is uncertain; operator inspection is required before retry`,
    );
  }

  private report(state: SessionState): Promise<void> {
    const request = this.reportQueue.then(async () => {
      await this.relay.heartbeat({ sessionId: this.config.sessionId, state });
    });
    this.reportQueue = request.catch(() => undefined);
    return request;
  }

  private async observe(state: SessionState): Promise<void> {
    if (this.closed) return;
    this.observedState = state;
    this.observedAt = this.clock.now();
    try {
      await this.report(state);
    } catch {
      // The heartbeat loop retries relay failures with bounded backoff.
    }
  }

  private async refreshStatus(signal?: AbortSignal): Promise<boolean> {
    const snapshot = await (signal
      ? raceWithAbort(this.api.getSession(this.config.sessionId, signal), signal)
      : this.api.getSession(this.config.sessionId));
    if (this.closed) return false;
    if (!snapshot.exists) {
      await this.observe("closed");
      return false;
    }
    await this.observe(snapshot.busy ? "busy" : "idle");
    return true;
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        // Report the raw observed state, not the freshness-decayed one: the
        // relay gates delivery on the reported state being "idle", so
        // reporting "unknown" for a quiet idle session would close the gate
        // 5s after the last event and stall every pending message (#31 r2
        // live evidence). Admission safety stays intact — submit() re-verifies
        // the markers on demand before admitting.
        await this.report(this.currentReportedState());
        failures = 0;
        await abortableSleep(
          Math.max(1, this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
          signal,
        );
      } catch {
        failures += 1;
        await abortableSleep(backoffDelay(failures), signal);
      }
    }
  }

  private async eventLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.observe("unknown");
        const events = await this.api.subscribeEvents(signal);
        await this.refreshStatus(signal);
        for await (const event of events) {
          if (signal.aborted) break;
          const type = eventType(event);
          if (type === "server.connected") {
            await this.observe("unknown");
            await this.refreshStatus(signal);
            failures = 0;
            continue;
          }
          if (eventSessionId(event) !== this.config.sessionId) continue;
          if (type === "session.deleted") {
            await this.observe("closed");
            return;
          }
          if (type === "session.execution.started") {
            await this.observe("busy");
            failures = 0;
          } else if (
            type === "session.execution.succeeded" ||
            type === "session.execution.failed"
          ) {
            await this.observe("idle");
            failures = 0;
          } else if (type === "session.status") {
            const statusType = eventStatusType(event);
            if (statusType === "idle") await this.observe("idle");
            else if (statusType === "busy") await this.observe("busy");
            failures = 0;
          } else if (type === "session.idle") {
            await this.observe("idle");
            failures = 0;
          }
        }
        if (!signal.aborted) {
          failures += 1;
          await this.observe("unknown");
        }
      } catch {
        if (!signal.aborted) {
          failures += 1;
          await this.observe("unknown");
        }
      }
      if (!signal.aborted) await abortableSleep(backoffDelay(failures), signal);
    }
  }

  private async finishClose(): Promise<void> {
    const tasks = [this.heartbeatTask, this.eventTask].filter(
      (task): task is Promise<void> => task !== undefined,
    );
    await Promise.allSettled(tasks);
    await this.reportQueue;
    await this.relay.closeSession({ sessionId: this.config.sessionId });
  }
}

export type RegisteredOpenCodeAdapter = OpenCodeAdapter & {
  readonly sessionBinding: SessionBinding;
};

export async function runOpenCodeAdapter(
  config: OpenCodeRunConfig,
  relay: RelayHttpClient,
  api?: OpenCodeApi,
): Promise<RegisteredOpenCodeAdapter> {
  const resolved =
    api ??
    createOpenCodeApi(config.baseUrl, {
      ...(config.authToken !== undefined
        ? { fetch: openCodeBasicAuthFetch(config.authToken) }
        : {}),
    });
  const adapter = new OpenCodeAdapter(resolved, relay, config);
  const { session } = await relay.registerSession({
    sessionId: config.sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: adapter.capabilities,
  });
  adapter.start();
  return Object.assign(adapter, {
    sessionBinding: { sessionId: session.sessionId, generation: session.generation },
  });
}
