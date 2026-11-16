import "./source-loader.mjs";

const { CredentialStore } = await import("../../src/config/credentials.ts");
const [root, home, index] = process.argv.slice(2);
process.send("ready");
process.once("message", async () => {
  try {
    const store = new CredentialStore(root, home);
    const role = `role${index}`;
    await store.issue("test", role);
    const shared = await store.ensureCredential("test", "shared");
    const rotated = await store.rotate("test", role);
    if (Number(index) % 2 === 0) await store.revoke("test", role);
    process.send({ shared, role, token: rotated.token }, () => process.disconnect());
  } catch (error) {
    process.send({ error: String(error) }, () => process.disconnect());
    process.exitCode = 1;
  }
});
