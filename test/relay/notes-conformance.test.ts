import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveCommand } from "../../src/cli/commands.js";
import { RelayHttpClient } from "../../src/transport/http-client.js";
import { issueTestCredentials } from "../helpers/credentials.js";

const manifest = `project: verdicta
agents:
  cto:
    title: CTO
    role: Technical strategy
  arch:
    title: Architect
    role: Review
`;

function authorized(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("notes conformance (#22)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), "synloq-notes-conf-"));
    dirs.push(root);
    writeFileSync(join(root, "synloq.yaml"), manifest, "utf8");
    const home = join(root, ".synloq");
    const handle = await serveCommand({ projectRoot: root, port: 0, synloqHome: home });
    vi.stubEnv("SYNLOQ_HOME", home);
    const tokens = await issueTestCredentials(root);
    const options = { project: "verdicta" } as const;
    const cto = new RelayHttpClient(handle.baseUrl, () => tokens.get("cto")!, {
      ...options,
      agentId: "cto",
    });
    const arch = new RelayHttpClient(handle.baseUrl, () => tokens.get("arch")!, {
      ...options,
      agentId: "arch",
    });
    const operator = new RelayHttpClient(handle.baseUrl, () => tokens.get("operator")!, {
      ...options,
      agentId: "operator",
    });
    return { handle, tokens, cto, arch, operator, root, home };
  }

  it("scopes notes to the authenticated role: foreign namespaces stay empty", async () => {
    const { handle, cto, arch } = await fixture();
    try {
      await cto.noteWrite("decisions", "# Decisions\n- picked relay-side notes");
      const own = await cto.noteRead("decisions");
      expect(own.note.body).toContain("picked relay-side notes");
      // arch using its own credential has a separate namespace: NOT_FOUND,
      // not a leak of cto's note.
      await expect(arch.noteRead("decisions")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await handle.close();
    }
  });

  it("operator notes live in their own namespace and cannot read role notes", async () => {
    const { handle, cto, operator } = await fixture();
    try {
      await cto.noteWrite("loops", "cto-loop");
      await operator.noteWrite("ops-log", "rotation done");
      expect((await operator.noteRead("ops-log")).note.body).toBe("rotation done");
      await expect(operator.noteRead("loops")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await handle.close();
    }
  });

  it("rejects bearer and malformed note requests fail-loud", async () => {
    const { handle, tokens, cto } = await fixture();
    try {
      // Auth v2: both a raw Bearer header and a headerless non-health request
      // are protocol errors (409); 401 is reserved for proof-present-but-wrong,
      // which the transport client's own tests cover.
      const bearer = await fetch(`${handle.baseUrl}/v1/notes?key=k`, {
        headers: authorized("stale-bearer"),
      });
      expect(bearer.status).toBe(409);
      const headerless = await fetch(`${handle.baseUrl}/v1/notes?key=k`);
      expect(headerless.status).toBe(409);
      // Malformed shapes travel on an authenticated channel and fail 400
      // (zod) at the route — surfaced by the client as INVALID_INPUT.
      await expect(cto.noteRead("k".repeat(129))).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      // A body over the transport's 64 KiB JSON cap is rejected inside the
      // auth layer, before the response proof exists — the client therefore
      // surfaces UNAUTHORIZED (unproven responses are never trusted), not the
      // zod INVALID_INPUT that a smaller-but-over-limit body would get.
      await expect(cto.noteWrite("k", "x".repeat(65_537))).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    } finally {
      await handle.close();
    }
  });

  it("overwrites are visible immediately and doctor reports aggregate stats only", async () => {
    const { handle, cto, operator } = await fixture();
    try {
      await cto.noteWrite("decisions", "v1");
      await cto.noteWrite("decisions", "v2");
      expect((await cto.noteRead("decisions")).note.body).toBe("v2");
      const doctor = await operator.doctor();
      expect(doctor.notes).toMatchObject({ roles: 1, notes: 1 });
      expect(JSON.stringify(doctor)).not.toContain("v2");
    } finally {
      await handle.close();
    }
  });

  it("caps keys per role without affecting other roles", async () => {
    const { handle, cto, arch, root, home } = await fixture();
    try {
      // Seed at store level: 257 challenge round trips would trip the auth-v2
      // challenge rate limit (100/s). The cap behavior is HTTP-visible on the
      // overflow write alone; a second connection waits out the relay writer
      // (busy_timeout) exactly like doctor's offline probes do.
      const { projectPaths } = await import("../../src/config/paths.js");
      const { openDatabase } = await import("../../src/storage/sqlite.js");
      const { NotesStore } = await import("../../src/storage/notes-store.js");
      const paths = await projectPaths(root, home);
      const database = openDatabase(paths.database);
      try {
        const seed = new NotesStore(database);
        for (let index = 0; index < 256; index += 1) {
          seed.write("verdicta", "cto", `key-${index}`, "body", new Date().toISOString());
        }
      } finally {
        database.close();
      }
      await expect(cto.noteWrite("one-more", "body")).rejects.toMatchObject({
        code: "STORAGE_FAILURE",
      });
      await arch.noteWrite("fine", "body");
    } finally {
      await handle.close();
    }
  });
});
