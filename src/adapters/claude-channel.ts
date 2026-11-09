import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import {
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type SessionState,
} from "../domain/session.js";
import { frameMessage } from "./reference.js";
import { mapClaudeHook } from "./claude-state.js";
import type { DeliveryAdapter, DeliveryReceipt } from "./types.js";

const claudeExperimentalCapabilities = {
  "claude/channel": {},
  "claude/channel/permission": {},
};

export interface ClaudeAdapterConfig {
  sessionId: string;
  protocolVersion: number;
  activationVerifiedAt?: string;
}

export interface ClaudeInitialization {
  capabilities: ServerCapabilities;
}

export interface ClaudeChannelNotification {
  method: "notifications/claude/channel";
  params: {
    content: string;
    meta: {
      project: string;
      from: string;
      message: string;
      thread: string;
    };
  };
}

export interface RunningClaudeAdapter {
  server: Server;
  adapter: ClaudeChannelAdapter;
}

export function createClaudeChannelServer(): Server {
  return new Server(
    { name: "synloq", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
        experimental: claudeExperimentalCapabilities,
      },
    },
  );
}

export class ClaudeChannelAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities = {
    activeDelivery: false,
    stateReporting: true,
    clientIdempotency: true,
  };

  private initializedCapabilities: ServerCapabilities | undefined;
  private observedState: SessionState = "unknown";
  private readonly receipts = new Map<string, DeliveryReceipt>();

  constructor(
    private readonly server: Server,
    private readonly config: ClaudeAdapterConfig,
  ) {}

  observeInitialize(initialized: ClaudeInitialization): void {
    this.initializedCapabilities = initialized.capabilities;
    this.refreshCapabilities();
  }

  observeHook(event: string, sessionId: string): void {
    this.observedState =
      sessionId === this.config.sessionId ? mapClaudeHook(event).state : "unknown";
  }

  async state(sessionId: string): Promise<SessionState> {
    return sessionId === this.config.sessionId ? this.observedState : "unknown";
  }

  async submit(sessionId: string, message: Message): Promise<DeliveryReceipt> {
    const original = this.receipts.get(message.id);
    if (original) return original;
    if (sessionId !== this.config.sessionId) {
      throw new SynloqError("UNAUTHORIZED", "session ID does not match the visible binding");
    }

    this.refreshCapabilities();
    if (!this.capabilities.activeDelivery) {
      throw new SynloqError(
        "INVALID_INPUT",
        "active delivery is not activated for this Claude session",
      );
    }
    if ((await this.state(sessionId)) !== "idle") {
      throw new SynloqError("INVALID_INPUT", "visible session is not idle");
    }

    const notification: ClaudeChannelNotification = {
      method: "notifications/claude/channel",
      params: {
        content: frameMessage(message),
        meta: {
          project: message.project,
          from: message.from,
          message: message.id,
          thread: message.threadId,
        },
      },
    };
    await this.server.notification(
      notification as unknown as Parameters<Server["notification"]>[0],
    );
    const receipt: DeliveryReceipt = { state: "submitted" };
    this.receipts.set(message.id, receipt);
    return receipt;
  }

  private refreshCapabilities(): void {
    const experimental = this.initializedCapabilities?.experimental;
    this.capabilities.activeDelivery =
      experimental?.["claude/channel"] !== undefined &&
      experimental["claude/channel/permission"] !== undefined &&
      this.config.protocolVersion === PROTOCOL_VERSION &&
      this.config.activationVerifiedAt !== undefined &&
      this.config.activationVerifiedAt.trim() !== "";
  }
}

export async function runClaudeAdapter(
  config: ClaudeAdapterConfig,
  transport: Transport = new StdioServerTransport(),
): Promise<RunningClaudeAdapter> {
  const server = createClaudeChannelServer();
  const adapter = new ClaudeChannelAdapter(server, config);
  server.oninitialized = () => {
    adapter.observeInitialize({
      capabilities: {
        tools: {},
        experimental: claudeExperimentalCapabilities,
      },
    });
  };
  await server.connect(transport);
  return { server, adapter };
}
