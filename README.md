# @geeder/opencode-copilot-multi-auth

An OpenCode plugin that adds GitHub Copilot multi-account routing with automatic failover.

Maintained fork: [GeederX/OpenCode_Copilot_Multi_Auth](https://github.com/GeederX/OpenCode_Copilot_Multi_Auth).
The npm package for this fork is [`@geeder/opencode-copilot-multi-auth`](https://www.npmjs.com/package/@geeder/opencode-copilot-multi-auth).
The original author's MIT copyright notice is retained in `LICENSE`.

> This checkout prepares `0.5.0` and targets OpenCode `1.18.31`. The currently
> published npm version is still `0.4.0`; use the local build to test these fixes
> until the new release is published. See [release setup](RELEASING.md).

## What This Plugin Does

- Manages a local Copilot account pool and automatically rotates accounts per request.
- Switches to another account when quota/rate-limit errors occur.
- Skips accounts that do not support the requested model.
- Applies manual routing strategy controls: `priority`, `enabled`, and `modelRule`.
- Provides GitHub.com and GitHub Enterprise device-login methods with per-account domains.

This is not only manual priority ordering. It is automatic account-pool rotation with configurable routing rules.

## Features

- **Account-pool rotation**: retry on another account when one fails.
- **Quota/rate-limit failover**: detects 429 and common quota-like 403 errors.
- **Model-aware routing**: respects allow/block rules and per-account model unavailability remembered until restart.
- **Priority + balancing**: lower `priority` wins; ties use lower usage count.
- **Enable/disable accounts**: toggle `enabled` in JSON without restarting OpenCode.
- **Token handling**: uses GitHub device OAuth tokens directly, with optional OS keychain storage.
- **Custom account ID on login**: optionally set a human-readable account ID.

## Install

Development and CI support Node.js 22.12+, 24, and 26+. OpenCode 1.18.31 is the integration target.

### Published npm version

Add this fork's package to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@geeder/opencode-copilot-multi-auth@0.4.0"]
}
```

OpenCode installs configured npm plugins at startup. A global npm installation is
not required. See the [official plugin installation guide](https://opencode.ai/docs/plugins/).
Remove the previous author's package from your plugin list to avoid loading both forks.
The configuration above selects the published release, not changes in this checkout.

### Local development

```bash
git clone https://github.com/GeederX/OpenCode_Copilot_Multi_Auth.git
cd OpenCode_Copilot_Multi_Auth
npm ci
npm run check
```

To try the local build, create a JavaScript file in your project's `.opencode/plugins/`
directory that re-exports the built plugin. Replace the example path with the absolute
path to your checkout:

```js
export { default } from "file:///absolute/path/OpenCode_Copilot_Multi_Auth/dist/plugin.js";
```

Use either the local plugin file or the npm configuration, and restart OpenCode after
rebuilding. Local plugin files are loaded automatically, as described in the official guide.

## Authentication Flow

Run:

```bash
opencode auth login
```

Choose provider `GitHub Copilot`, then choose one of the plugin's login methods.
The plugin overrides the built-in `github-copilot` authentication transport:

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

The `refreshToken` property is retained for compatibility with older account files.
Despite its name, it contains the **GitHub OAuth access token**, or `[KEYCHAIN]`.
It is used directly for Copilot requests and is never sent as an OAuth refresh grant.
Old cached `accessToken`/`accessTokenExpiresAt` fields are ignored and removed on login.
Enterprise accounts additionally store `enterpriseUrl`, for example `company.ghe.com`.
Legacy Enterprise accounts without that field must log in again so their domain is known.

### Important Rules

- `priority`: lower number means higher priority.
- `enabled`: `false` excludes account from selection.
- `modelRule.allowlist`: only these models are allowed for the account.
- `modelRule.blocklist`: these models are excluded for the account.

## Model Rules (modelRule)

The `modelRule` field controls which models can use each account. Rules use case-insensitive substring matching, not exact model IDs or regular expressions. It has two settings:

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

- `gpt-4o` request -> tries `work-gpt4` (allowed) -> falls back to `personal-all` or `test-no-o1`
- `o1` request -> skips `work-gpt4` and `test-no-o1` -> only uses `personal-all`
- `gpt-3.5-turbo` request -> skips `work-gpt4` -> uses `personal-all` or `test-no-o1`

## Account ID and Deduplication

- If `Account ID` is provided during login, it is used as `id`.
- If omitted for a new token, the plugin generates an ID from its hash. Re-login preserves an existing custom ID.
- Re-login updates existing accounts instead of duplicating them when matched by:
  - provided `id`, or
  - token-derived ID or stored token fingerprint, or
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
- failuresByType: counters for 429, 403, other (including credential and network failures)

These metrics are intentionally in-memory and ephemeral; they are intended for debugging and tests only.

## Notes

- **Provider ID**: `github-copilot`, overriding the built-in auth transport while retaining its model catalog and other hooks.
- Cooldown after a quota hit accepts `Retry-After` seconds or an HTTP date, otherwise defaults to 90 seconds.
- Missing credentials, HTTP 401, server errors, and network failures can fail over to another account. Caller cancellation is preserved.
- Account writes use an inter-process lock plus atomic rename. Invalid JSON and read errors are surfaced instead of silently replacing the account pool.
- Existing built-in Copilot credentials are imported when the pool is empty. To keep an account excluded, disable it rather than deleting every account.
- Model discovery still uses OpenCode's built-in catalog and active login; routing does not combine model catalogs from multiple subscriptions.
- Maximum retry attempts are bounded by account count and an internal cap of 10.

## Security behavior (keychain vs fallback)

This plugin prefers to store GitHub OAuth tokens in the operating system credential store (Keychain on macOS, Windows Credential Manager, or libsecret on Linux) when available. The plugin attempts a dynamic import of `keytar` and writes tokens keyed by a derived account ID.

Fallback file storage: when OS keychain is not available or writing to it fails, the plugin stores tokens in the JSON file under your config directory. File storage is a worst-case fallback and carries additional risks:

- The JSON file is written atomically (write to temp file then rename) to avoid partial writes.
- The plugin attempts best-effort hardening: new directories are requested with mode 0700, temporary token files are created with mode 0600, and the final file is chmodded to 0600 when possible. Existing shared config directories are not generally chmodded by the save operation. These operations are best-effort and may fail on some filesystems or platforms.
- Filesystem-based storage is less secure than an OS keychain. If an attacker gains local access to your account or a backup containing this file, OAuth tokens may be exposed.

Operational model summary:

- Preferred path: keychain available -> OAuth token stored in OS keychain, JSON uses `[KEYCHAIN]` placeholder.
- Fallback path: keychain unavailable/fails -> token stored in JSON with atomic writes and permission hardening best-effort.

On login, the plugin stores the OAuth token in the keychain under the persisted
account ID and writes `[KEYCHAIN]` in JSON on success. Missing keychain credentials
cause that account to be skipped with a re-login error. Tokens are never exchanged
through a refresh grant. New writes do not duplicate the token in `accessToken`.
Existing plaintext accounts are not automatically migrated until login. OpenCode
also stores the active login in its own auth file; this plugin does not replace
OpenCode's credential storage.

Environment variables for testing and behavior:

- `COPILOT_FORCE_NO_KEYCHAIN=1` - force-disable keychain usage (useful in CI)
- `COPILOT_FAKE_KEYCHAIN=1` - use an in-memory fake keychain for tests

## Optional OS keychain dependency (keytar)

This plugin will try to use the optional native module `keytar` to store OAuth tokens in the
operating system credential store (macOS Keychain, Windows Credential Manager, libsecret on Linux).

When to install

- Operators who run this plugin on developer machines or servers with a secure OS keyring
  should install `keytar` to improve security and keep OAuth tokens out of local files.

How to install

- `keytar` is already an optional dependency. Normal package installation attempts to install it.
- In a local checkout, use `npm install keytar --no-save` if needed. It must be resolvable from the plugin package; a global installation alone does not guarantee this.
- Installation with `--ignore-scripts` skips native build steps and does not validate a real OS keychain.

Behavior when keytar is missing

- The plugin does a dynamic import of `keytar`. If it is not installed or fails to load,
  the plugin falls back to storing OAuth tokens in the JSON config file under your
  config directory. The file storage is written atomically and the plugin attempts to set
  owner-only token file permissions (600), but filesystem-based storage is less secure.

CI and testing

- In CI environments you may prefer NOT to install native modules. Use `COPILOT_FORCE_NO_KEYCHAIN=1`
  to force the plugin to skip keychain attempts. Tests may set `COPILOT_FAKE_KEYCHAIN=1` to use an
  in-memory fake keychain for deterministic behavior.

Security recommendation

- Prefer installing `keytar` on machines you control to reduce exposure of OAuth tokens.

NEVER log secrets. The plugin never prints refresh/access tokens to logs.

## Coverage

- We run tests with coverage in CI and upload the coverage report as artifacts named `coverage-report-node-<version>`.
  Locally run: `npm run test:coverage` (this uses Vitest coverage and outputs `coverage/` with lcov and text reports).

Coverage gate policy:

- CI enforces minimum global thresholds to avoid silent regressions.
- Minimums: statements 80%, lines 80%, functions 80%, branches 70%. This checkout fixes the previously ineffective threshold configuration; these minimums were not enforced in 0.4.0.
- If a change drops coverage below thresholds, either add tests or adjust thresholds with clear technical justification.

## Development and release checks

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

`check` runs TypeScript checking, tests with coverage thresholds, a clean build, and multi-process storage/package-entry integration tests.
Tests use temporary account files and a fake keychain; they do not require GitHub
credentials and do not verify live Copilot access. CI runs the checks on Node.js
22, 24, and 26. The public package entry exports only the plugin initializer, and
builds exclude test files.

Before a new release, review [MAINTENANCE.md](MAINTENANCE.md), update the version and changelog, and inspect the package contents. `prepublishOnly` runs the checks and `prepack` builds the package.
Publishing is a separate maintainer action; checking or packing does not publish.

## Troubleshooting model discovery

If login succeeds but OpenCode says `Provider not found: github-copilot`, check
whether Copilot returns all models with `model_picker_enabled: false`. OpenCode
1.18.31 removes providers with an empty picker catalog. This does not necessarily
mean every model request is denied.

For a model you have verified is available to your account, explicitly configure
its ID and limits. The following GPT-4.1 example matched the model API in the live
maintenance test; available models and limits depend on the account:

```json
{
  "provider": {
    "github-copilot": {
      "npm": "@ai-sdk/github-copilot",
      "api": "https://api.githubcopilot.com",
      "models": {
        "gpt-4.1": {
          "name": "GPT-4.1",
          "limit": { "context": 128000, "input": 64000, "output": 16384 }
        }
      }
    }
  },
  "model": "github-copilot/gpt-4.1"
}
```

Merge this with the plugin configuration. Do not assume that a returned model ID
is authorized; policy-disabled models and subscription restrictions still apply.

## Automatic npm publishing

Publishing a GitHub Release triggers `.github/workflows/publish.yml`. The workflow
checks the release on Node.js 22 and 24, verifies the tag matches the package version
and belongs to `main`, then publishes to npm with OIDC and provenance. Stable releases
use `latest`; prereleases use `next`. Manual workflow runs only validate.

A package maintainer must first configure the npm trusted publisher for
`GeederX/OpenCode_Copilot_Multi_Auth`, workflow `publish.yml`.
See [RELEASING.md](RELEASING.md) for the exact settings and commands.
