import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { findExamplesImports } from "../../scripts/check-no-dependency-examples.mjs";

// Issue #26 review follow-up: the guard must also catch side-effect imports
// (no `from` clause) — the most dangerous form, because SDK demo servers
// self-execute on import. Fixture sources are built at runtime so this test
// file itself does not trip the static guard it exercises.

const quoted = (specifier: string) => `"${specifier}"`;
const sdkDemo = "@modelcontextprotocol/sdk/examples/server/simpleSseServer.js";

describe("check-no-dependency-examples guard", () => {
  it("catches a side-effect import without from", () => {
    const violations = findExamplesImports(`import ${quoted(sdkDemo)};\n`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ specifier: sdkDemo, line: 1 });
  });

  it("still catches import-from, export-from, dynamic import, and require", () => {
    const content = [
      `import x from ${quoted("pkg/examples/a.js")};`,
      `export { y } from ${quoted("pkg/examples/b.js")};`,
      `const m = await import(${quoted("pkg/examples/c.js")});`,
      `const r = require(${quoted("pkg/examples/d.js")});`,
    ].join("\n");
    const violations = findExamplesImports(content) as Array<{ specifier: string; line: number }>;
    expect(violations.map((v) => v.line)).toEqual([1, 2, 3, 4]);
  });

  it("ignores clean package imports and relative side-effect imports", () => {
    const content = [
      `import ${quoted("pkg/dist/register.js")};`,
      `import ${quoted("./local-setup.js")};`,
      `import { z } from ${quoted("zod")};`,
      // "examples-lite" is not an examples/ path segment.
      `import x from ${quoted("@scope/examples-lite/ok.js")};`,
    ].join("\n");
    expect(findExamplesImports(content)).toEqual([]);
  });
});
