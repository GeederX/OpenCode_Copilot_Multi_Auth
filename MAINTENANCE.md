# Maintenance status

Updated: 2026-09-18. Release candidate: `0.5.0`.

## Integrated contributions

- PR #2: use built-in `github-copilot` provider.
- PR #3: correct package references and produce clean builds without test files.
- PR #4: custom account ID/keychain consistency and account-local authentication failure handling.

All three PRs are merged. Additional maintenance builds on their changes and retains the original MIT notice.

## Changes in 0.5.0

- SDK updated to OpenCode `1.18.31`; auth prompts now use its actual types.
- Device OAuth tokens are sent directly to Copilot, matching that OpenCode version. The historical JSON property `refreshToken` remains compatible, but no refresh grant is sent.
- Each account stores its Enterprise domain and requests switch host with the selected account. Legacy Enterprise accounts must log in again to populate their domain.
- Missing keychain credentials, HTTP 401, network errors, and server failures can fail over. Non-success HTTP responses no longer count as successes. Caller cancellation is preserved.
- Account changes lock, reread, and atomically replace the JSON file. Malformed files and read errors fail visibly rather than becoming an empty pool. Temporary token files use owner-only permissions.
- Re-login preserves existing custom IDs using a token fingerprint, and removes obsolete duplicate access-token caches. Failed persistence is reported as failed login.
- The public module exports only the plugin initializer. Tests use isolated config directories and fake credentials.
- Vitest 5 replaces the vulnerable older testing stack. CI targets Node.js 22, 24, and 26; coverage gates are statements/lines/functions 80%, branches 70%.
- `publish.yml` supports release-triggered npm OIDC publishing after validation. See [RELEASING.md](RELEASING.md).

## Verification

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm audit
```

`check` includes unit tests, coverage thresholds, typechecking, clean builds, a built-entry smoke test, and concurrent writes from independent Node processes.

Live checks used an isolated OpenCode 1.18.31 profile. GitHub device login, a direct plugin-backed Copilot request, and a full `opencode run` with explicit `github-copilot/gpt-4.1` configuration succeeded. The response was `OK`. Dependencies were audited with no known vulnerabilities after the toolchain upgrade.

## Compatibility notes

- OpenCode owns model discovery and its active-login auth file. The plugin does not combine model catalogs from several accounts, or replace OpenCode's own credential storage.
- Some accounts return all models with `model_picker_enabled: false`; OpenCode then hides the provider even when a model request is usable. An explicit model configuration is needed for that case. See README troubleshooting.
- Real Enterprise credentials and a working native keytar installation are not available in the isolated test profile. Enterprise routing and keychain behavior have regression coverage; do not treat these as live Enterprise or native-keychain certification.
- The storage lock coordinates this plugin's processes. External JSON editors must not save over concurrent logins. A five-second cache can delay externally edited routing rules.
- Existing plaintext credentials require re-login to migrate to the keychain. Accounts without usable credentials require re-authentication; the plugin does not try unsupported refresh-token grants.
- npm trusted publishing requires account 2FA and a package/workflow binding. Until that setup succeeds, publishing cannot be described as activated.

## References

- [OpenCode 1.18.31 Copilot transport](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/github-copilot/copilot.ts)
- [OpenCode plugin loading](https://opencode.ai/docs/plugins/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
