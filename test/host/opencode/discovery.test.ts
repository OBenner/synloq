import { describe, expect, it } from "vitest";
import { SynloqError } from "../../../src/domain/errors.js";
import {
  discoverOpenCodeHost,
  resolveOpenCodeServiceAuth,
  type OpenCodeDiscoveryExec,
} from "../../../src/host/opencode/discovery.js";

const windowsEnvironment = { APPDATA: "C:\\Users\\test\\AppData\\Roaming" };

function execOk(stdout: string): OpenCodeDiscoveryExec {
  return async () => ({ stdout });
}

function execFail(): OpenCodeDiscoveryExec {
  return async () => {
    throw new Error("opencode command failed");
  };
}

const infoStdout = 'log line\n{"urls":["http://127.0.0.1:52314/"]}';

// Hermetic default: never touch the real service.json on the host machine.
const noFile = async (): Promise<string> => {
  throw new Error("ENOENT");
};

describe("OpenCode host discovery", () => {
  it("prefers OPENCODE_EXECUTABLE override and resolves the service base URL", async () => {
    const calls: string[][] = [];
    const exec: OpenCodeDiscoveryExec = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "where") throw new Error("opencode command failed");
      return { stdout: infoStdout };
    };
    const endpoint = await discoverOpenCodeHost({
      environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
      platform: "win32",
      exec,
      readdir: async () => {
        throw new Error("ENOENT");
      },
      readfile: noFile,
    });
    expect(endpoint).toEqual({
      cliPath: "C:\\tools\\opencode.exe",
      baseUrl: "http://127.0.0.1:52314/",
      source: "override",
    });
    expect(calls).toEqual([
      ["where", "opencode"],
      ["C:\\tools\\opencode.exe", "api", "get", "/api/info"],
    ]);
  });

  it("picks the newest versioned bundled CLI directory", async () => {
    const exec: OpenCodeDiscoveryExec = async (file) => {
      expect(file).toBe(
        "C:\\Users\\test\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.10.3-x64\\opencode-cli.exe",
      );
      return { stdout: infoStdout };
    };
    const endpoint = await discoverOpenCodeHost({
      environment: windowsEnvironment,
      platform: "win32",
      exec,
      readdir: async () => ["2.2.7-x64", "2.10.3-x64", "2.9.99-x64", "not-a-version", "README"],
      readfile: noFile,
    });
    expect(endpoint.source).toBe("bundled");
    expect(endpoint.baseUrl).toBe("http://127.0.0.1:52314/");
  });

  it("falls back to PATH lookup when no bundled CLI exists", async () => {
    const exec: OpenCodeDiscoveryExec = async (file, args) => {
      if (file === "where") return { stdout: "C:\\bin\\opencode.exe\r\n" };
      expect([file, ...args]).toEqual(["C:\\bin\\opencode.exe", "api", "get", "/api/info"]);
      return { stdout: infoStdout };
    };
    const endpoint = await discoverOpenCodeHost({
      environment: windowsEnvironment,
      platform: "win32",
      exec,
      readdir: async () => {
        throw new Error("ENOENT");
      },
      readfile: noFile,
    });
    expect(endpoint).toEqual({
      cliPath: "C:\\bin\\opencode.exe",
      baseUrl: "http://127.0.0.1:52314/",
      source: "path",
    });
  });

  it("uses which instead of where on posix platforms", async () => {
    const exec: OpenCodeDiscoveryExec = async (file) => {
      if (file === "which") return { stdout: "/usr/local/bin/opencode\n" };
      return { stdout: infoStdout };
    };
    const endpoint = await discoverOpenCodeHost({
      environment: {},
      platform: "linux",
      exec,
      readfile: noFile,
    });
    expect(endpoint.cliPath).toBe("/usr/local/bin/opencode");
    expect(endpoint.source).toBe("path");
  });

  it("tries the next candidate when a stale bundled CLI cannot reach the service", async () => {
    const exec: OpenCodeDiscoveryExec = async (file) => {
      if (file === "where") return { stdout: "C:\\bin\\opencode.exe\n" };
      if (file.includes("opencode-cli.exe")) throw new Error("opencode command failed");
      return { stdout: infoStdout };
    };
    const endpoint = await discoverOpenCodeHost({
      environment: windowsEnvironment,
      platform: "win32",
      exec,
      readdir: async () => ["2.2.7-x64"],
      readfile: noFile,
    });
    expect(endpoint.source).toBe("path");
  });

  it("fails closed when no CLI candidate exists", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: windowsEnvironment,
        platform: "win32",
        exec: execFail(),
        readdir: async () => {
          throw new Error("ENOENT");
        },
        readfile: noFile,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the service does not answer any candidate", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execFail(),
        readfile: noFile,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a non-loopback service URL without trying further candidates", async () => {
    const exec = execOk('{"urls":["http://203.0.113.10:8080/"]}');
    const promise = discoverOpenCodeHost({
      environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
      platform: "win32",
      exec,
      readdir: async () => ["2.2.7-x64"],
      readfile: noFile,
    });
    await expect(promise).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(promise).rejects.toBeInstanceOf(SynloqError);
  });

  it("rejects a malformed service URL", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execOk('{"urls":["not a url"]}'),
        readfile: noFile,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("fails closed when the info payload is not JSON", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execOk("plain text without json"),
        readfile: noFile,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the info payload has no urls", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execOk('{"urls":[]}'),
        readfile: noFile,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("attaches the service password from the state registration file", async () => {
    const endpoint = await discoverOpenCodeHost({
      environment: {
        ...windowsEnvironment,
        OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe",
        HOME: "C:\\Users\\test",
      },
      platform: "win32",
      exec: execOk(infoStdout),
      readfile: async (path) => {
        expect(path.replaceAll("\\", "/")).toBe("C:/Users/test/.local/state/opencode/service.json");
        return '{"id":"x","password":"secret-service-password"}';
      },
    });
    expect(endpoint.authToken).toBe("secret-service-password");
  });

  it("omits the token when service.json is absent or malformed", async () => {
    const base = {
      environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
      platform: "win32" as const,
      exec: execOk(infoStdout),
    };
    const missing = await discoverOpenCodeHost({
      ...base,
      readfile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.authToken).toBeUndefined();
    const malformed = await discoverOpenCodeHost({
      ...base,
      readfile: async () => "{ not json",
    });
    expect(malformed.authToken).toBeUndefined();
  });
});

describe("resolveOpenCodeServiceAuth", () => {
  it("honours XDG_STATE_HOME and prefers it over the legacy config mirror", async () => {
    const seen: string[] = [];
    const token = await resolveOpenCodeServiceAuth({
      environment: { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/xdg", HOME: "/home/test" },
      readfile: async (path) => {
        seen.push(path.replaceAll("\\", "/"));
        return '{"password":"state-password"}';
      },
    });
    expect(token).toBe("state-password");
    expect(seen).toEqual(["/state/opencode/service.json"]);
  });

  it("falls back to the legacy config mirror when the state file is missing", async () => {
    const seen: string[] = [];
    const token = await resolveOpenCodeServiceAuth({
      environment: { HOME: "/home/test" },
      readfile: async (path) => {
        const normalized = path.replaceAll("\\", "/");
        seen.push(normalized);
        if (normalized.includes(".local/state")) throw new Error("ENOENT");
        return '{"password":"legacy-password"}';
      },
    });
    expect(token).toBe("legacy-password");
    expect(seen).toEqual([
      "/home/test/.local/state/opencode/service.json",
      "/home/test/.config/opencode/service.json",
    ]);
  });
});
