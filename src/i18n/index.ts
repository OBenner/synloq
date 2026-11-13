import { z } from "zod";
import { en, type I18nKey } from "./locales/en.js";
import { ru } from "./locales/ru.js";

export const SUPPORTED_LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export const languageSchema = z.enum(SUPPORTED_LANGUAGES);

const dictionaries: Record<Language, Record<I18nKey, string>> = { en, ru };

export type I18nParams = Record<string, string | number>;

/**
 * Translate a dictionary key, substituting {named} placeholders. A key
 * missing from the requested locale falls back to English and reports through
 * onFallback (parity is CI-enforced, so this is defensive).
 */
export function translate(
  language: Language,
  key: I18nKey,
  params: I18nParams = {},
  onFallback?: (key: I18nKey) => void,
): string {
  let template = dictionaries[language][key] as string | undefined;
  if (template === undefined) {
    onFallback?.(key);
    template = en[key];
  }
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export type { I18nKey } from "./locales/en.js";
