import { KimiWorkControlClient } from "../host/kimi-work/control-client.js";
import { loadKimiWorkControlEndpoint } from "../host/kimi-work/control-status.js";
import { KimiWorkJsonRpcConnection } from "../host/kimi-work/json-rpc.js";
import type { KimiWorkInitHost } from "./types.js";

export async function createKimiWorkInitHost(): Promise<
  KimiWorkInitHost & { close(): Promise<void> }
> {
  const endpoint = await loadKimiWorkControlEndpoint();
  const rpc = new KimiWorkJsonRpcConnection(endpoint);
  const control = new KimiWorkControlClient(rpc);
  return {
    create: (input) => control.create(input),
    list: (input) => control.list(input),
    close: () => rpc.close(),
  };
}
