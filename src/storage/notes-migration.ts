import { NOTE_KEY_MAX } from "./notes-store.js";

export interface MemoryFileNote {
  key: string;
  body: string;
}

/**
 * Migration path from M1 per-role memory files (#21) into relay notes (#22).
 * The M1 convention keys memory by markdown heading, so the mechanical mapping
 * is: every `## <heading>` starts one note whose key is the heading text and
 * whose body is everything up to the next heading. Front matter and the H1
 * title are dropped. Keys longer than the note key bound are truncated; empty
 * sections are skipped. Runs offline against a file the operator supplies —
 * nothing is read from real user state implicitly.
 */
export function notesFromMemoryFile(markdown: string): MemoryFileNote[] {
  const notes: MemoryFileNote[] = [];
  let currentKey: string | undefined;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentKey === undefined) return;
    const body = currentBody.join("\n").trim();
    if (body === "") return;
    notes.push({ key: currentKey, body });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentKey = heading[1]!.slice(0, NOTE_KEY_MAX);
      currentBody = [];
      continue;
    }
    // Skip the H1 title and front matter before the first section.
    if (currentKey === undefined) continue;
    currentBody.push(line);
  }
  flush();
  return notes;
}
