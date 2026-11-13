import { describe, expect, it } from "vitest";
import { SynloqError } from "../../../src/domain/errors.js";
import {
  discoverOpenCodeHost,
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
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the service does not answer any candidate", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execFail(),
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
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("fails closed when the info payload is not JSON", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execOk("plain text without json"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the info payload has no urls", async () => {
    await expect(
      discoverOpenCodeHost({
        environment: { ...windowsEnvironment, OPENCODE_EXECUTABLE: "C:\\tools\\opencode.exe" },
        platform: "win32",
        exec: execOk('{"urls":[]}'),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
