# Role memory template

Copy these sections into the two files under `docs/local/<role>/` in your
project. Keep the destination ignored by Git. Replace placeholders with short
summaries and reference by thread ID, message ID, issue link, or commit hash.
See the [role memory convention](../conventions/role-memory.md).

## decisions-log.md

```markdown
# <Role> — decisions log

## D-<YYYY-MM-DD>-01 — <decision title>

- Decision: <outcome and constraint>
- Next action: <owner and action>
- Ref: <thread ID, issue, or commit>

## I-<YYYY-MM-DD>-01 — <incident title>

- Observed: <symptom and status>
- Next action: <owner and action>
- Ref: <incident issue or thread ID>

## S-<YYYY-MM-DD>-01 — <handoff title>

- Progress: <durable result or current blocker>
- Next action: <owner and action>
- Ref: <thread ID, issue, or commit>
```

## open-loops.md

```markdown
# <Role> — open loops (updated <YYYY-MM-DD>)

## Now

- <YYYY-MM-DD> — <next action and owner> (<thread ID or issue>)

## Waiting

- <YYYY-MM-DD> — <person or dependency needed> (<thread ID or issue>)

## Blocked

- <YYYY-MM-DD> — <blocker and what resolves it> (<thread ID or issue>)
```
