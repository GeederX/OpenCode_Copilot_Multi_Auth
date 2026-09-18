import { createHash } from "node:crypto";
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
  refreshToken: string; // GitHub OAuth refresh token (long-term, ~6 months)
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
const USER_AGENT = "opencode-copilot-multi-auth/0.4.0";
const DEFAULT_COOLDOWN_SECONDS = 90;
const DEFAULT_MAX_ATTEMPTS = 10;
const TOKEN_REFRESH_MARGIN_SECONDS = 60; // Refresh token 1 minute before expiry

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
  refresh: { success: 0, fail: 0 },
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

function recordRefreshSuccess() {
  metrics.refresh.success += 1;
}

function recordRefreshFail() {
  metrics.refresh.fail += 1;
}

function getMetricsSnapshot() {
  return {
    attemptsByAccount: Object.fromEntries(metrics.attemptsByAccount.entries()),
    successesByAccount: Object.fromEntries(
      metrics.successesByAccount.entries(),
    ),
    failuresByType: { ...metrics.failuresByType },
    refresh: { ...metrics.refresh },
  };
}

function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
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
    accessToken,
    accessTokenExpiresAt,
    priority,
    enabled,
    addedAt,
    modelRule: normalizeModelRule(raw.modelRule),
  };
}

function normalizeStorage(raw: unknown): StorageShape {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) {
    return { version: 1, accounts: [] };
  }

  const accounts = raw.accounts
    .map((item) => normalizeStoredAccount(item))
    .filter((item): item is StoredAccount => !!item);

  return {
    version: 1,
    accounts,
  };
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
    const mod = await import("keytar");
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
  opts?: { id?: string; name?: string; priority?: number },
) {
  const tokenDerivedID = shaTokenId(refreshToken);
  const providedID = normalizeAccountID(opts?.id);
  const id = providedID || tokenDerivedID;
  const existingIndex = accounts.findIndex(
    (acc) =>
      acc.id === id ||
      acc.id === tokenDerivedID ||
      acc.refreshToken === refreshToken,
  );

  const candidate: StoredAccount = {
    id,
    name: opts?.name?.trim() || `copilot-${id.slice(0, 6)}`,
    refreshToken,
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
    id,
    refreshToken,
    name: existing.name || candidate.name,
    // Clear cached access token when refresh token is updated
    accessToken: undefined,
    accessTokenExpiresAt: undefined,
  };

  log(`Updating account: ${merged.name} (${merged.id})`);
  return accounts.map((acc, idx) => (idx === existingIndex ? merged : acc));
}

// In-memory cache to avoid hot-path disk I/O. Lazy-loaded on first access.
let storageCache: { value: StorageShape; loadedAt: number } | null = null;
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
  metrics.refresh = { success: 0, fail: 0 };
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
  // Return cached value when available and fresh
  if (
    storageCache &&
    Date.now() - storageCache.loadedAt < STORAGE_CACHE_TTL_MS
  ) {
    return storageCache.value;
  }

  const filePath = getStorageFilePath();
  const raw = await __fs.readFile(filePath, "utf8").catch(() => "");
  // Ensure parsed always has the exact StorageShape type (avoid widening numeric literal and empty array types)
  const parsed = raw
    ? normalizeStorage(parseJson<unknown>(raw))
    : normalizeStorage(undefined);

  storageCache = { value: parsed, loadedAt: Date.now() };
  return parsed;
}

// Atomic save: write to temp file in same dir then rename to final path.
async function saveStorage(storage: StorageShape): Promise<void> {
  const filePath = getStorageFilePath();
  await __fs.mkdir(dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contents = JSON.stringify(storage, null, 2);

  try {
    await __fs.writeFile(tempPath, contents, "utf8");
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
    throw err;
  } finally {
    // Update in-memory cache to reflect latest persisted storage
    storageCache = { value: storage, loadedAt: Date.now() };
  }
}

async function upsertOAuthToken(refreshToken: string): Promise<void> {
  if (!refreshToken.trim()) return;
  // Prefer storing refresh tokens in keychain when available.
  // If keychain write fails, fall back to file storage with restricted perms.
  const storage = await loadStorage();
  const updated = mergeAccount(storage.accounts, refreshToken);

  // Attempt to store secret in keychain per-account; use derived id
  const id = shaTokenId(refreshToken);
  const keychainOk = await keychainSet(id, refreshToken).catch(() => false);
  if (keychainOk) {
    // Remove raw refresh token from storage and keep placeholder
    const sanitized = updated.map((acc) => ({
      ...acc,
      refreshToken: acc.id === id ? "[KEYCHAIN]" : acc.refreshToken,
    }));
    storage.accounts = sanitized;
  } else {
    // fallback: store full token in file storage but ensure perms and warn
    storage.accounts = updated;
    try {
      const filePath = getStorageFilePath();
      await chmod(dirname(filePath), 0o700).catch(() => undefined);
      // Note: file itself will be written by saveStorage and created with user's umask
    } catch {}
  }

  await saveStorage(storage);
}

/**
 * Get or refresh a valid OAuth access token for a Copilot account.
 * GitHub OAuth tokens are short-lived (1 hour), so we cache and refresh as needed.
 */
async function getValidAccessToken(account: StoredAccount): Promise<string> {
  const now = Date.now() / 1000; // seconds
  const expiresAt = (account.accessTokenExpiresAt ?? 0) / 1000;
  const timeUntilExpiry = expiresAt - now;

  // Prefer a cached valid access token (with safety margin)
  if (account.accessToken && timeUntilExpiry > TOKEN_REFRESH_MARGIN_SECONDS) {
    return account.accessToken;
  }

  log(
    `No valid cached access token for account ${account.name} (${account.id}), attempting refresh`,
    "info",
  );

  // Attempt refresh flow using stored refresh token.
  // We expect the token endpoint to accept a refresh_token grant and return { access_token, expires_in }
  async function refreshAccessToken(
    refreshToken: string,
  ): Promise<{ access: string; expiresIn: number }> {
    const urls = getUrls("github.com");
    try {
      const res = await fetch(urls.ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      const body = await res
        .clone()
        .json()
        .catch(() => ({}));

      if (!res.ok) {
        // Distinguish invalid_grant (non-recoverable) vs transient errors
        const err = typeof body.error === "string" ? body.error : undefined;
        if (res.status === 400 && err === "invalid_grant") {
          const e = new Error("invalid_grant");
          (e as any).code = "invalid_grant";
          throw e;
        }
        const e = new Error("token_refresh_failed");
        (e as any).status = res.status;
        throw e;
      }

      const access =
        typeof body.access_token === "string" ? body.access_token : undefined;
      const expiresIn =
        typeof body.expires_in === "number" ? body.expires_in : undefined;

      if (!access) {
        const e = new Error("token_refresh_no_access_token");
        throw e;
      }

      return { access, expiresIn: expiresIn ?? 3600 };
    } catch (err) {
      // Re-throw to be handled by caller
      throw err;
    }
  }

  // If we don't have a refresh token, we cannot refresh -> explicit error to force re-auth
  if (!account.refreshToken || !account.refreshToken.trim()) {
    const e = new Error("no_refresh_token");
    (e as any).code = "no_refresh_token";
    throw e;
  }

  try {
    // If the refresh token is stored as placeholder, try reading from keychain
    let refreshToUse = account.refreshToken;
    if (refreshToUse === "[KEYCHAIN]") {
      const fromKeychain = await keychainGet(account.id).catch(() => null);
      if (fromKeychain) refreshToUse = fromKeychain;
    }

    let result;
    try {
      result = await refreshAccessToken(refreshToUse);
      recordRefreshSuccess();
    } catch (err) {
      recordRefreshFail();
      throw err;
    }

    // Persist new access token and expiry
    const storage = await loadStorage();
    const accountIndex = storage.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex >= 0) {
      storage.accounts[accountIndex].accessToken = result.access;
      storage.accounts[accountIndex].accessTokenExpiresAt =
        Date.now() + result.expiresIn * 1000;
      await saveStorage(storage);
    }

    return result.access;
  } catch (err: any) {
    // For invalid_grant or missing refresh token, surface explicit error so caller can force re-auth
    if (err && err.code === "invalid_grant") {
      log(
        `Refresh failed with invalid_grant for account ${account.id}`,
        "error",
      );
      const e = new Error("invalid_grant");
      (e as any).code = "invalid_grant";
      throw e;
    }

    // For other errors, treat as transient and rethrow so caller may try other accounts
    log(
      `Refresh failed for account ${account.id}: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
    throw err;
  }
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

  const numeric = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return fallbackSeconds;
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
  if (request instanceof Request) {
    const mergedHeaders = new Headers(request.headers);
    if (init?.headers) {
      const next = new Headers(init.headers);
      for (const [k, v] of next.entries()) mergedHeaders.set(k, v);
    }

    const method = init?.method ?? request.method;
    const shouldReadBody = method !== "GET" && method !== "HEAD";
    let body: BodyInit | undefined = (init?.body ?? undefined) as
      | BodyInit
      | undefined;
    if (init?.body === null) body = undefined;
    if (body === undefined && shouldReadBody) {
      body = await request.clone().text();
    }

    return {
      url: request.url,
      init: {
        ...init,
        method,
        headers: mergedHeaders,
        body,
      },
    };
  }

  return {
    url: request instanceof URL ? request.href : request.toString(),
    init: {
      ...init,
      headers: new Headers(init?.headers),
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
    };

    return {
      url: deviceData.verification_uri,
      instructions: `Enter code: ${deviceData.user_code}`,
      method: "auto" as const,
      async callback() {
        while (true) {
          const response = await fetch(urls.ACCESS_TOKEN_URL, {
            method: "POST",
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
              `OAuth authorization successful, storing refresh token`,
              "info",
            );

            try {
              // On new authorization, attempt to store secret in keychain first.
              const derivedId = shaTokenId(data.access_token);
              const storageAccountID = accountID || derivedId;
              const kcOk = await keychainSet(
                storageAccountID,
                data.access_token,
              ).catch(() => false);
              const storage = await loadStorage();
              storage.accounts = mergeAccount(
                storage.accounts,
                data.access_token,
                { id: accountID },
              );

              if (kcOk) {
                // Replace raw token with placeholder for security
                storage.accounts = storage.accounts.map((acc) =>
                  acc.id === storageAccountID
                    ? { ...acc, refreshToken: "[KEYCHAIN]" }
                    : acc,
                );
              }

              await saveStorage(storage);
              log(
                `Successfully saved account to local storage (${storage.accounts.length} total accounts)`,
                "info",
              );
            } catch (err) {
              log(
                `Failed to save account to local storage: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
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
              deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS,
            );
            continue;
          }

          if (data.error === "slow_down") {
            const serverInterval = data.interval;
            const interval =
              serverInterval &&
              Number.isFinite(serverInterval) &&
              serverInterval > 0
                ? serverInterval
                : deviceData.interval + 5;
            await sleep(interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS);
            continue;
          }

          return { type: "failed" as const };
        }
      },
    };
  }

  return {
    auth: {
      // Override the built-in GitHub Copilot auth transport rather than
      // registering a new provider id with no model catalog behind it.
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth();
        if (!info || info.type !== "oauth") return {};

        const enterpriseUrl = (info as { enterpriseUrl?: string })
          .enterpriseUrl;
        const baseURL = enterpriseUrl
          ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
          : undefined;

        return {
          baseURL,
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
              `Request: ${replayable.url} (model=${modelID}, agent=${isAgent}, vision=${isVision})`,
            );

            const excluded = new Set<string>();
            const maxAttempts = Math.max(
              1,
              Math.min(DEFAULT_MAX_ATTEMPTS, accounts.length),
            );

            let lastResponse: Response | undefined;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              const selected = pickAccount(accounts, modelID, excluded);
              // record attempt metric for selected account (if any)
              recordAttempt(selected?.id);
              if (!selected) {
                log(`No available accounts after ${attempt} attempts`, "warn");
                break;
              }

              // Get valid access token (may refresh from refresh token)
              let accessToken: string;
              try {
                accessToken = await getValidAccessToken(selected);
              } catch (err) {
                log(
                  `Auth refresh failed for account ${selected.name}: ${err instanceof Error ? err.message : String(err)}`,
                  "warn",
                );
                excluded.add(selected.id);
                continue;
              }

              const headers = new Headers(replayable.init.headers);
              headers.set("x-initiator", isAgent ? "agent" : "user");
              headers.set("User-Agent", USER_AGENT);
              headers.set("Authorization", `Bearer ${accessToken}`);
              headers.set("Openai-Intent", "conversation-edits");
              headers.delete("x-api-key");

              if (isVision) headers.set("Copilot-Vision-Request", "true");

              log(
                `Attempt ${attempt + 1}/${maxAttempts}: Using account ${selected.name}`,
              );
              const response = await fetch(replayable.url, {
                ...replayable.init,
                headers,
              });

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
                recordSuccess(selected.id);
                log(`Success: Request completed (status=${response.status})`);
                return response;
              }

              recordFailure(response.status);
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
            throw new Error(
              "All Copilot accounts are unavailable for this request.",
            );
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
                  const url = value.includes("://")
                    ? new URL(value)
                    : new URL(`https://${value}`);
                  if (!url.hostname)
                    return "Please enter a valid URL or domain";
                  return undefined;
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)";
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
      ] as any,
    },
  };
};

export const __testExports = {
  getOpencodeConfigDirectory,
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
    metrics.refresh = { success: 0, fail: 0 };
  },
};

export default CopilotMultiAuthPlugin;
