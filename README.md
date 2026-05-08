# opencode-copilot-multi-auth

An OpenCode plugin that adds GitHub Copilot multi-account routing with automatic failover.

## What This Plugin Does

- Manages a local Copilot account pool and automatically rotates accounts per request.
- Switches to another account when quota/rate-limit errors occur.
- Skips accounts that do not support the requested model.
- Applies manual routing strategy controls: `priority`, `enabled`, and `modelRule`.
- Supports both GitHub.com and GitHub Enterprise login flows.

This is not only manual priority ordering. It is automatic account-pool rotation with configurable routing rules.

## Features

- **Account-pool rotation**: retry on another account when one fails.
- **Quota/rate-limit failover**: detects 429 and common quota-like 403 errors.
- **Model-aware routing**: respects allow/block rules and temporary per-account model unavailability.
- **Priority + balancing**: lower `priority` wins; ties use lower usage count.
- **Enable/disable accounts**: toggle `enabled` in JSON without restarting OpenCode.
- **Token handling**: stores refresh token metadata and caches runtime access tokens.
- **Custom account ID on login**: optionally set a human-readable account ID.

## Install

```bash
npm install -g @geeder/opencode-copilot-multi-auth@0.4.0
```

Add to `opencode.json`:

```json
{
  "plugin": ["@geeder/opencode-copilot-multi-auth@0.4.0"]
}
```

### Option C: via opencode plugin install (recommended)

```bash
opencode plugin install @geeder/opencode-copilot-multi-auth@0.4.0
```

```json
{
  "plugin": [
    "file:///C:/Users/<you>/.config/opencode/plugins/opencode-copilot-multi-auth-local"
  ]
}
```

## Authentication Flow

Run:

```bash
opencode auth login
```

Choose provider `GitHub Copilot`, then choose one method:

- `Login / Add GitHub.com Account`
  - Prompts `Account ID (optional)`
  - Uses `github.com` automatically (no enterprise URL prompt)
- `Login / Add GitHub Enterprise Account`
  - Prompts `Account ID (optional)`
  - Prompts `Enterprise URL or domain` (required)

Run login multiple times to add more accounts.

## Account Storage

Accounts are stored in:

- `$OPENCODE_CONFIG_DIR/opencode-copilot-multi-auth-accounts.json` when `OPENCODE_CONFIG_DIR` is set
- otherwise `$XDG_CONFIG_HOME/opencode/opencode-copilot-multi-auth-accounts.json` when `XDG_CONFIG_HOME` is set
- otherwise `~/.config/opencode/opencode-copilot-multi-auth-accounts.json`

Example:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "work-main",
      "name": "copilot-work",
      "refreshToken": "gho_xxxxxxxxxxxx...",
      "accessToken": "gho_xxxxxxxxxxxx...",
      "accessTokenExpiresAt": 1700000000000,
      "priority": 100,
      "enabled": true,
      "modelRule": {
        "allowlist": [],
        "blocklist": []
      },
      "addedAt": 1694000000000
    }
  ]
}
```

### Important Rules

- `priority`: lower number means higher priority.
- `enabled`: `false` excludes account from selection.
- `modelRule.allowlist`: only these models are allowed for the account.
- `modelRule.blocklist`: these models are excluded for the account.

## Model Rules (modelRule)

The `modelRule` field controls which models can use each account. It has two settings:

### allowlist (allowedModels)

If `allowlist` is **not empty**, only those models can use this account:

```json
"modelRule": {
  "allowlist": ["gpt-4o", "gpt-4-turbo"],
  "blocklist": []
}
```

This account will **only** handle requests for `gpt-4o` or `gpt-4-turbo`. Other models will skip this account.

### blocklist (deniedModels)

If `blocklist` is **not empty**, those models **cannot** use this account:

```json
"modelRule": {
  "allowlist": [],
  "blocklist": ["o1", "o1-preview"]
}
```

This account will handle all models **except** `o1` and `o1-preview`.

### No restrictions

Leave both empty to allow all models:

```json
"modelRule": {
  "allowlist": [],
  "blocklist": []
}
```

### How it works

1. If `allowlist` is not empty: only allowlist models are permitted
2. If `blocklist` is not empty: blocklist models are denied
3. If both are empty: all models are allowed
4. If both have values: allowlist is checked first, then blocklist is applied

When a model request comes in, the plugin skips any account whose model rules don't permit it and rotates to the next eligible account.

### Real-world example

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "work-gpt4",
      "name": "copilot-work-tier1",
      "refreshToken": "gho_xxxx...",
      "priority": 10,
      "enabled": true,
      "modelRule": {
        "allowlist": ["gpt-4o", "gpt-4-turbo"],
        "blocklist": []
      }
    },
    {
      "id": "personal-all",
      "name": "copilot-personal",
      "refreshToken": "gho_yyyy...",
      "priority": 20,
      "enabled": true,
      "modelRule": {
        "allowlist": [],
        "blocklist": []
      }
    },
    {
      "id": "test-no-o1",
      "name": "copilot-test",
      "refreshToken": "gho_zzzz...",
      "priority": 30,
      "enabled": true,
      "modelRule": {
        "allowlist": [],
        "blocklist": ["o1", "o1-preview"]
      }
    }
  ]
}
```

In this setup:

- `gpt-4o` request → tries `work-gpt4` (allowed) → falls back to `personal-all` or `test-no-o1`
- `o1` request → skips `work-gpt4` and `test-no-o1` → only uses `personal-all`
- `gpt-3.5-turbo` request → skips `work-gpt4` → uses `personal-all` or `test-no-o1`

## Account ID and Deduplication

- If `Account ID` is provided during login, it is used as `id`.
- If omitted, the plugin auto-generates an ID from a token hash.
- Re-login updates existing accounts instead of duplicating them when matched by:
  - provided `id`, or
  - token-derived ID, or
  - same `refreshToken`.

## Logging

Logs are sent to stderr and prefixed with `[copilot-multi-auth]`.

Default log level is `warn` (to avoid noisy output).

Set log level with env var:

```bash
COPILOT_MULTI_AUTH_LOG_LEVEL=info
```

Supported levels: `info`, `warn`, `error`.

Structured logs and metrics

- Enable structured JSON logs (newline-delimited JSON) by setting:

```bash
COPILOT_MULTI_AUTH_STRUCTURED_LOGS=json
```

- Basic in-memory metrics are available for inspection in tests via exported helpers (no secrets exposed):
  - \_\_metrics_get() -> snapshot of current counters
  - \_\_metrics_reset() -> reset counters (test-only)

Metrics tracked:

- attemptsByAccount: number of request attempts per account id
- successesByAccount: successful responses per account id
- failuresByType: counters for 429, 403, other
- refresh: { success, fail }

These metrics are intentionally in-memory and ephemeral; they are intended for debugging and tests only.

## Notes

- **Provider ID**: `github-copilot-multi` (overrides the built-in `github-copilot`)
- Cooldown after quota hit uses `Retry-After` when present, otherwise defaults to 90 seconds.
- Maximum retry attempts are bounded by account count and internal cap.
- Maximum retry attempts are bounded by account count and internal cap.

## Security behavior (keychain vs fallback)

This plugin prefers to store sensitive refresh tokens in the operating system credential store (Keychain on macOS, Windows Credential Manager, or libsecret on Linux) when available. The plugin attempts a dynamic import of `keytar` and writes tokens keyed by a derived account ID.

Fallback file storage: when OS keychain is not available or writing to it fails, the plugin stores tokens in the JSON file under your config directory. File storage is a worst-case fallback and carries additional risks:

- The JSON file is written atomically (write to temp file then rename) to avoid partial writes.
- The plugin attempts best-effort hardening: it sets directory permissions to 0700 and the final file to 0600 when possible. These operations are best-effort and may fail on some filesystems or platforms.
- Filesystem-based storage is less secure than an OS keychain. If an attacker gains local access to your account or a backup containing this file, refresh tokens may be exfiltrated.

Operational model summary:

- Preferred path: keychain available -> refresh token stored in OS keychain, JSON uses `[KEYCHAIN]` placeholder.
- Fallback path: keychain unavailable/fails -> token stored in JSON with atomic writes and permission hardening best-effort.

Migration: On login or when reading an account whose `refreshToken` equals the placeholder `[KEYCHAIN]`, the plugin will attempt to read the real token from the OS keychain and use it for refresh operations. When possible, new tokens are moved into the keychain and the JSON is sanitized to avoid plaintext secrets.

Environment variables for testing and behavior:

- `COPILOT_FORCE_NO_KEYCHAIN=1` — force-disable keychain usage (useful in CI)
- `COPILOT_FAKE_KEYCHAIN=1` — use an in-memory fake keychain for tests

## Optional OS keychain dependency (keytar)

This plugin will try to use the optional native module `keytar` to store refresh tokens in the
operating system credential store (macOS Keychain, Windows Credential Manager, libsecret on Linux).

When to install

- Operators who run this plugin on developer machines or servers with a secure OS keyring
  should install `keytar` to improve security and keep refresh tokens out of local files.

How to install

- Globally via npm: `npm install -g keytar`
- Locally in your environment: `npm i --no-save keytar`

Behavior when keytar is missing

- The plugin does a dynamic import of `keytar`. If it is not installed or fails to load,
  the plugin falls back to storing refresh tokens in the JSON config file under your
  config directory. The file storage is written atomically and the plugin attempts to set
  restrictive directory permissions (700), but filesystem-based storage is less secure.

CI and testing

- In CI environments you may prefer NOT to install native modules. Use `COPILOT_FORCE_NO_KEYCHAIN=1`
  to force the plugin to skip keychain attempts. Tests may set `COPILOT_FAKE_KEYCHAIN=1` to use an
  in-memory fake keychain for deterministic behavior.

Security recommendation

- Prefer installing `keytar` on machines you control to reduce exposure of long-lived refresh tokens.

NEVER log secrets. The plugin never prints refresh/access tokens to logs.

## Coverage

- We run tests with coverage in CI and upload the coverage report as an artifact named `coverage-report`.
  -- Locally run: `npm run test:coverage` (this uses Vitest coverage and outputs `coverage/` with lcov and text reports).

Coverage gate policy:

- CI enforces minimum global thresholds to avoid silent regressions.
- Current minimums: statements 45%, lines 45%, functions 70%, branches 50%.
- If a change drops coverage below thresholds, either add tests or adjust thresholds with clear technical justification.
