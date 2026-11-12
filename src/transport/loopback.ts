import { SynloqError } from "../domain/errors.js";

export interface LoopbackEndpoint {
  host: "127.0.0.1" | "::1";
  port: number;
  baseUrl: string;
}

export function parseLoopbackHttpUrl(value: string): LoopbackEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SynloqError("INVALID_INPUT", "Synloq relay URL is invalid");
  }
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (
    url.protocol !== "http:" ||
    (host !== "127.0.0.1" && host !== "::1") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !/^\d+$/.test(url.port)
  ) {
    throw new SynloqError("INVALID_INPUT", "Synloq relay URL must be an explicit loopback origin");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new SynloqError("INVALID_INPUT", "Synloq relay port is invalid");
  }
  return { host, port, baseUrl: `http://${host === "::1" ? "[::1]" : host}:${port}` };
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    parseLoopbackHttpUrl(value);
    return true;
  } catch {
    return false;
  }
}
