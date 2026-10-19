# Publishing Formbraid

The source repository is `nickwelsh/formbraid`. npm packages use the `@formbraid` scope. The Composer package is `formbraid/laravel`, mirrored to [`formbraid/laravel`](https://github.com/formbraid/laravel).

## Create the npm package records

Use npm 12.2.0 or later. Generate the five placeholders, refresh your local npm login, and stage them:

```sh
npm install --global npm@12.2.0
npm login
pnpm packages:bootstrap
for pkg in core generator react inertia laravel; do
    npm stage publish "./artifacts/npm-bootstrap/$pkg" --access public --tag bootstrap
done
```

Each directory contains only a minimal `package.json` at `0.0.0-bootstrap.0`. No implementation or dependencies are included. The `bootstrap` dist-tag keeps these placeholders away from `latest`, even if approved. Staging can create a new package record; it does not make the version installable. Do not approve the placeholders as a release.

For **each** of `@formbraid/core`, `@formbraid/generator`, `@formbraid/react`, `@formbraid/inertia`, and `@formbraid/laravel`, configure an npm trusted publisher:

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| Provider             | GitHub Actions                                                               |
| Organization or user | `nickwelsh`                                                                  |
| Repository           | `formbraid`                                                                  |
| Workflow filename    | `release.yml`                                                                |
| Environment name     | `npm`                                                                        |
| Allowed actions      | `npm stage publish` only; direct publishing and dist-tag management disabled |

Create the matching GitHub environment:

```sh
gh api --method PUT repos/nickwelsh/formbraid/environments/npm
```

No npm token secret is needed. Configure the publisher shortly before staging the first release: npm requires the first successful use within two days. See [trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [staged publishing](https://docs.npmjs.com/cli/v12/commands/npm-stage/).

## Configure the Composer mirror

The mirror repository must be empty before its first sync. Treat it as read-only; develop in the monorepo.

GitHub disables deploy keys by default for new organizations. Before creating the key, open [Formbraid's member privileges](https://github.com/organizations/Formbraid/settings/member_privileges), find **Deploy keys**, select **Enabled**, and save. This is an organization-wide setting. See [GitHub's deploy-key policy documentation](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-organization-settings/restricting-deploy-keys-in-your-organization).

Add a dedicated write-enabled public key to the mirror and store its matching private half as a secret in the source repository. Run this block as a subshell so it stops immediately on failure without changing your interactive shell's options:

```sh
(
    set -eu
    key_dir=$(mktemp -d)
    printf 'Temporary key directory: %s\n' "$key_dir"
    ssh-keygen -t ed25519 -C formbraid-composer-mirror -N '' -f "$key_dir/mirror"
    gh repo deploy-key add "$key_dir/mirror.pub" --repo formbraid/laravel --title formbraid-composer-mirror --allow-write
    gh secret set PHP_MIRROR_SSH_KEY --repo nickwelsh/formbraid < "$key_dir/mirror"
    rm "$key_dir/mirror" "$key_dir/mirror.pub"
    rmdir "$key_dir"
)
```

If a command fails, subsequent commands do not run and the key files remain in the printed temporary directory for retry. If an earlier attempt reported that deploy keys are disabled but still saved the secret, enable the policy and rerun the entire block to replace that unusable secret with a matching pair.

After these changes reach `main`, successful push CI automatically splits `packages/laravel` into the mirror's `main` branch. You can also start that sync manually:

```sh
gh workflow run sync-php.yml --repo nickwelsh/formbraid --ref main
```

Submit `https://github.com/formbraid/laravel` to [Packagist](https://packagist.org/packages/submit) after the initial sync. Enable Packagist's GitHub webhook/auto-update integration on the mirror. GitHub releases in the monorepo mirror the matching tag after verification; Packagist reads those tags. CI does not need a Packagist API token.

The split retains the package's source history. Composer archives omit Node build configuration, JS sources, lockfiles, and PHP development tooling through `packages/laravel/.gitattributes`. The package includes its own license and README.

## Configure documentation deployment

The existing `cloudflare` GitHub environment is restricted to `v*` tags. Add these secrets there; `gh secret set` prompts without echoing their values:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo nickwelsh/formbraid --env cloudflare
gh secret set CLOUDFLARE_ACCOUNT_ID --repo nickwelsh/formbraid --env cloudflare
```

Use an account token with Workers Scripts Edit, plus Workers Routes Edit and Zone Read restricted to the `nickwelsh.me` zone. The account must contain the zone and the Worker. The `docs.nickwelsh.me` DNS record must be proxied.

Every main push and pull request builds docs, checks their types, verifies authored routes, API references, search, Markdown, styles, source links and 404 responses in Miniflare, then dry-runs `cf deploy`. A pushed `v*` tag deploys the exact verified artifact to the `formbraid-docs` Worker at `https://docs.nickwelsh.me/formbraid/`. Branch and PR jobs do not receive deployment secrets. This preserves the existing tag deployment policy: docs deployment does not wait for npm staging approval.

To verify a branch manually, run `gh workflow run check.yml --repo nickwelsh/formbraid --ref BRANCH`. Manual Check runs never deploy docs or synchronize the Composer mirror.

## Stage a release

1. Merge the rename and publication setup to `main`. Wait for CI and the initial Composer mirror sync to pass.
2. Keep all five public npm packages at the same version. Update their internal peer ranges when changing versions.
3. Push the matching `vVERSION` tag. This runs checks and deploys documentation.
4. Publish a GitHub release for that tag. Mark it as a prerelease exactly when its version includes a prerelease suffix.
5. `release.yml` reruns verification, stages the exact checked npm tarballs with OIDC, and mirrors the Composer tag. It never approves npm stages. Stable versions use `latest`; prereleases use `next`.
6. Inspect and approve the staged implementation versions on npm using your own account and 2FA when ready. The Composer tag is public when mirrored, independently of npm approval.

Local verification:

```sh
pnpm exec vp run build
pnpm exec vp check
pnpm exec tsc --noEmit
pnpm exec vp test run
pnpm packages:pack
pnpm packages:check
pnpm packages:smoke
pnpm docs:check
pnpm --filter @formbraid/docs test
pnpm --filter @formbraid/docs deploy:check
composer --working-dir=packages/laravel validate --strict
composer --working-dir=packages/laravel test
composer --working-dir=packages/laravel check
```

`packages:check` checks the actual tarball identities, versions, exports, runtime dependency specifiers, license, README, and file boundaries. `packages:smoke` installs the five tarballs into a temporary project with standard React and Inertia, then loads the public entry points without workspace aliases. `@formbraid/inertia/effect` additionally requires the documented Inertia Effect fork; the standard adapter supports upstream Inertia.
