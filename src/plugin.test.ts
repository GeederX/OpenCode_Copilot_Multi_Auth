import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let core: typeof import("./index.js");

beforeEach(async () => {
  vi.resetModules();
  core = await import("./index.js");
  await core.__testExports.saveStorage({ version: 1, accounts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setupPool() {
  const accounts = ["first-token", "second-token"].map((token) => ({
    ...core.__testExports.mergeAccount([], token)[0]!,
    accessToken: token,
    accessTokenExpiresAt: Date.now() + 3_600_000,
  }));
  await core.__testExports.saveStorage({ version: 1, accounts });
  const hooks = await core.CopilotMultiAuthPlugin({} as PluginInput);
  const options = await hooks.auth!.loader!(async () => ({
    type: "oauth", refresh: "unused", access: "unused", expires: 0,
  }), {} as never);
  return { accounts, request: options.fetch as typeof fetch };
}

describe("plugin entry and routing", () => {
  it("exposes only a plugin initializer from the public entry", async () => {
    const entry = await import("./plugin.js");
    expect(Object.keys(entry)).toEqual(["default"]);
    const hooks = await entry.default({} as PluginInput);
    expect(hooks.auth?.provider).toBe("github-copilot");
  });

  it.each([429, 403])("replays requests on the next account after quota status %i", async (status) => {
    const { accounts, request } = await setupPool();
    const network = vi.fn()
      .mockResolvedValueOnce(new Response("quota exceeded", { status, headers: { "retry-after": "10" } }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", network);
    const body = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] });
    const result = await request(new Request("https://example.test/chat/completions", {
      method: "POST", body, headers: { "x-api-key": "remove-me" },
    }));
    expect(await result.text()).toBe("ok");
    expect(network).toHaveBeenCalledTimes(2);
    for (const [index, [, init]] of network.mock.calls.entries()) {
      expect(init.body).toBe(body);
      expect(init.headers.get("authorization")).toBe(`Bearer ${accounts[index].accessToken}`);
      expect(init.headers.get("x-api-key")).toBeNull();
      expect(init.headers.get("x-initiator")).toBe("user");
    }
    expect(core.__testExports.__metrics_get()).toMatchObject({
      attemptsByAccount: { [accounts[0].id]: 1, [accounts[1].id]: 1 },
      successesByAccount: { [accounts[1].id]: 1 },
      failuresByType: { [String(status)]: 1 },
    });
  });

  it("skips an unsupported model and remembers it for later requests", async () => {
    const { accounts, request } = await setupPool();
    const network = vi.fn()
      .mockResolvedValueOnce(new Response("model not available", { status: 404 }))
      .mockImplementation(async () => new Response("ok"));
    vi.stubGlobal("fetch", network);
    const init = { method: "POST", body: JSON.stringify({ model: "test-model" }) };
    await request("https://example.test/chat/completions", init);
    await request("https://example.test/chat/completions", init);
    expect(network).toHaveBeenCalledTimes(3);
    expect(network.mock.calls[2][1].headers.get("authorization")).toBe(`Bearer ${accounts[1].accessToken}`);
  });

  it("returns the last quota response when all accounts are exhausted", async () => {
    const { request } = await setupPool();
    const network = vi.fn().mockImplementation(async () => new Response("quota", { status: 429 }));
    vi.stubGlobal("fetch", network);
    expect((await request("https://example.test/chat/completions")).status).toBe(429);
    expect(network).toHaveBeenCalledTimes(2);
    await expect(request("https://example.test/chat/completions")).rejects.toThrow("unavailable");
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("does not make a network request when the account pool is empty", async () => {
    const { request } = await setupPool();
    await core.__testExports.saveStorage({ version: 1, accounts: [] });
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(request("https://example.test/chat/completions")).rejects.toThrow("No OAuth Copilot accounts");
    expect(network).not.toHaveBeenCalled();
  });

  it("adds agent and vision headers for response requests", async () => {
    const { request } = await setupPool();
    const network = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", network);
    await request(new URL("https://example.test/responses"), {
      method: "POST",
      body: JSON.stringify({ input: [{ role: "assistant", content: [{ type: "input_image" }] }] }),
    });
    expect(network.mock.calls[0][1].headers.get("x-initiator")).toBe("agent");
    expect(network.mock.calls[0][1].headers.get("Copilot-Vision-Request")).toBe("true");
  });
});

describe("account persistence", () => {
  it("refuses corrupt storage without overwriting it during login", async () => {
    const file = join(process.env.OPENCODE_CONFIG_DIR!, "opencode-copilot-multi-auth-accounts.json");
    await writeFile(file, "{broken json");
    core.invalidateStorageCache();
    await expect(core.__testExports.storeOAuthAccount("new-token")).rejects.toThrow("Invalid account storage");
    expect(await readFile(file, "utf8")).toBe("{broken json");
  });

  it("serializes concurrent updates and preserves custom IDs on re-login", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => core.__testExports.storeOAuthAccount(`token-${i}`, { id: `account-${i}` })));
    await core.__testExports.storeOAuthAccount("token-1");
    const stored = await core.__testExports.loadStorage();
    expect(stored.accounts).toHaveLength(5);
    expect(stored.accounts.find((a) => a.tokenHash === core.__testExports.shaTokenId("token-1"))?.id).toBe("account-1");
  });

  it("does not expose cached storage to caller mutations", async () => {
    const storage = await core.__testExports.loadStorage();
    storage.accounts.push(core.__testExports.mergeAccount([], "unsaved")[0]);
    expect((await core.__testExports.loadStorage()).accounts).toEqual([]);
  });

  it("propagates read permission errors instead of treating the pool as empty", async () => {
    core.invalidateStorageCache();
    vi.spyOn(core.__fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(core.__testExports.loadStorage()).rejects.toThrow("denied");
  });
  it("keeps the last persisted state when an atomic rename fails", async () => {
    const accounts = core.__testExports.mergeAccount([], "original-token");
    await core.__testExports.saveStorage({ version: 1, accounts });
    const cached = await core.__testExports.loadStorage();
    cached.accounts = [];
    vi.spyOn(core.__fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(core.__testExports.saveStorage(cached)).rejects.toThrow("disk failure");
    expect((await core.__testExports.loadStorage()).accounts).toEqual(accounts);
  });

  it("creates the temporary token file with owner-only permissions", async () => {
    const write = vi.spyOn(core.__fs, "writeFile");
    await core.__testExports.saveStorage({ version: 1, accounts: [] });
    expect(write.mock.calls[0][2]).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      const file = join(process.env.OPENCODE_CONFIG_DIR!, "opencode-copilot-multi-auth-accounts.json");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("stores a custom account ID in the keychain without a plaintext token in JSON", async () => {
    const network = vi.fn()
      .mockResolvedValueOnce(Response.json({
        verification_uri: "https://example.test/device", user_code: "ABCD", device_code: "device", interval: 1,
      }))
      .mockResolvedValueOnce(Response.json({ access_token: "custom-secret" }));
    vi.stubGlobal("fetch", network);
    const hooks = await core.CopilotMultiAuthPlugin({} as PluginInput);
    const method = hooks.auth!.methods[0];
    if (method.type !== "oauth") throw new Error("Expected OAuth method");
    const flow = await method.authorize({ accountId: "work-main" });
    if (flow.method !== "auto") throw new Error("Expected automatic device flow");
    expect((await flow.callback()).type).toBe("success");
    expect(await core.__testExports.keychainGet("work-main")).toBe("custom-secret");
    const stored = await core.__testExports.loadStorage();
    expect(stored.accounts[0]).toMatchObject({ id: "work-main", refreshToken: "[KEYCHAIN]" });
    const file = join(process.env.OPENCODE_CONFIG_DIR!, "opencode-copilot-multi-auth-accounts.json");
    expect(await readFile(file, "utf8")).not.toContain("custom-secret");
  });

  it("reports login failure when the account cannot be saved", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        verification_uri: "https://example.test/device", user_code: "ABCD", device_code: "device", interval: 1,
      }))
      .mockResolvedValueOnce(Response.json({ access_token: "unsaved-secret" })));
    vi.spyOn(core.__fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    const hooks = await core.CopilotMultiAuthPlugin({} as PluginInput);
    const method = hooks.auth!.methods[0];
    if (method.type !== "oauth") throw new Error("Expected OAuth method");
    const flow = await method.authorize();
    if (flow.method !== "auto") throw new Error("Expected automatic device flow");
    expect((await flow.callback()).type).toBe("failed");
    expect((await core.__testExports.loadStorage()).accounts).toEqual([]);
  });
});

describe("current Copilot transport", () => {
  it("persists the Enterprise login domain and returns it to OpenCode", async () => {
    const network = vi.fn()
      .mockResolvedValueOnce(Response.json({ verification_uri: "https://acme.ghe.com/login/device", user_code: "ABCD", device_code: "device", interval: 1 }))
      .mockResolvedValueOnce(Response.json({ access_token: "enterprise-token" }));
    vi.stubGlobal("fetch", network);
    const hooks = await core.CopilotMultiAuthPlugin({} as PluginInput);
    const method = hooks.auth!.methods[1];
    if (method.type !== "oauth") throw new Error("Expected OAuth method");
    const flow = await method.authorize({ accountId: "corp", enterpriseUrl: "https://ACME.ghe.com/" });
    if (flow.method !== "auto") throw new Error("Expected device flow");
    expect(await flow.callback()).toMatchObject({ type: "success", enterpriseUrl: "acme.ghe.com" });
    expect((await core.__testExports.loadStorage()).accounts[0]).toMatchObject({ id: "corp", enterpriseUrl: "acme.ghe.com", refreshToken: "[KEYCHAIN]" });
    expect(network.mock.calls[0][0]).toBe("https://acme.ghe.com/login/device/code");
    expect(network.mock.calls[1][0]).toBe("https://acme.ghe.com/login/oauth/access_token");
    expect(JSON.parse(network.mock.calls[1][1].body).grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("stops an expired device flow before polling", async () => {
    const network = vi.fn().mockResolvedValue(Response.json({
      verification_uri: "https://example.test/device", user_code: "ABCD", device_code: "device", interval: 1, expires_in: 0,
    }));
    vi.stubGlobal("fetch", network);
    const hooks = await core.CopilotMultiAuthPlugin({} as PluginInput);
    const method = hooks.auth!.methods[0];
    if (method.type !== "oauth") throw new Error("Expected OAuth method");
    const flow = await method.authorize();
    if (flow.method !== "auto") throw new Error("Expected device flow");
    expect(await flow.callback()).toEqual({ type: "failed" });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("routes each account to its own domain without exchanging the OAuth token", async () => {
    const { accounts, request } = await setupPool();
    accounts[0].enterpriseUrl = "acme.ghe.com";
    await core.__testExports.saveStorage({ version: 1, accounts });
    const network = vi.fn()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", network);
    await request("https://api.githubcopilot.com/chat/completions", { method: "POST", body: '{"model":"example"}' });
    expect(network.mock.calls.map(([url]) => url)).toEqual([
      "https://copilot-api.acme.ghe.com/chat/completions", "https://api.githubcopilot.com/chat/completions",
    ]);
    expect(network.mock.calls[0][1].headers.get("authorization")).toBe("Bearer first-token");
    expect(network.mock.calls[0][1].redirect).toBe("error");
  });

  it.each([401, 503])("fails over after HTTP %i without counting it as a success", async (status) => {
    const { accounts, request } = await setupPool();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("failed", { status }))
      .mockResolvedValueOnce(new Response("ok")));
    expect((await request("https://api.githubcopilot.com/responses")).status).toBe(200);
    expect(core.__testExports.__metrics_get()).toMatchObject({
      successesByAccount: { [accounts[1].id]: 1 }, failuresByType: { other: 1 },
    });
    expect(core.__testExports.__metrics_get().successesByAccount[accounts[0].id]).toBeUndefined();
  });

  it("returns a non-retryable HTTP error without recording success", async () => {
    const { request } = await setupPool();
    const network = vi.fn().mockResolvedValue(new Response("bad input", { status: 400 }));
    vi.stubGlobal("fetch", network);
    expect((await request("https://api.githubcopilot.com/responses")).status).toBe(400);
    expect(network).toHaveBeenCalledTimes(1);
    expect(core.__testExports.__metrics_get().successesByAccount).toEqual({});
  });

  it("retries network failures but preserves caller cancellation", async () => {
    const { request } = await setupPool();
    const network = vi.fn().mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", network);
    expect((await request("https://api.githubcopilot.com/responses")).status).toBe(200);
    const controller = new AbortController();
    controller.abort();
    await expect(request(new Request("https://api.githubcopilot.com/responses", { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("keeps upstream agent headers and detects Messages API images", async () => {
    const { request } = await setupPool();
    const network = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", network);
    await request("https://api.githubcopilot.com/v1/messages", {
      method: "POST", headers: { "x-initiator": "agent" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image" }] }] }),
    });
    const headers = network.mock.calls[0][1].headers;
    expect(headers.get("x-initiator")).toBe("agent");
    expect(headers.get("Copilot-Vision-Request")).toBe("true");
  });

  it.each(["http://acme.ghe.com", "https://user:pass@acme.ghe.com", "https://acme.ghe.com/path", "acme.ghe.com?redirect=evil", "acme.ghe.com:444"])("rejects unsafe Enterprise URL %s", (value) => {
    expect(() => core.__testExports.normalizeDomain(value)).toThrow();
  });

  it("handles both Retry-After seconds and HTTP dates", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    expect(core.__testExports.getRetryDelaySeconds(new Response(null, { headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:12 GMT" } }), 90)).toBe(12);
    expect(core.__testExports.getRetryDelaySeconds(new Response(null, { headers: { "Retry-After": "0" } }), 90)).toBe(0);
  });
});
