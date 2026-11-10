import { SynloqError } from "../domain/errors.js";
import type { Message } from "../domain/message.js";
import type { AdapterCapabilities, SessionState } from "../domain/session.js";
import type { DeliveryAdapter, DeliveryReceipt } from "./types.js";

export class KimiFallbackAdapter implements DeliveryAdapter {
  readonly capabilities: AdapterCapabilities = {
    activeDelivery: false,
    stateReporting: false,
    clientIdempotency: false,
  };

  async state(_sessionId: string): Promise<SessionState> {
    return "unknown";
  }

  async submit(_sessionId: string, _message: Message): Promise<DeliveryReceipt> {
    throw new SynloqError(
      "DELIVERY_UNCERTAIN",
      "Kimi Code active delivery is unsupported; use the MCP inbox",
    );
  }
}
