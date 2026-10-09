# Pinned Inertia Effect development package

`inertia-core-effect-18db6eba25c95837.tgz` is the unmodified `@inertiajs/core@3.8.0` package built from [nickwelsh/inertia-effect](https://github.com/nickwelsh/inertia-effect) at commit `18db6eba25c95837cf303745e46fc6201bc35177`.

- Archive SHA-256: `fc55c237737470df3e943a38adc48b643d6f19e6d24f60add2f40fe0c3cbcadf`
- Build environment: Node.js 26.10.0, pnpm 11.24.0; dependencies installed using the fork's committed lockfile.
- The archive was built from a fresh detached checkout, with no source or manifest changes. Existing ignored build outputs from the working fork were not copied.

The development dependency retains the `@inertiajs/core` identity. The native adapter imports the application's core router through that package name, so consumers must install this fork as their own `@inertiajs/core` dependency. Installing an alias alongside a different core package would create separate router instances.

Direct Git installation is currently incomplete. pnpm supports the pinned subdirectory specifier `github:nickwelsh/inertia-effect#18db6eba25c95837cf303745e46fc6201bc35177&path:/packages/core`, but this commit has no `prepare`, `prepack`, or `prepublish` script. Its `dist` and `types` directories are ignored rather than tracked. pnpm does not automatically run the package's `build` script, so a direct Git install produces a package without its declared exports. pnpm 11 does not support a custom `build:` Git fragment.

## Build from the pinned source

Run these commands in a clean directory:

```sh
git clone https://github.com/nickwelsh/inertia-effect.git
cd inertia-effect
git checkout --detach 18db6eba25c95837cf303745e46fc6201bc35177
pnpm install --frozen-lockfile --filter @inertiajs/core...
pnpm -C packages/core build
pnpm -C packages/core pack --out /tmp/inertia-core-effect-18db6eba25c95837.tgz
```

Then install the resulting package in the consuming application using the same core name:

```sh
pnpm add /tmp/inertia-core-effect-18db6eba25c95837.tgz
```

For this repository, copy the resulting archive into this directory and run `pnpm install` from the workspace root. The checked-in lockfile records the archive integrity. Verify that `@inertiajs/core` exposes `router.visitEffect` and the `NavigationFailure` / `VisitOutcome` types, then use `@fieldwork/inertia/effect` for the native adapter. The default `@fieldwork/inertia` adapter continues to support standard Inertia.

Adding a package preparation script in the fork would allow a later commit to replace this development archive with a direct pinned Git dependency. No upstream repository changes or pushes were made to create this package.
