import "./source-loader.mjs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// Stop at publication after the actual temp write, sync and close have finished.
fs.rename = async () => {
  process.send("before-rename");
  await new Promise(() => {});
};
syncBuiltinESMExports();
process.on("message", () => {}); // Keep IPC alive until the parent kills us.
const { writeTextAtomic } = await import("../../src/config/atomic-file.ts");
await writeTextAtomic(process.argv[2], '{"next":true}\n');
