# Updating Synloq

Upgrading a stand is three commands — no manual file edits (#116):

```bash
npm install -g synloq@latest        # or: npx synloq@latest …
synloq doctor --upgrade-check       # read-only preview: what will change
synloq init --project-root <project>  # reconciles, migrates, regenerates
```

## What each step does

1. **Install** puts the new compiled runtime on the machine. Nothing running
   changes yet: live channels keep their current processes until restarted.
2. **`doctor --upgrade-check`** opens the stand database **read-only** and
   reports:
   - `fresh-install` — no database yet; just run `init`;
   - `current` — schema already matches this binary;
   - `pending` — the schema migration that will run on the next write open
     (migrations are forward-only, additive, and automatic);
   - `newer` — the database was written by a newer release; upgrade the
     package first (fail-loud, nothing is touched).
     The command never writes: it is safe on a live stand.
3. **`synloq init`** is the single upgrade command. On an existing stand it
   reuses credentials, reconciles team state with the manifest, migrates the
   database forward, and regenerates channel configs. Its `nextStep` output
   says whether the host client needs an Install/Update action for the
   plugin (Kimi Work) or a channel restart (other hosts).

## After upgrading

- Restart the role channels (or the host client) so every channel runs the
  new build. Mixed-format stands keep working during rolling upgrades:
  envelope-based parsing accepts frames from older and newer builds.
- `synloq doctor --project-root <project>` confirms health;
  `synloq status --project-root <project>` shows per-role state.

## Downgrades

Database migrations are forward-only. A binary older than the database
schema refuses to open it with an explicit `unsupported SQLite user_version`
error — there is no silent fallback. To go back, restore a copy of the
stand's database and home directory taken before the upgrade.
