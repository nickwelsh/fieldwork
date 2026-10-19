# Fieldwork documentation

The site uses [`@nickwelsh/docs-base`](https://github.com/nickwelsh/docs-base) for its complete application. This directory owns identity, authored MDX, Refquill source selection, and Cloudflare deployment packaging.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm docs:dev
pnpm docs:api
pnpm docs:build
pnpm docs:check
pnpm --filter @fieldwork/docs test
pnpm --filter @fieldwork/docs deploy:check
```

Open `/fieldwork/` on the development server. `docs:dev` generates API data before starting. Regenerate with `docs:api` after changing API declarations; restart the server if needed. `docs:build` generates fresh API JSON, prerenders the shared app, and packages the output using Cloudflare's Build Output utilities. No library package build, Composer install, or PHP runtime is required for Refquill analysis.

## Content and references

Write guides in `content/docs/0.x`; navigation is controlled by `meta.json`. Refquill reads every public TypeScript package entry point and `packages/laravel/src` through `refquill.json`, writing ignored `generated/api.json`. docs-base renders it at `/fieldwork/docs/0.x/api` and includes it in navigation, search, and Markdown exports. Generate this file before running the site directly. Do not edit the JSON by hand.

Framework peers match the docs-base starter. Keep the Waku request-handler patch until docs-base upgrades its required Waku version. Docs use their own React version; runtime packages retain their existing peers.

Refquill 0.1.0 also needs the pinned patch in `patches/@nickwelsh__refquill@0.1.0.patch`: TypeDoc can emit re-exported or inherited declarations outside their parent scope, while annotation resolution only needs the existing checker context. The patch removes an invalid scope transition without changing selected APIs.

The docs-base patch adds `githubContentPath` so authored page links include this monorepo's `apps/docs` directory. CI pins source links to the build's commit. The Worker integration test checks all authored routes, both API languages, search, Markdown, styles, source links, and missing-page behavior using Miniflare.

## Release deployment

`.github/workflows/check.yml` builds and validates docs with the package checks on every push and pull request. Only a pushed `v*` tag deploys. Deployment waits for the TypeScript and PHP jobs. The deployment job downloads the exact validated artifact and runs the pinned `cf` CLI with `--prebuilt --mode production`. Deployments are serialized.

Configure the GitHub `cloudflare` environment with:

- `CLOUDFLARE_API_TOKEN`: an account token with Workers Scripts Edit and zone Workers Routes Edit, plus Zone Read for `nickwelsh.me` discovery.
- `CLOUDFLARE_ACCOUNT_ID`: the account containing that zone and Worker.

The GitHub `cloudflare` environment is restricted to `v*` tags. Branch/PR checks do not receive Cloudflare secrets.

The `fieldwork-docs` Worker owns only `docs.nickwelsh.me/fieldwork` and `docs.nickwelsh.me/fieldwork/*`, preserving other projects on the host. The host must already have a proxied DNS record in the `nickwelsh.me` zone. `workers.dev` and version preview URLs are disabled. `cloudflare.config.ts` is the source of truth for routes, compatibility, and observability.

docs-base emits static HTML, React Server Component payloads, search data, and Markdown endpoints. `package-worker.ts` places all assets under the public `/fieldwork` prefix without a custom request handler. It writes and validates `.cloudflare/output` using the same pinned schema utilities as `cf`. Always build through the package script; `cf build` does not run docs-base or Refquill.

To redeploy an older release, check out its tag, install with the frozen lockfile, build, validate, and deploy using the commands above and the same account. Deployment replaces the site's current content; it does not archive a copy of each patch release. Add a new authored version folder when introducing a new documentation line.
