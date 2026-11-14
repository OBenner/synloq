import { describe, expect, it } from "vitest";
import { formatDiagnostic } from "../src/diagnostics.js";

describe("formatDiagnostic", () => {
  it("prefixes the message with an ISO 8601 UTC timestamp", () => {
    const line = formatDiagnostic("relay recovered", new Date("2026-11-14T06:12:33.456Z"));
    expect(line).toBe("2026-11-14T06:12:33.456Z relay recovered");
  });

  it("defaults to the current time", () => {
    const line = formatDiagnostic("probe");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z probe$/);
  });
});
