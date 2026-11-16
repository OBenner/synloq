import { SynloqError } from "../domain/errors.js";

interface Section {
  keys: string[];
  start: number;
  end: number;
  array: boolean;
}
const invalid = () =>
  new SynloqError("INVALID_INPUT", "Codex config has ambiguous or unsupported TOML ownership");
const prefix = (a: string[], b: string[]) =>
  a.length <= b.length && a.every((key, i) => key === b[i]);

/** Parse only TOML keys; values are scanned lexically, never reserialized. */
function keys(source: string): { keys: string[]; rest: string } {
  const result: string[] = [];
  let rest = source.trimStart();
  for (;;) {
    const token = /^(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')/.exec(rest)?.[0];
    if (!token) throw invalid();
    try {
      result.push(
        token.startsWith('"')
          ? (JSON.parse(
              token.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex: string) =>
                String.fromCodePoint(parseInt(hex, 16)),
              ),
            ) as string)
          : token.startsWith("'")
            ? token.slice(1, -1)
            : token,
      );
    } catch {
      throw invalid();
    }
    rest = rest.slice(token.length).trimStart();
    if (!rest.startsWith(".")) return { keys: result, rest };
    rest = rest.slice(1).trimStart();
  }
}

/** Identify real table headers, ignoring lookalikes in strings, arrays, and comments. */
function sections(text: string, owner: string[]): Section[] {
  const result: Section[] = [];
  let table: string[] = [];
  let quote: '"' | "'" | '"""' | "'''" | undefined;
  let depth = 0;
  let offset = 0;
  const seen = new Set<string>();
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const trimmed = line.trimStart();
    if (!quote && depth === 0 && trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const parsed = keys(trimmed.slice(array ? 2 : 1));
      const close = array ? "]]" : "]";
      if (
        !parsed.rest.startsWith(close) ||
        !/^\s*(?:#[^\r\n]*)?\s*$/.test(parsed.rest.slice(close.length))
      )
        throw invalid();
      table = parsed.keys;
      if (prefix(owner, table)) {
        const id = JSON.stringify(table);
        if (array || seen.has(id)) throw invalid();
        seen.add(id);
      }
      if (result.length) result[result.length - 1]!.end = offset;
      result.push({ keys: table, start: offset, end: text.length, array });
      offset += line.length;
      continue;
    }
    if (!quote && depth === 0 && trimmed.trim() !== "" && !trimmed.startsWith("#")) {
      const assignment = keys(trimmed);
      if (!assignment.rest.startsWith("=")) throw invalid();
      const path = [...table, ...assignment.keys];
      // An inline/dotted definition outside our table would overlap its ownership.
      if (!prefix(owner, table) && (prefix(owner, path) || prefix(path, owner))) throw invalid();
    }
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (quote) {
        if (quote.startsWith('"') && char === "\\") {
          i++;
          continue;
        }
        if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          quote = undefined;
        } else if ((char === "\n" || char === "\r") && quote.length === 1) throw invalid();
        continue;
      }
      if (char === "#") break;
      if (char === '"' || char === "'") {
        quote = line.startsWith(char.repeat(3), i) ? (char.repeat(3) as '"""' | "'''") : char;
        i += quote.length - 1;
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") {
        depth--;
        if (depth < 0) throw invalid();
      }
    }
    offset += line.length;
  }
  if (quote || depth !== 0) throw invalid();
  return result;
}

export function ownedCodexConfig(text: string, agentId: string) {
  const owner = ["mcp_servers", `synloq-${agentId}`];
  const owned = sections(text, owner).filter((section) => prefix(owner, section.keys));
  const ranges = owned.map((section) => ({
    start: section.start,
    end: section.start + text.slice(section.start, section.end).trimEnd().length,
  }));
  return {
    text: ranges.map(({ start, end }) => text.slice(start, end)).join("\n"),
    replace(replacement: string): string {
      if (!ranges.length)
        return replacement
          ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${replacement}`
          : text;
      let result = "";
      let cursor = 0;
      for (const [index, range] of ranges.entries()) {
        result += text.slice(cursor, range.start);
        if (index === 0) result += replacement.trimEnd();
        cursor = range.end;
      }
      return result + text.slice(cursor);
    },
  };
}
