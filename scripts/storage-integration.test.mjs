import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("independent processes do not lose concurrent account updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-process-test-"));
  const moduleURL = new URL("../dist/index.js", import.meta.url).href;
  try {
    await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      const code = `import { __testExports as t } from ${JSON.stringify(moduleURL)};
        await t.storeOAuthAccount('fixture-token-' + process.argv[1], { id: 'account-' + process.argv[1] });`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, String(index)], {
        env: { ...process.env, OPENCODE_CONFIG_DIR: directory, COPILOT_FORCE_NO_KEYCHAIN: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errors = "";
      child.stderr.on("data", (data) => { errors += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(errors || `Child exit ${code}`)));
    })));
    const stored = JSON.parse(await readFile(join(directory, "opencode-copilot-multi-auth-accounts.json"), "utf8"));
    assert.equal(stored.accounts.length, 6);
    assert.equal(new Set(stored.accounts.map((account) => account.id)).size, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the built package exposes only a callable plugin entry", async () => {
  const plugin = await import("@geeder/opencode-copilot-multi-auth");
  assert.deepEqual(Object.keys(plugin), ["default"]);
  assert.equal((await plugin.default({})).auth.provider, "github-copilot");
});
