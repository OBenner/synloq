import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without type declarations
import { findHermeticityViolations } from "../../scripts/check-test-hermeticity.mjs";

// Issue #35: fixture sources are built at runtime so this test file itself
// does not trip the static guard it exercises.

const homedirCall = ["os", ".", "homedir", "()"].join("");
const tildeSynloq = ["~", "/", ".synloq"].join("");
const tildeConfig = ["~", "/", ".config", "/opencode"].join("");
const windowsVar = ["%", "USERPROFILE", "%"].join("");
const envRead = ["process", ".env", ".", "HOME"].join("");

describe("check-test-hermeticity guard", () => {
  it("catches a direct homedir resolution", () => {
    const violations = findHermeticityViolations(`const home = ${homedirCall};\n`);
    expect(violations).toEqual([{ label: ["os", ".", "homedir", "()"].join(""), line: 1 }]);
  });

  it("catches tilde home paths to real state locations", () => {
    const content = `const a = "${tildeSynloq}/credentials";\nconst b = "${tildeConfig}";\n`;
    expect(
      findHermeticityViolations(content).map((v: { label: string; line: number }) => v.line),
    ).toEqual([1, 2]);
  });

  it("catches Windows account variables and direct home env reads", () => {
    const content = `const a = "${windowsVar}";\nconst b = ${envRead} ?? "";\n`;
    expect(
      findHermeticityViolations(content).map((v: { label: string; line: number }) => v.line),
    ).toEqual([1, 2]);
  });

  it("does not flag synthetic fixture paths or injected homes", () => {
    const content = [
      'const fixture = "/home/test/.config/opencode/service.json";',
      'const win = "C:\\\\Users\\\\test\\\\AppData";',
      'vi.stubEnv("HOME", directory);',
      'auditLogPath("/home/op/.synloq", "abc123");',
    ].join("\n");
    expect(findHermeticityViolations(content)).toEqual([]);
  });

  it("honors the inline escape hatch with a reason", () => {
    const content = `const home = ${homedirCall}; // ${["allow", "real", "home"].join("-")}: asserted value is stubbed by the host\n`;
    expect(findHermeticityViolations(content)).toEqual([]);
  });
});
