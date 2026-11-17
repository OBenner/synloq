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
    const cto = new RelayHttpClient(handle.baseUrl, () => tokens.get("cto")!);
    const arch = new RelayHttpClient(handle.baseUrl, () => tokens.get("arch")!);
    const operator = new RelayHttpClient(handle.baseUrl, () => tokens.get("operator")!);
    return { handle, tokens, cto, arch, operator };
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

  it("rejects unauthenticated and malformed note requests fail-loud", async () => {
    const { handle, tokens } = await fixture();
    try {
      const unauthenticated = await fetch(`${handle.baseUrl}/v1/notes?key=k`);
      expect(unauthenticated.status).toBe(401);
      const longKey = await fetch(`${handle.baseUrl}/v1/notes?key=${"k".repeat(129)}`, {
        headers: authorized(tokens.get("cto")!),
      });
      expect(longKey.status).toBe(400);
      const bigBody = await fetch(`${handle.baseUrl}/v1/notes`, {
        method: "PUT",
        headers: { ...authorized(tokens.get("cto")!), "content-type": "application/json" },
        body: JSON.stringify({ key: "k", body: "x".repeat(65_537) }),
      });
      expect(bigBody.status).toBe(400);
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
    const { handle, cto, arch } = await fixture();
    try {
      for (let index = 0; index < 256; index += 1) {
        await cto.noteWrite(`key-${index}`, "body");
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
