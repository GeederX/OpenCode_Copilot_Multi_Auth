import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Tests must never read a developer's real account pool or OS keychain.
const configDirectory = mkdtempSync(join(tmpdir(), "copilot-multi-auth-test-"));
vi.stubEnv("OPENCODE_CONFIG_DIR", configDirectory);
vi.stubEnv("COPILOT_FORCE_NO_KEYCHAIN", "0");
vi.stubEnv("COPILOT_FAKE_KEYCHAIN", "1");

afterAll(() => {
  rmSync(configDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
