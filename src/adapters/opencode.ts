import {
  createOpencodeClient as createOpenCodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient as OpenCodeClient,
  type SessionStatus as OpenCodeSessionStatus,
} from "@opencode-ai/sdk/client";
import {
  createOpencodeClient as createOpenCodeV2Client,
  type OpencodeClient as OpenCodeV2Client,
  type SessionInputAdmitted,
} from "@opencode-ai/sdk/v2/client";
import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type SessionBinding,
  type SessionState,
} from "../domain/session.js";
import type { RelayHttpClient } from "../transport/http-client.js";
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
}

export interface OpenCodeClientSet {
  openCode: OpenCodeV2Client;
  client: OpenCodeClient;
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
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([operation, aborted]).finally(() => {
    signal.removeEventListener("abort", abort);
  });
}

function mapStatus(status: OpenCodeSessionStatus): SessionState {
  if (status.type === "idle") return "idle";
  if (status.type === "busy") return "busy";
  return "unknown";
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  if (!("properties" in event)) return undefined;
  const properties = event.properties as {
    sessionID?: unknown;
    info?: { id?: unknown };
  };
  if (typeof properties.sessionID === "string") return properties.sessionID;
  return typeof properties.info?.id === "string" ? properties.info.id : undefined;
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
    private readonly openCode: OpenCodeV2Client,
    private readonly client: OpenCodeClient,
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
    if (this.currentState() !== "idle") {
      throw new SynloqError("INVALID_INPUT", "visible session is not freshly idle");
    }

    try {
      const prompt = this.openCode.v2.session.prompt(
        {
          sessionID: sessionId,
          prompt: { text: frameMessage(message) },
          delivery: "queue",
          resume: false,
        },
        { throwOnError: true },
      );
      const response = context?.signal ? await raceWithAbort(prompt, context.signal) : await prompt;
      const admitted = response.data.data;
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
    admitted: SessionInputAdmitted,
    sessionId: string,
    message: Message,
  ): boolean {
    return (
      admitted.id.trim() !== "" &&
      admitted.sessionID === sessionId &&
      admitted.prompt.text === frameMessage(message) &&
      admitted.delivery === "queue" &&
      Number.isSafeInteger(admitted.admittedSeq) &&
      admitted.admittedSeq >= 0
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

  private async refreshStatus(signal: AbortSignal): Promise<boolean> {
    const response = await raceWithAbort(this.client.session.status({}), signal);
    if (this.closed) return false;
    const status = response.data?.[this.config.sessionId];
    if (!status) {
      await this.observe("unknown");
      return false;
    }
    await this.observe(mapStatus(status));
    return true;
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.report(this.currentState());
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
        const events = await this.client.event.subscribe({ signal });
        let freshStatus = await this.refreshStatus(signal);
        for await (const event of events.stream) {
          if (signal.aborted) break;
          if (event.type === "server.connected") {
            await this.observe("unknown");
            freshStatus = await this.refreshStatus(signal);
            failures = 0;
            continue;
          }
          if (eventSessionId(event) !== this.config.sessionId) continue;
          if (event.type === "session.deleted") {
            await this.observe("closed");
            return;
          }
          if (!freshStatus) continue;
          if (event.type === "session.status") {
            await this.observe(mapStatus(event.properties.status));
            failures = 0;
          } else if (event.type === "session.idle") {
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
  clients?: OpenCodeClientSet,
): Promise<RegisteredOpenCodeAdapter> {
  const openCode = clients?.openCode ?? createOpenCodeV2Client({ baseUrl: config.baseUrl });
  const client = clients?.client ?? createOpenCodeClient({ baseUrl: config.baseUrl });
  const adapter = new OpenCodeAdapter(openCode, client, relay, config);
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
