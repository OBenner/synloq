import { describe, expect, it } from "vitest";
import { notesFromMemoryFile } from "../../src/storage/notes-migration.js";

const memoryFile = `# Role memory: cto
<!--
  Template header that is not a note.
-->
## Decisions
- 2026-11-12: picked relay-side notes (issue #22).
- 2026-11-13: retention aligned with #4.

## Open loops
- #92 OpenCode backend-retry: waiting for dev2.

## Empty section

## Incidents
- 2026-11-16: NOT_WRITER live catch, fixed in #86.
`;

describe("notesFromMemoryFile (M1 → #22 migration)", () => {
  it("maps each H2 heading to one note and drops front matter", () => {
    const notes = notesFromMemoryFile(memoryFile);
    expect(notes.map((note) => note.key)).toEqual(["Decisions", "Open loops", "Incidents"]);
    expect(notes[0]!.body).toContain("picked relay-side notes");
    expect(notes[1]!.body).toContain("#92 OpenCode backend-retry");
    expect(notes[0]!.body).not.toContain("Template header");
  });

  it("skips empty sections and tolerates CRLF", () => {
    const notes = notesFromMemoryFile("# T\r\n\r\n## A\r\nbody\r\n## B\r\n\r\n");
    expect(notes).toEqual([{ key: "A", body: "body" }]);
  });
});
