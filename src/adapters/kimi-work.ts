import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type SessionBinding,
  type SessionState,
} from "../domain/session.js";
import {
  KimiWorkControlClient,
  type KimiWorkBinding,
  type KimiWorkMetadata,
  type KimiWorkSendResult,
} from "../host/kimi-work/control-client.js";
import { loadKimiWorkControlEndpoint } from "../host/kimi-work/control-status.js";
import { KimiWorkJsonRpcConnection, KimiWorkRpcError } from "../host/kimi-work/json-rpc.js";
import { findMatchingVisibleTurns, formatKimiWorkPrompt } from "../host/kimi-work/prompt.js";
import type { RelayHttpClient } from "../transport/http-client.js";
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
const DEFAULT_RECONCILIATION_DELAY_MS = 100;

export interface KimiWorkControl {
  metadata(binding: KimiWorkBinding): Promise<KimiWorkMetadata>;
  busy(binding: KimiWorkBinding): Promise<boolean>;
  messages(
    binding: KimiWorkBinding,
    limit?: number,
  ): Promise<ReturnType<KimiWorkControlClient["messages"]> extends Promise<infer T> ? T : never>;
  send(binding: KimiWorkBinding, text: string, signal?: AbortSignal): Promise<KimiWorkSendResult>;
}

export interface KimiWorkClientHandle {
  control: KimiWorkControl;
  close(): Promise<void>;
}

export interface KimiWorkAdapterConfig extends KimiWorkBinding {
  project: string;
  agentId: string;
  heartbeatIntervalMs?: number;
  reconciliationDelayMs?: number;
}

export interface KimiWorkAdapterOptions {
  clock?: Clock;
  heartbeatIntervalMs?: number;
  reconciliationDelayMs?: number;
  closeControl?: () => Promise<void>;
  reconnect?: () => Promise<KimiWorkControl | KimiWorkClientHandle>;
  onUnauthorized?: (error: SynloqError) => void;
}

export interface KimiWorkAdapterClients {
  control?: KimiWorkControl;
  connect?: () => Promise<KimiWorkClientHandle>;
  onUnauthorized?: (error: SynloqError) => void;
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

function isClientHandle(
  value: KimiWorkControl | KimiWorkClientHandle,
): value is KimiWorkClientHandle {
  return "control" in value && typeof value.close === "function";
}

export class KimiWorkAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities = {
    activeDelivery: true,
    stateReporting: true,
    clientIdempotency: false,
  };

  private control: KimiWorkControl;
  private closeControl: () => Promise<void>;
  private readonly binding: KimiWorkBinding;
  private readonly clock: Clock;
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly submissions = new Map<string, Promise<DeliveryReceipt>>();
  private observedState: SessionState = "unknown";
  private observedAt = Number.NaN;
  private abortController: AbortController | undefined;
  private heartbeatTask: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private reportQueue: Promise<void> = Promise.resolve();
  private generation: number | undefined;
  private started = false;
  private disconnected = false;
  private closed = false;

  constructor(
    control: KimiWorkControl,
    private readonly relay: RelayHttpClient,
    private readonly config: KimiWorkAdapterConfig,
    private readonly options: KimiWorkAdapterOptions = {},
  ) {
    this.control = control;
    this.closeControl = options.closeControl ?? (async () => undefined);
    this.binding = {
      workAgentId: config.workAgentId,
      conversationKey: config.conversationKey,
      sessionKey: config.sessionKey,
      workspacePath: config.workspacePath,
      ...(config.kernelSessionId ? { kernelSessionId: config.kernelSessionId } : {}),
    };
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  start(): void {
    if (this.closed || this.abortController) return;
    this.started = true;
    this.abortController = new AbortController();
    this.heartbeatTask = this.heartbeatLoop(this.abortController.signal);
  }

  setGeneration(generation: number): void {
    this.generation = generation;
  }

  async state(sessionId: string): Promise<SessionState> {
    if (sessionId !== this.config.conversationKey) return "unknown";
    return this.currentState();
  }

  async refresh(): Promise<void> {
    try {
      const metadata = await this.control.metadata(this.binding);
      this.assertMetadata(metadata);
      const busy = await this.control.busy(this.binding);
      await this.observe(busy ? "busy" : "idle");
      this.disconnected = false;
    } catch (error) {
      await this.observe("unknown");
      this.disconnected = true;
      throw error;
    }
  }

  async submit(
    sessionId: string,
    message: Message,
    context?: DeliverySubmissionContext,
  ): Promise<DeliveryReceipt> {
    const original = this.receipts.get(message.id);
    if (original) return original;
    const pending = this.submissions.get(message.id);
    if (pending) return pending;

    const operation = this.performSubmit(sessionId, message, context);
    this.submissions.set(message.id, operation);
    try {
      return await operation;
    } finally {
      this.submissions.delete(message.id);
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

  private async performSubmit(
    sessionId: string,
    message: Message,
    context?: DeliverySubmissionContext,
  ): Promise<DeliveryReceipt> {
    if (sessionId !== this.config.conversationKey) {
      throw new SynloqError("UNAUTHORIZED", "session ID does not match the Kimi Work binding");
    }
    if (this.closed) throw new SynloqError("INVALID_INPUT", "Kimi Work adapter is closed");
    if (this.currentState() !== "idle") {
      throw new SynloqError("INVALID_INPUT", "visible session is not freshly idle");
    }

    const prompt = formatKimiWorkPrompt(message, context?.generation ?? 0);
    let existing: ReturnType<typeof findMatchingVisibleTurns>;
    try {
      existing = findMatchingVisibleTurns(await this.control.messages(this.binding, 50), prompt);
    } catch {
      throw new SynloqError("INVALID_INPUT", "Kimi Work history is unavailable before admission");
    }
    if (existing.length > 1) throw this.deliveryUncertain(message.id);
    const previous = existing[0];
    if (previous) return this.memoize(message.id, previous.turnId ?? previous.id);

    try {
      await this.refresh();
    } catch (error) {
      if (error instanceof SynloqError && error.code === "UNAUTHORIZED") throw error;
      throw new SynloqError("INVALID_INPUT", "Kimi Work state is unavailable before admission");
    }
    if (this.currentState() !== "idle") {
      throw new SynloqError("INVALID_INPUT", "visible session is not freshly idle");
    }

    try {
      const admitted = await this.control.send(this.binding, prompt, context?.signal);
      this.assertAdmission(admitted);
      return this.memoize(message.id, admitted.turnId);
    } catch (error) {
      if (
        error instanceof KimiWorkRpcError &&
        (error.reasonCode === "CONVERSATION_BUSY" || error.reasonCode === "OPERATION_BUSY")
      ) {
        throw new SynloqError("INVALID_INPUT", "visible session became busy before admission");
      }
      return this.reconcile(message.id, prompt, context?.signal);
    }
  }

  private async reconcile(
    messageId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<DeliveryReceipt> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        await abortableSleep(
          this.options.reconciliationDelayMs ??
            this.config.reconciliationDelayMs ??
            DEFAULT_RECONCILIATION_DELAY_MS,
          this.abortController?.signal ?? signal ?? new AbortController().signal,
        );
      }
      try {
        const matches = findMatchingVisibleTurns(
          await this.control.messages(this.binding, 50),
          prompt,
        );
        if (matches.length === 1) {
          const match = matches[0]!;
          return this.memoize(messageId, match.turnId ?? match.id);
        }
        if (matches.length > 1) throw this.deliveryUncertain(messageId);
      } catch (error) {
        if (error instanceof SynloqError && error.code === "DELIVERY_UNCERTAIN") throw error;
      }
    }
    throw this.deliveryUncertain(messageId);
  }

  private memoize(messageId: string, clientMessageId: string): DeliveryReceipt {
    const receipt: DeliveryReceipt = { state: "delivered", clientMessageId };
    this.receipts.set(messageId, receipt);
    return receipt;
  }

  private assertMetadata(metadata: KimiWorkMetadata): void {
    if (
      metadata.conversationKey !== this.config.conversationKey ||
      metadata.sessionKey !== this.config.sessionKey ||
      metadata.origin !== "client" ||
      metadata.workspacePath !== this.config.workspacePath ||
      (this.config.kernelSessionId !== undefined &&
        metadata.kernelSessionId !== this.config.kernelSessionId)
    ) {
      throw new SynloqError(
        "UNAUTHORIZED",
        "Kimi Work metadata does not match the visible binding",
      );
    }
  }

  private assertAdmission(admitted: KimiWorkSendResult): void {
    if (
      admitted.accepted !== true ||
      admitted.conversationKey !== this.config.conversationKey ||
      admitted.turnId.trim() === "" ||
      admitted.kernelSessionId.trim() === "" ||
      (this.config.kernelSessionId !== undefined &&
        admitted.kernelSessionId !== this.config.kernelSessionId)
    ) {
      throw new Error("Kimi Work admission does not match the binding");
    }
  }

  private deliveryUncertain(messageId: string): SynloqError {
    // Retries stay probe-gated: a resubmit re-checks the visible history before
    // sending, so an uncertain outcome must not permanently block the message
    // (issue #28). The error only reports that THIS attempt stayed ambiguous.
    return new SynloqError(
      "DELIVERY_UNCERTAIN",
      `Kimi Work admission for ${messageId} is uncertain; the next attempt reconciles the visible history before resending`,
    );
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

  private report(state: SessionState): Promise<void> {
    if (!this.started || this.closed) return Promise.resolve();
    const request = this.reportQueue.then(async () => {
      await this.relay.heartbeat({
        sessionId: this.config.conversationKey,
        state,
        ...(this.generation === undefined ? {} : { generation: this.generation }),
      });
    });
    this.reportQueue = request.catch((error: unknown) => {
      if (error instanceof SynloqError && error.code === "UNAUTHORIZED") {
        this.options.onUnauthorized?.(error);
      }
    });
    return request;
  }

  private async observe(state: SessionState): Promise<void> {
    if (this.closed) return;
    this.observedState = state;
    this.observedAt = this.clock.now();
    try {
      await this.report(state);
    } catch {
      // The next refresh retries relay failures without fabricating host state.
    }
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (this.disconnected && this.options.reconnect) await this.reconnect();
        await this.refresh();
        failures = 0;
        await abortableSleep(
          Math.max(
            1,
            this.options.heartbeatIntervalMs ??
              this.config.heartbeatIntervalMs ??
              DEFAULT_HEARTBEAT_INTERVAL_MS,
          ),
          signal,
        );
      } catch {
        if (signal.aborted) break;
        failures += 1;
        await this.observe("unknown");
        await abortableSleep(backoffDelay(failures), signal);
      }
    }
  }

  private async reconnect(): Promise<void> {
    if (!this.options.reconnect) return;
    const next = await this.options.reconnect();
    await this.closeControl();
    if (isClientHandle(next)) {
      this.control = next.control;
      this.closeControl = next.close;
    } else {
      this.control = next;
      this.closeControl = async () => undefined;
    }
  }

  private async finishClose(): Promise<void> {
    if (this.heartbeatTask) await Promise.allSettled([this.heartbeatTask]);
    await this.reportQueue;
    await Promise.allSettled([
      this.relay.closeSession({ sessionId: this.config.conversationKey }),
      this.closeControl(),
    ]);
  }
}

export type RegisteredKimiWorkAdapter = KimiWorkAdapter & {
  readonly sessionBinding: SessionBinding;
};

async function connectKimiWork(): Promise<KimiWorkClientHandle> {
  const endpoint = await loadKimiWorkControlEndpoint();
  const connection = new KimiWorkJsonRpcConnection(endpoint);
  return {
    control: new KimiWorkControlClient(connection),
    close: () => connection.close(),
  };
}

export async function runKimiWorkAdapter(
  config: KimiWorkAdapterConfig,
  relay: RelayHttpClient,
  clients: KimiWorkAdapterClients = {},
): Promise<RegisteredKimiWorkAdapter> {
  const connect = clients.connect ?? connectKimiWork;
  const initialHandle = clients.control ? undefined : await connect();
  const initial = clients.control ?? initialHandle!.control;
  const closeControl: () => Promise<void> = initialHandle?.close ?? (async () => undefined);
  const reconnect = clients.control && !clients.connect ? undefined : connect;
  const adapter = new KimiWorkAdapter(initial, relay, config, {
    closeControl,
    ...(reconnect ? { reconnect } : {}),
    ...(clients.onUnauthorized ? { onUnauthorized: clients.onUnauthorized } : {}),
  });

  try {
    await adapter.refresh();
    const { session } = await relay.registerSession({
      sessionId: config.conversationKey,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: adapter.capabilities,
    });
    if (
      session.project !== config.project ||
      session.agentId !== config.agentId ||
      session.sessionId !== config.conversationKey
    ) {
      throw new SynloqError("UNAUTHORIZED", "relay registration does not match the Kimi Work role");
    }
    adapter.setGeneration(session.generation);
    adapter.start();
    return Object.assign(adapter, {
      sessionBinding: { sessionId: session.sessionId, generation: session.generation },
    });
  } catch (error) {
    await closeControl();
    throw error;
  }
}
