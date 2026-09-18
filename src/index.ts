import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

type ModelRule = {
  allowlist?: string[];
  blocklist?: string[];
};

type StoredAccount = {
  id: string;
  name: string;
  refreshToken: string; // Legacy field name: the GitHub OAuth access token, not a refresh grant.
  enterpriseUrl?: string;
  tokenHash?: string;
  accessToken?: string; // Cached OAuth access token
  accessTokenExpiresAt?: number; // Timestamp when access token expires
  priority: number;
  enabled: boolean;
  modelRule: ModelRule;
  addedAt: number;
};

type StorageShape = {
  version: 1;
  accounts: StoredAccount[];
};

type RuntimeAccount = StoredAccount;

const CLIENT_ID = "Ov23li8tweQw6odWQebz";
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
const USER_AGENT = "opencode-copilot-multi-auth/0.5.0";
const DEFAULT_COOLDOWN_SECONDS = 90;
const DEFAULT_MAX_ATTEMPTS = 10;

const LOG_LEVEL_PRIORITY = {
  info: 10,
  warn: 20,
  error: 30,
} as const;
type LogLevel = keyof typeof LOG_LEVEL_PRIORITY;
const DEFAULT_LOG_LEVEL: LogLevel = "warn";
const CONFIGURED_LOG_LEVEL =
  ((
    process.env.COPILOT_MULTI_AUTH_LOG_LEVEL || ""
  ).toLowerCase() as LogLevel) || DEFAULT_LOG_LEVEL;
const ACTIVE_LOG_LEVEL: LogLevel = LOG_LEVEL_PRIORITY[CONFIGURED_LOG_LEVEL]
  ? CONFIGURED_LOG_LEVEL
  : DEFAULT_LOG_LEVEL;

const cooldownUntilByAccount = new Map<string, number>();
const usageCountByAccount = new Map<string, number>();
const unsupportedModelsByAccount = new Map<string, Set<string>>();
// Observability metrics (in-memory)
const metrics = {
  attemptsByAccount: new Map<string, number>(),
  successesByAccount: new Map<string, number>(),
  failuresByType: { "429": 0, "403": 0, other: 0 } as Record<string, number>,
};

const STRUCTURED_LOGS =
  (process.env.COPILOT_MULTI_AUTH_STRUCTURED_LOGS || "").toLowerCase() ===
    "1" ||
  (process.env.COPILOT_MULTI_AUTH_STRUCTURED_LOGS || "").toLowerCase() ===
    "json";

// Simple logger
function log(message: string, level: LogLevel = "info"): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[ACTIVE_LOG_LEVEL]) return;
  const timestamp = new Date().toISOString();
  if (STRUCTURED_LOGS) {
    // Emit a compact JSON line to stderr for structured logging
    try {
      const out = JSON.stringify({
        ts: timestamp,
        service: "copilot-multi-auth",
        level,
        message,
      });
      console.error(out);
      return;
    } catch {
      // fallback to legacy format
    }
  }

  const prefix = `[${timestamp}] [copilot-multi-auth] [${level.toUpperCase()}]`;
  console.error(`${prefix} ${message}`); // Use stderr for logs
}

// Metrics helpers
function recordAttempt(accountId: string | undefined) {
  if (!accountId) return;
  metrics.attemptsByAccount.set(
    accountId,
    (metrics.attemptsByAccount.get(accountId) || 0) + 1,
  );
}

function recordSuccess(accountId: string | undefined) {
  if (!accountId) return;
  metrics.successesByAccount.set(
    accountId,
    (metrics.successesByAccount.get(accountId) || 0) + 1,
  );
}

function recordFailure(status: number) {
  if (status === 429) metrics.failuresByType["429"] += 1;
  else if (status === 403) metrics.failuresByType["403"] += 1;
  else metrics.failuresByType.other += 1;
}

function getMetricsSnapshot() {
  return {
    attemptsByAccount: Object.fromEntries(metrics.attemptsByAccount.entries()),
    successesByAccount: Object.fromEntries(
      metrics.successesByAccount.entries(),
    ),
    failuresByType: { ...metrics.failuresByType },
  };
}

function normalizeDomain(value: string): string {
  const url = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !url.hostname) {
    throw new Error("Enter an HTTPS domain without credentials, port, path, query, or fragment");
  }
  return url.hostname.toLowerCase();
}

function accountBaseURL(account: Pick<StoredAccount, "enterpriseUrl">): string {
  return account.enterpriseUrl
    ? `https://copilot-api.${normalizeDomain(account.enterpriseUrl)}`
    : "https://api.githubcopilot.com";
}

function routeRequestURL(value: string, account: StoredAccount): string {
  const url = new URL(value);
  const base = new URL(accountBaseURL(account));
  url.protocol = base.protocol;
  url.host = base.host;
  url.username = "";
  url.password = "";
  return url.href;
}

function getUrls(domain: string) {
  // Ensure domain is not empty and properly normalized
  const safeDomain = domain.trim() || "github.com";
  return {
    DEVICE_CODE_URL: `https://${safeDomain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${safeDomain}/login/oauth/access_token`,
  };
}

function getOpencodeConfigDirectory() {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }

  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "opencode");
  }

  return join(homedir(), ".config", "opencode");
}

function getStorageFilePath() {
  return join(
    getOpencodeConfigDirectory(),
    "opencode-copilot-multi-auth-accounts.json",
  );
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function shaTokenId(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (item): item is string => typeof item === "string",
  );
  return result.length > 0 ? result : undefined;
}

function normalizeModelRule(raw: unknown): ModelRule {
  if (!isRecord(raw)) return {};
  return {
    allowlist: toStringArray(raw.allowlist),
    blocklist: toStringArray(raw.blocklist),
  };
}

function normalizeStoredAccount(raw: unknown): StoredAccount | undefined {
  if (!isRecord(raw)) return undefined;
  // Accept either new refreshToken or legacy token field
  const refreshToken =
    typeof raw.refreshToken === "string"
      ? raw.refreshToken.trim()
      : typeof raw.token === "string"
        ? raw.token.trim()
        : "";
  if (!refreshToken) return undefined;

  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : shaTokenId(refreshToken);
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : `copilot-${id.slice(0, 6)}`;
  const priority =
    typeof raw.priority === "number" && Number.isFinite(raw.priority)
      ? raw.priority
      : 100;
  const enabled = raw.enabled !== false;
  const addedAt =
    typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt)
      ? raw.addedAt
      : Date.now();

  const accessToken =
    typeof raw.accessToken === "string" ? raw.accessToken : undefined;
  const accessTokenExpiresAt =
    typeof raw.accessTokenExpiresAt === "number"
      ? raw.accessTokenExpiresAt
      : undefined;

  return {
    id,
    name,
    refreshToken,
    enterpriseUrl: typeof raw.enterpriseUrl === "string" && raw.enterpriseUrl
      ? normalizeDomain(raw.enterpriseUrl) : undefined,
    tokenHash: typeof raw.tokenHash === "string" ? raw.tokenHash : undefined,
    accessToken,
    accessTokenExpiresAt,
    priority,
    enabled,
    addedAt,
    modelRule: normalizeModelRule(raw.modelRule),
  };
}

function normalizeStorage(raw: unknown): StorageShape {
  if (!isRecord(raw) || !Array.isArray(raw.accounts) ||
      (raw.version !== undefined && raw.version !== 1)) {
    throw new Error("Invalid account storage; repair or restore the file before logging in");
  }
  const accounts = raw.accounts.map(normalizeStoredAccount);
  if (accounts.some((account) => !account) || new Set(accounts.map((a) => a!.id)).size !== accounts.length) {
    throw new Error("Invalid or duplicate account in storage; refusing to discard existing data");
  }
  return { version: 1, accounts: accounts as StoredAccount[] };
}

// Keychain abstraction: prefer OS keychain via keytar when available.
const KEYCHAIN_SERVICE = "opencode-copilot-multi-auth";
let keychainInitialized = false;
let keychainAvailableFlag = false;
let keytarModule: any = null;

async function initKeychain(): Promise<void> {
  if (keychainInitialized) return;
  keychainInitialized = true;

  // Test overrides for unit tests / CI
  if (process.env.COPILOT_FORCE_NO_KEYCHAIN === "1") {
    keychainAvailableFlag = false;
    return;
  }

  if (process.env.COPILOT_FAKE_KEYCHAIN === "1") {
    // simple in-memory fake keychain for tests
    if (!(globalThis as any).__fake_keychain_map)
      (globalThis as any).__fake_keychain_map = new Map<string, string>();
    keychainAvailableFlag = true;
    keytarModule = {
      getPassword: async (_service: string, account: string) =>
        (globalThis as any).__fake_keychain_map.get(account) ?? null,
      setPassword: async (
        _service: string,
        account: string,
        password: string,
      ) => {
        (globalThis as any).__fake_keychain_map.set(account, password);
        return true;
      },
      deletePassword: async (_service: string, account: string) =>
        (globalThis as any).__fake_keychain_map.delete(account) ? true : false,
    };
    return;
  }

  try {
    // Attempt dynamic import of keytar
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const imported = await import("keytar");
    const mod = imported.default ?? imported;
    if (mod && typeof mod.getPassword === "function") {
      keytarModule = mod;
      keychainAvailableFlag = true;
    }
  } catch {
    keychainAvailableFlag = false;
  }
}

async function keychainSet(accountId: string, token: string): Promise<boolean> {
  await initKeychain();
  if (!keychainAvailableFlag || !keytarModule) return false;
  try {
    await keytarModule.setPassword(KEYCHAIN_SERVICE, accountId, token);
    return true;
  } catch {
    return false;
  }
}

async function keychainGet(accountId: string): Promise<string | null> {
  await initKeychain();
  if (!keychainAvailableFlag || !keytarModule) return null;
  try {
    return await keytarModule.getPassword(KEYCHAIN_SERVICE, accountId);
  } catch {
    return null;
  }
}

async function keychainDelete(accountId: string): Promise<boolean> {
  await initKeychain();
  if (!keychainAvailableFlag || !keytarModule) return false;
  try {
    return await keytarModule.deletePassword(KEYCHAIN_SERVICE, accountId);
  } catch {
    return false;
  }
}

function normalizeAccountID(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function mergeAccount(
  accounts: StoredAccount[],
  refreshToken: string,
  opts?: { id?: string; name?: string; priority?: number; enterpriseUrl?: string },
) {
  const tokenDerivedID = shaTokenId(refreshToken);
  const providedID = normalizeAccountID(opts?.id);
  const id = providedID || tokenDerivedID;
  const existingIndex = accounts.findIndex(
    (acc) =>
      acc.id === id ||
      acc.id === tokenDerivedID ||
      acc.refreshToken === refreshToken || acc.tokenHash === tokenDerivedID,
  );

  const candidate: StoredAccount = {
    id,
    name: opts?.name?.trim() || `copilot-${id.slice(0, 6)}`,
    refreshToken,
    tokenHash: tokenDerivedID,
    enterpriseUrl: opts?.enterpriseUrl,
    priority: Number.isFinite(opts?.priority)
      ? (opts?.priority as number)
      : 100,
    enabled: true,
    modelRule: {},
    addedAt: Date.now(),
  };

  if (existingIndex < 0) {
    log(`Adding new account: ${candidate.name} (${candidate.id})`);
    return [...accounts, candidate];
  }

  const existing = accounts[existingIndex];
  const merged: StoredAccount = {
    ...existing,
    id: providedID || existing.id,
    refreshToken,
    tokenHash: tokenDerivedID,
    enterpriseUrl: opts?.enterpriseUrl,
    name: existing.name || candidate.name,
    // Clear cached access token when refresh token is updated
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
  };

  log(`Updating account: ${merged.name} (${merged.id})`);
  return accounts.map((acc, idx) => (idx === existingIndex ? merged : acc));
}

// In-memory cache to avoid hot-path disk I/O. Lazy-loaded on first access.
let storageCache: { value: StorageShape; loadedAt: number; filePath: string } | null = null;
const STORAGE_CACHE_TTL_MS = Number(
  process.env.COPILOT_STORAGE_CACHE_TTL_MS || 5000,
);

export function invalidateStorageCache() {
  storageCache = null;
}

function resetRuntimeState() {
  invalidateStorageCache();
  cooldownUntilByAccount.clear();
  usageCountByAccount.clear();
  unsupportedModelsByAccount.clear();
  metrics.attemptsByAccount.clear();
  metrics.successesByAccount.clear();
  metrics.failuresByType = { "429": 0, "403": 0, other: 0 };
  keychainInitialized = false;
  keychainAvailableFlag = false;
  keytarModule = null;
  if ((globalThis as any).__fake_keychain_map instanceof Map) {
    (globalThis as any).__fake_keychain_map.clear();
  }
}

// Wrap fs/promises functions so tests can replace them when needed without complex module mocking.
export const __fs = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
};

async function loadStorage(): Promise<StorageShape> {
  const filePath = getStorageFilePath();
  if (storageCache?.filePath === filePath &&
      Date.now() - storageCache.loadedAt < STORAGE_CACHE_TTL_MS) {
    return structuredClone(storageCache.value);
  }
  let parsed: StorageShape;
  try {
    const raw = await __fs.readFile(filePath, "utf8");
    parsed = normalizeStorage(parseJson<unknown>(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    parsed = { version: 1, accounts: [] };
  }
  storageCache = { value: parsed, loadedAt: Date.now(), filePath };
  return structuredClone(parsed);
}

// Every production mutation reads the latest file while holding an inter-process lock.
async function updateStorage(update: (storage: StorageShape) => Promise<void>): Promise<void> {
  const filePath = getStorageFilePath();
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(filePath, {
    realpath: false,
    stale: 10_000,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 500 },
    onCompromised: (error) => { compromised = error; },
  });
  try {
    invalidateStorageCache();
    const storage = await loadStorage();
    await update(storage);
    if (compromised) throw compromised;
    await saveStorage(storage);
  } finally {
    await release();
  }
}

// Atomic save: write to temp file in same dir then rename to final path.
async function saveStorage(storage: StorageShape): Promise<void> {
  const filePath = getStorageFilePath();
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contents = JSON.stringify(storage, null, 2);

  try {
    await __fs.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await __fs.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await __fs.rename(tempPath, filePath);
    // Best-effort hardening: final file readable/writable only by owner.
    try {
      await __fs.chmod(filePath, 0o600).catch(() => undefined);
    } catch {}
  } catch (err) {
    // Best-effort cleanup of temp file
    try {
      await __fs.unlink(tempPath).catch(() => undefined);
    } catch {}
    // Callers may have mutated the cached object before attempting the save.
    // Reload the last persisted state after a failed write.
    invalidateStorageCache();
    throw err;
  }
  // Only cache a successful write.
  storageCache = { value: structuredClone(storage), loadedAt: Date.now(), filePath };
}

async function storeOAuthAccount(token: string, opts: { id?: string; enterpriseUrl?: string } = {}): Promise<void> {
  if (!token.trim() || token === "[KEYCHAIN]") throw new Error("Missing OAuth credential");
  const enterpriseUrl = opts.enterpriseUrl ? normalizeDomain(opts.enterpriseUrl) : undefined;
  await updateStorage(async (storage) => {
    const accounts = mergeAccount(storage.accounts, token, { ...opts, enterpriseUrl });
    const account = accounts.find((item) => item.tokenHash === shaTokenId(token))!;
    if (await keychainSet(account.id, token)) account.refreshToken = "[KEYCHAIN]";
    // Older versions persisted cached access tokens. New writes never duplicate this secret.
    for (const item of accounts) {
      delete item.accessToken;
      delete item.accessTokenExpiresAt;
    }
    storage.accounts = accounts;
  });
}

/** GitHub device OAuth tokens are used directly, matching OpenCode's Copilot transport. */
async function getValidAccessToken(account: StoredAccount): Promise<string> {
  const token = account.refreshToken === "[KEYCHAIN]"
    ? await keychainGet(account.id)
    : account.refreshToken;
  if (!token?.trim() || token === "[KEYCHAIN]") {
    throw new Error("Missing OAuth credential; log in to this account again");
  }
  return token;
}

function modelAllowedByRule(
  modelID: string | undefined,
  rule: ModelRule,
): boolean {
  if (!modelID) return true;
  const model = modelID.toLowerCase();
  const allow = rule.allowlist?.some((item) =>
    model.includes(item.toLowerCase()),
  );
  const block = rule.blocklist?.some((item) =>
    model.includes(item.toLowerCase()),
  );

  if (block) return false;
  if (rule.allowlist && rule.allowlist.length > 0) return !!allow;
  return true;
}

function isModelUnsupportedForAccount(
  modelID: string | undefined,
  accountID: string,
): boolean {
  if (!modelID) return false;
  const models = unsupportedModelsByAccount.get(accountID);
  if (!models) return false;
  return models.has(modelID.toLowerCase());
}

function markModelUnsupportedForAccount(
  modelID: string | undefined,
  accountID: string,
): void {
  if (!modelID) return;
  const key = modelID.toLowerCase();
  const models = unsupportedModelsByAccount.get(accountID) ?? new Set<string>();
  models.add(key);
  unsupportedModelsByAccount.set(accountID, models);
}

function pickAccount(
  accounts: RuntimeAccount[],
  modelID: string | undefined,
  excluded: Set<string>,
): RuntimeAccount | undefined {
  const now = Date.now();
  const candidates = accounts.filter((acc) => {
    if (!acc.enabled) {
      return false;
    }
    if (excluded.has(acc.id)) {
      return false;
    }
    if (!modelAllowedByRule(modelID, acc.modelRule)) {
      return false;
    }
    if (isModelUnsupportedForAccount(modelID, acc.id)) {
      return false;
    }

    const cooldownUntil = cooldownUntilByAccount.get(acc.id) || 0;
    if (cooldownUntil > now) {
      return false;
    }

    return true;
  });

  const sorted = candidates.sort((a, b) => {
    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;

    const usageA = usageCountByAccount.get(a.id) || 0;
    const usageB = usageCountByAccount.get(b.id) || 0;
    return usageA - usageB;
  });

  const selected = sorted[0];
  if (selected) {
    const usage = usageCountByAccount.get(selected.id) || 0;
    const modelInfo = modelID ? ` for model ${modelID}` : "";
    log(
      `Selected account: ${selected.name} (priority=${selected.priority}, usage=${usage})${modelInfo}`,
    );
  }

  return selected;
}

function getRetryDelaySeconds(
  response: Response,
  fallbackSeconds: number,
): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallbackSeconds;

  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : fallbackSeconds;
}

async function isQuotaOrRateLimit(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status >= 500) return false;
  if (response.status !== 403) return false;

  const text = await response
    .clone()
    .text()
    .catch(() => "");
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("exhaust") ||
    lower.includes("capacity")
  );
}

async function isModelUnavailableError(response: Response): Promise<boolean> {
  if (![400, 403, 404].includes(response.status)) return false;

  const text = await response
    .clone()
    .text()
    .catch(() => "");
  const lower = text.toLowerCase();
  const hasModelWord = lower.includes("model");
  if (!hasModelWord) return false;

  return (
    lower.includes("not found") ||
    lower.includes("not available") ||
    lower.includes("unsupported") ||
    lower.includes("does not exist") ||
    lower.includes("ineligible")
  );
}

async function prepareReplayableRequest(
  request: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; init: RequestInit }> {
  const merged = new Request(request, init);
  return {
    url: merged.url,
    init: {
      method: merged.method,
      headers: new Headers(merged.headers),
      body: merged.body ? await merged.clone().text() : undefined,
      signal: merged.signal,
      redirect: "error",
    },
  };
}

function detectModelFromRequestBody(init: RequestInit): string | undefined {
  if (typeof init.body !== "string") return undefined;
  const payload = parseJson<Record<string, unknown>>(init.body);
  if (!payload) return undefined;

  if (typeof payload.model === "string") return payload.model;
  if (isRecord(payload.request) && typeof payload.request.model === "string")
    return payload.request.model;
  return undefined;
}

function detectInitiatorAndVision(
  url: string,
  bodyText: string | undefined,
): { isAgent: boolean; isVision: boolean } {
  if (!bodyText) return { isAgent: false, isVision: false };
  const body = parseJson<Record<string, unknown>>(bodyText);
  if (!body) return { isAgent: false, isVision: false };

  try {
    if (Array.isArray(body.messages) && url.includes("completions")) {
      const last = body.messages[body.messages.length - 1] as
        | Record<string, unknown>
        | undefined;
      const isVision = body.messages.some((msg) => {
        if (!isRecord(msg) || !Array.isArray(msg.content)) return false;
        return msg.content.some(
          (part) => isRecord(part) && part.type === "image_url",
        );
      });
      return { isVision, isAgent: last?.role !== "user" };
    }

    if (Array.isArray(body.messages)) {
      const last = body.messages.at(-1);
      const hasUserContent = isRecord(last) && last.role === "user" &&
        (typeof last.content === "string" || (Array.isArray(last.content) &&
          last.content.some((part) => isRecord(part) && part.type !== "tool_result")));
      const hasImage = (value: unknown): boolean => Array.isArray(value) && value.some((part) =>
        isRecord(part) && (part.type === "image" || (part.type === "tool_result" && hasImage(part.content))));
      return { isAgent: !hasUserContent, isVision: body.messages.some((msg) => isRecord(msg) && hasImage(msg.content)) };
    }

    if (Array.isArray(body.input)) {
      const last = body.input[body.input.length - 1] as
        | Record<string, unknown>
        | undefined;
      const isVision = body.input.some((item) => {
        if (!isRecord(item) || !Array.isArray(item.content)) return false;
        return item.content.some(
          (part) => isRecord(part) && part.type === "input_image",
        );
      });
      return { isVision, isAgent: last?.role !== "user" };
    }
  } catch {
    return { isAgent: false, isVision: false };
  }

  return { isAgent: false, isVision: false };
}

export const CopilotMultiAuthPlugin: Plugin = async (
  _input: PluginInput,
): Promise<Hooks> => {
  async function startDeviceOAuth(
    domain: string,
    isEnterprise: boolean,
    accountID?: string,
  ) {
    log(
      `Starting OAuth device flow for ${isEnterprise ? `GitHub Enterprise (${domain})` : "GitHub.com"}`,
      "info",
    );

    const urls = getUrls(domain);

    const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        scope: "read:user",
      }),
    });

    if (!deviceResponse.ok) {
      log(
        `Failed to initiate device authorization: ${deviceResponse.status} ${deviceResponse.statusText}`,
        "error",
      );
      throw new Error("Failed to initiate device authorization");
    }

    const deviceData = (await deviceResponse.json()) as {
      verification_uri: string;
      user_code: string;
      device_code: string;
      interval: number;
      expires_in?: number;
    };

    const deadline = Date.now() + (deviceData.expires_in ?? 900) * 1000;
    let interval = Math.max(1, deviceData.interval || 5);
    return {
      url: deviceData.verification_uri,
      instructions: `Enter code: ${deviceData.user_code}`,
      method: "auto" as const,
      async callback() {
        while (Date.now() < deadline) {
          const response = await fetch(urls.ACCESS_TOKEN_URL, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "User-Agent": USER_AGENT,
            },
            body: JSON.stringify({
              client_id: CLIENT_ID,
              device_code: deviceData.device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
          });

          if (!response.ok) return { type: "failed" as const };

          const data = (await response.json()) as {
            access_token?: string;
            error?: string;
            interval?: number;
          };

          if (data.access_token) {
            log(
              `OAuth authorization successful, storing account credential`,
              "info",
            );

            try {
              await storeOAuthAccount(data.access_token, {
                id: accountID,
                enterpriseUrl: isEnterprise ? domain : undefined,
              });
              const storage = await loadStorage();
              log(
                `Successfully saved account to local storage (${storage.accounts.length} total accounts)`,
                "info",
              );
            } catch (err) {
              log(
                `Failed to save account to local storage: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
              return { type: "failed" as const };
            }

            const result: {
              type: "success";
              refresh: string;
              access: string;
              expires: number;
              enterpriseUrl?: string;
            } = {
              type: "success",
              refresh: data.access_token,
              access: data.access_token,
              expires: 0,
            };

            if (isEnterprise) {
              result.enterpriseUrl = domain;
            }

            return result;
          }

          if (data.error === "authorization_pending") {
            await sleep(
              interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS,
            );
            continue;
          }

          if (data.error === "slow_down") {
            const serverInterval = data.interval;
            interval =
              serverInterval &&
              Number.isFinite(serverInterval) &&
              serverInterval > 0
                ? serverInterval
                : interval + 5;
            await sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
            continue;
          }

          return { type: "failed" as const };
        }
        return { type: "failed" as const };
      },
    };
  }

  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        // Import a pre-existing built-in login only when no pool has been configured.
        if (!(await loadStorage()).accounts.length && info.refresh) {
          await storeOAuthAccount(info.refresh, { enterpriseUrl: info.enterpriseUrl });
        }
        return {
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const storage = await loadStorage();
            const accounts = storage.accounts.filter(
              (acc) => !!acc.refreshToken && acc.enabled !== false,
            );
            if (!accounts.length) {
              log(
                "No enabled OAuth Copilot accounts found. Please run auth login first.",
                "error",
              );
              throw new Error(
                "No OAuth Copilot accounts found. Please run auth login first.",
              );
            }

            const replayable = await prepareReplayableRequest(request, init);
            const modelID = detectModelFromRequestBody(replayable.init);
            const { isAgent, isVision } = detectInitiatorAndVision(
              replayable.url,
              typeof replayable.init.body === "string"
                ? replayable.init.body
                : undefined,
            );

            log(
              `Request: ${new URL(replayable.url).pathname} (model=${modelID}, agent=${isAgent}, vision=${isVision})`,
            );

            const excluded = new Set<string>();
            const maxAttempts = Math.max(
              1,
              Math.min(DEFAULT_MAX_ATTEMPTS, accounts.length),
            );

            let lastResponse: Response | undefined;
            let lastError: Error | undefined;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              replayable.init.signal?.throwIfAborted();
              const selected = pickAccount(accounts, modelID, excluded);
              // record attempt metric for selected account (if any)
              recordAttempt(selected?.id);
              if (!selected) {
                log(`No available accounts after ${attempt} attempts`, "warn");
                break;
              }

              // Resolve the OAuth credential locally; never send a refresh grant.
              let accessToken: string;
              try {
                accessToken = await getValidAccessToken(selected);
              } catch {
                recordFailure(401);
                lastError = new Error("An account credential is unavailable; log in again");
                log(`Credential unavailable for account ${selected.id}; trying next account`, "warn");
                excluded.add(selected.id);
                continue;
              }

              const headers = new Headers(replayable.init.headers);
              if (!headers.has("x-initiator")) headers.set("x-initiator", isAgent ? "agent" : "user");
              headers.set("User-Agent", USER_AGENT);
              headers.set("Authorization", `Bearer ${accessToken}`);
              headers.set("Openai-Intent", "conversation-edits");
              headers.set("X-GitHub-Api-Version", "2026-06-01");
              headers.delete("x-api-key");

              if (isVision) headers.set("Copilot-Vision-Request", "true");

              log(
                `Attempt ${attempt + 1}/${maxAttempts}: Using account ${selected.name}`,
              );
              let response: Response;
              try {
                response = await fetch(routeRequestURL(replayable.url, selected), {
                  ...replayable.init, headers,
                });
              } catch {
                replayable.init.signal?.throwIfAborted();
                recordFailure(0);
                lastError = new Error("Copilot network request failed for all eligible accounts");
                excluded.add(selected.id);
                cooldownUntilByAccount.set(selected.id, Date.now() + 10_000);
                continue;
              }
              if (lastResponse) await lastResponse.body?.cancel().catch(() => undefined);
              lastResponse = response;
              if (!response.ok) recordFailure(response.status);
              if (response.status === 401 || response.status >= 500) {
                excluded.add(selected.id);
                cooldownUntilByAccount.set(selected.id, Date.now() + DEFAULT_COOLDOWN_SECONDS * 1000);
                continue;
              }

              const modelUnavailable = await isModelUnavailableError(response);
              if (modelUnavailable) {
                log(
                  `Model ${modelID} not available for account ${selected.name}, trying next account`,
                  "warn",
                );
                markModelUnsupportedForAccount(modelID, selected.id);
                excluded.add(selected.id);
                lastResponse = response;
                continue;
              }

              const quotaLimited = await isQuotaOrRateLimit(response);
              if (!quotaLimited) {
                usageCountByAccount.set(
                  selected.id,
                  (usageCountByAccount.get(selected.id) || 0) + 1,
                );
                if (response.ok) recordSuccess(selected.id);
                log(`Request completed (status=${response.status})`);
                return response;
              }

              log(
                `Quota/rate-limit hit for account ${selected.name} (status=${response.status}), trying next account`,
                "warn",
              );
              lastResponse = response;
              excluded.add(selected.id);

              const retrySec = getRetryDelaySeconds(
                response,
                DEFAULT_COOLDOWN_SECONDS,
              );
              cooldownUntilByAccount.set(
                selected.id,
                Date.now() + retrySec * 1000,
              );
              log(`Account ${selected.name} in cooldown for ${retrySec}s`);
            }

            if (lastResponse) {
              log(
                `All accounts exhausted, returning last response (status=${lastResponse.status})`,
                "warn",
              );
              return lastResponse;
            }
            log(
              "All Copilot accounts are unavailable for this request.",
              "error",
            );
            throw lastError ?? new Error("All Copilot accounts are unavailable for this request.");
          },
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Login / Add GitHub.com Account",
          prompts: [
            {
              type: "text",
              key: "accountId",
              message: "Account ID (optional)",
              placeholder: "work-main",
              validate: (value: string) => {
                if (!value || !value.trim()) return undefined;
                if (!/^[A-Za-z0-9._-]{3,64}$/.test(value.trim())) {
                  return "Use 3-64 chars: letters, numbers, dot, underscore, hyphen";
                }
                return undefined;
              },
            },
          ],
          async authorize(inputs: Record<string, string> = {}) {
            const accountID = normalizeAccountID(inputs.accountId);
            return startDeviceOAuth("github.com", false, accountID);
          },
        },
        {
          type: "oauth",
          label: "Login / Add GitHub Enterprise Account",
          prompts: [
            {
              type: "text",
              key: "accountId",
              message: "Account ID (optional)",
              placeholder: "corp-main",
              validate: (value: string) => {
                if (!value || !value.trim()) return undefined;
                if (!/^[A-Za-z0-9._-]{3,64}$/.test(value.trim())) {
                  return "Use 3-64 chars: letters, numbers, dot, underscore, hyphen";
                }
                return undefined;
              },
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              validate: (value: string) => {
                if (!value || !value.trim()) return "URL or domain is required";
                try {
                  normalizeDomain(value);
                  return undefined;
                } catch {
                  return "Enter an HTTPS domain without credentials, port, path, query, or fragment";
                }
              },
            },
          ],
          async authorize(inputs: Record<string, string> = {}) {
            const domain = normalizeDomain(inputs.enterpriseUrl || "");
            if (!domain) {
              throw new Error("Enterprise URL is required");
            }
            const accountID = normalizeAccountID(inputs.accountId);
            return startDeviceOAuth(domain, true, accountID);
          },
        },
      ],
    },
  };
};

export const __testExports = {
  getOpencodeConfigDirectory,
  normalizeDomain,
  routeRequestURL,
  storeOAuthAccount,
  getRetryDelaySeconds,
  modelAllowedByRule,
  pickAccount,
  isQuotaOrRateLimit,
  isModelUnavailableError,
  mergeAccount,
  shaTokenId,
  unsupportedModelsByAccount,
  markModelUnsupportedForAccount,
  isModelUnsupportedForAccount,
  getValidAccessToken,
  keychainSet,
  keychainGet,
  log,
  // Test-only helpers
  __fs,
  loadStorage,
  saveStorage,
  resetRuntimeState,
  // Observability exports for tests/debug (no secrets)
  __metrics_get: getMetricsSnapshot,
  __metrics_reset: () => {
    metrics.attemptsByAccount.clear();
    metrics.successesByAccount.clear();
    metrics.failuresByType = { "429": 0, "403": 0, other: 0 };
    },
};

export default CopilotMultiAuthPlugin;
