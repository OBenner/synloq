import { describe, expect, it } from "vitest";
import { translate } from "../../src/i18n/index.js";
import { en, type I18nKey } from "../../src/i18n/locales/en.js";
import { ru } from "../../src/i18n/locales/ru.js";

const locales = { en, ru } as const;

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]!).sort();
}

describe("i18n dictionaries", () => {
  it("every locale provides exactly the English key set", () => {
    const keys = Object.keys(en).sort();
    for (const [name, dictionary] of Object.entries(locales)) {
      expect(Object.keys(dictionary).sort(), `locale ${name}`).toEqual(keys);
    }
  });

  it("every locale keeps placeholder parity per key", () => {
    for (const key of Object.keys(en) as I18nKey[]) {
      for (const [name, dictionary] of Object.entries(locales)) {
        expect(placeholders(dictionary[key]), `locale ${name}, key ${key}`).toEqual(
          placeholders(en[key]),
        );
      }
    }
  });

  it("substitutes named placeholders and leaves unknown ones intact", () => {
    expect(translate("en", "role.id", { agentId: "cto" })).toBe("Role ID: cto");
    expect(translate("ru", "role.id", { agentId: "cto" })).toBe("ID роли: cto");
    expect(translate("en", "role.id", {})).toBe("Role ID: {agentId}");
  });

  it("falls back to English and reports when a locale key is missing", () => {
    const original: string = ru["role.intro"];
    const missing: I18nKey[] = [];
    try {
      // Simulate a drifted locale; the parity tests above guard against this
      // ever happening in the shipped dictionaries.
      delete (ru as Partial<Record<I18nKey, string>>)["role.intro"];
      const value = translate("ru", "role.intro", {}, (key) => missing.push(key));
      expect(value).toBe(en["role.intro"]);
      expect(missing).toEqual(["role.intro"]);
    } finally {
      (ru as Record<I18nKey, string>)["role.intro"] = original;
    }
  });
});
