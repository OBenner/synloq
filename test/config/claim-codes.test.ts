import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/adapters/types.js";
import {
  CLAIM_CODE_TTL_MS,
  ClaimCodeStore,
  claimCodeAgentId,
} from "../../src/config/claim-codes.js";
import { projectPaths } from "../../src/config/paths.js";
import { TeamStateStore, type TeamState } from "../../src/config/team-state.js";

const T0 = Date.parse("2026-11-14T12:00:00.000Z");

async function fixture(): Promise<{ root: string; store: TeamStateStore; bindings: string }> {
  const root = await mkdtemp(join(tmpdir(), "synloq-claim-project-"));
  const home = await mkdtemp(join(tmpdir(), "synloq-claim-home-"));
  const paths = await projectPaths(root, home);
  const store = new TeamStateStore(paths.bindings);
  await store.write({ version: 1, project: "stand", projectRoot: root, conversations: {} });
  return { root, store, bindings: paths.bindings };
}

function clockAt(ms: number): Clock {
  return { now: () => ms };
}

describe("claimCodeAgentId", () => {
  it("parses well-formed codes and rejects malformed ones", () => {
    expect(claimCodeAgentId("synloq-claim-dev-abcdef23")).toBe("dev");
    expect(claimCodeAgentId("synloq-claim-dev2-abcdef22")).toBe("dev2");
    expect(claimCodeAgentId("garbage")).toBeUndefined();
    expect(claimCodeAgentId("synloq-claim-dev-ABC")).toBeUndefined();
    expect(claimCodeAgentId("synloq-claim-BAD-abcdef22")).toBeUndefined();
  });
});

describe("ClaimCodeStore", () => {
  it("issues a human-readable code and persists only its hash", async () => {
    const { store, bindings } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));

    const issued = await codes.issue("dev");

    expect(issued.code).toMatch(/^synloq-claim-dev-[a-z2-7]{8}$/);
    expect(issued.expiresAt).toBe(new Date(T0 + CLAIM_CODE_TTL_MS).toISOString());
    const persisted = await readFile(bindings, "utf8");
    expect(persisted).not.toContain(issued.code);
    const state = await store.read();
    expect(state?.claims?.dev?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state?.claims?.dev?.expiresAt).toBe(issued.expiresAt);
  });

  it("consumes a live code once, then reports no outstanding code", async () => {
    const { store } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));
    const issued = await codes.issue("dev");

    await expect(codes.consume("dev", issued.code)).resolves.toEqual({ status: "claimed" });
    expect((await store.read())?.claims?.dev).toBeUndefined();
    await expect(codes.consume("dev", issued.code)).resolves.toEqual({
      status: "no-outstanding-code",
    });
  });

  it("reports an expired code with its expiry and clears it", async () => {
    const { store } = await fixture();
    const issued = await new ClaimCodeStore(store, clockAt(T0)).issue("dev");
    const later = new ClaimCodeStore(store, clockAt(T0 + CLAIM_CODE_TTL_MS + 1));

    await expect(later.consume("dev", issued.code)).resolves.toEqual({
      status: "expired",
      expiresAt: issued.expiresAt,
    });
    expect((await store.read())?.claims?.dev).toBeUndefined();
    await expect(later.consume("dev", issued.code)).resolves.toEqual({
      status: "no-outstanding-code",
    });
  });

  it("rejects a mismatched code without burning the outstanding one", async () => {
    const { store } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));
    const issued = await codes.issue("dev");

    await expect(codes.consume("dev", "synloq-claim-dev-zzzzz222")).resolves.toEqual({
      status: "code-mismatch",
    });
    await expect(codes.consume("dev", issued.code)).resolves.toEqual({ status: "claimed" });
  });

  it("re-issuing replaces the outstanding code", async () => {
    const { store } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));
    const first = await codes.issue("dev");
    const second = await codes.issue("dev");

    expect(second.code).not.toBe(first.code);
    await expect(codes.consume("dev", first.code)).resolves.toEqual({ status: "code-mismatch" });
    await expect(codes.consume("dev", second.code)).resolves.toEqual({ status: "claimed" });
  });

  it("clear drops the outstanding code (token rotation path)", async () => {
    const { store } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));
    const issued = await codes.issue("dev");

    await expect(codes.clear("dev")).resolves.toBe(true);
    await expect(codes.consume("dev", issued.code)).resolves.toEqual({
      status: "no-outstanding-code",
    });
    await expect(codes.clear("dev")).resolves.toBe(false);
  });

  it("fails loudly when the project was never initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "synloq-claim-project-"));
    const home = await mkdtemp(join(tmpdir(), "synloq-claim-home-"));
    const paths = await projectPaths(root, home);
    const codes = new ClaimCodeStore(new TeamStateStore(paths.bindings), clockAt(T0));

    await expect(codes.issue("dev")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(codes.consume("dev", "synloq-claim-dev-abcdef23")).resolves.toEqual({
      status: "no-outstanding-code",
    });
  });

  it("keeps other roles' claims when one is consumed", async () => {
    const { store } = await fixture();
    const codes = new ClaimCodeStore(store, clockAt(T0));
    const dev = await codes.issue("dev");
    const arch = await codes.issue("arch");

    await codes.consume("dev", dev.code);
    const state = await store.read();
    expect(state?.claims?.dev).toBeUndefined();
    expect(state?.claims?.arch).toBeDefined();
    await expect(codes.consume("arch", arch.code)).resolves.toEqual({ status: "claimed" });
  });
  it(
    "always issues well-formed 8-char base32 codes (100-iteration pin)",
    { timeout: 20000 },
    async () => {
      const { store } = await fixture();
      const codes = new ClaimCodeStore(store, clockAt(T0));

      // 100 iterations are ample: the output length is invariant by
      // construction (5 bytes = 40 bits = exactly 8 base32 chars); this pins
      // the shape against regressions, not statistics. 1000 iterations of
      // atomic state writes flaked under parallel verify load on Windows.
      for (let i = 0; i < 100; i++) {
        const issued = await codes.issue("dev");
        expect(issued.code).toMatch(/^synloq-claim-dev-[a-z2-7]{8}$/);
      }
    },
  );
});

describe("team state claims schema", () => {
  it("round-trips state without claims (pre-#42 files stay valid)", async () => {
    const { store } = await fixture();
    const state = await store.read();
    expect(state?.claims).toBeUndefined();
    const rewritten: TeamState = { ...state!, conversations: {} };
    await store.write(rewritten);
    expect((await store.read())?.claims).toBeUndefined();
  });
});
