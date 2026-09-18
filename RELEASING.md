# Releasing to npm

The `Publish npm package` workflow publishes when a GitHub Release is **published**.
Pushing code, merging a PR, creating a draft release, or manually running the workflow
does not publish a package. Manual workflow runs only validate the checkout.

## One-time npm setup

The package already exists as `@geeder/opencode-copilot-multi-auth`.
Log in to an npm account with package write access and enable account 2FA. In the
package's npm settings, configure a GitHub Actions trusted publisher with:

| Setting | Value |
| --- | --- |
| Organization or user | `GeederX` |
| Repository | `OpenCode_Copilot_Multi_Auth` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed action | Direct publish (`npm publish`) |

With npm 11.15 or later, the equivalent CLI command is:

```bash
npm login
npm trust list @geeder/opencode-copilot-multi-auth
npm trust github @geeder/opencode-copilot-multi-auth --repository GeederX/OpenCode_Copilot_Multi_Auth --file publish.yml --allow-publish
```

If a trusted publisher already exists, inspect it before changing it. Do not revoke
an existing publisher blindly. No `NPM_TOKEN` secret is required by this workflow.
The GitHub-hosted publishing job uses Node.js 24, npm 11.19.0, and `id-token: write`.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Each release

1. Update `package.json` and `package-lock.json` to an unused version, update
   `USER_AGENT` in `src/index.ts`, and record the changes in `CHANGELOG.md`.
2. Run `npm run check` and `npm pack --dry-run`; verify the plugin with OpenCode.
3. Merge the versioned changes to `main` and wait for CI to pass.
4. Create and publish a GitHub Release tagged `v<package.json version>` on that commit.
5. The workflow tests on Node.js 22 and 24, checks that the release commit belongs
   to `main`, verifies tag/version agreement, then publishes with provenance.

Prereleases use npm dist-tag `next`; stable releases use `latest`. An npm version
cannot be overwritten. If publication fails, inspect the workflow logs before
rerunning, and check whether the version has already been published.
