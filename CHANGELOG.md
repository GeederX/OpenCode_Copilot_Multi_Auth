# Changelog

## 0.5.0 (unreleased)

### Merged contributions

- PR #2: use the built-in GitHub Copilot provider.

- PR #3: correct npm package references, clean builds, and exclude compiled tests.
- PR #4: keep custom account IDs consistent in keychain storage and fail over after token refresh errors.

### Additional local maintenance

- Point installation instructions at the maintained `@geeder` package and correct repository links.
- Document outstanding OAuth, provider, and Enterprise compatibility work.
- Expose a dedicated plugin entry without internal helpers and omit tests from clean builds.
- Enforce coverage thresholds and run typechecking, coverage, builds, and package inspection in CI.
- Isolate tests from real account storage and keychains; add mocked routing and persistence regression tests.
- Create temporary token files with owner-only permissions and invalidate storage cache after a failed write.
- Return login failure when account persistence fails.

- Update the OpenCode SDK to 1.18.31 and remove the auth-method type bypass.
- Send GitHub OAuth tokens directly instead of attempting an unsupported refresh grant.
- Persist per-account Enterprise domains and route each attempt to the selected account's host.
- Fail over missing credentials, 401, server errors, and network failures; preserve abort signals and correct failure metrics.
- Reject invalid storage and coordinate concurrent writers with an inter-process lock.
- Preserve custom IDs on re-login and remove obsolete cached access tokens from new writes.
- Upgrade Vitest to 5.0.1 and resolve known dependency advisories; require supported Node 22/24/26 versions for development.
- Add release-triggered npm trusted publishing with provenance and a validation-only manual mode.
