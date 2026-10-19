import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Manifest {
    readonly name: string;
    readonly version: string;
    readonly repository: { readonly url: string };
    readonly private?: boolean;
    readonly exports: Readonly<Record<string, ExportTarget>>;
    readonly bin?: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
}

type ExportTarget = string | { readonly [condition: string]: ExportTarget };

function parseManifest(contents: string): Manifest {
    const value: unknown = JSON.parse(contents);
    assert.ok(typeof value === 'object' && value !== null);
    assert.ok('name' in value && typeof value.name === 'string');
    assert.ok('version' in value && typeof value.version === 'string');
    assert.ok('repository' in value && typeof value.repository === 'object' && value.repository !== null);
    assert.ok('url' in value.repository && typeof value.repository.url === 'string');
    assert.ok('exports' in value && typeof value.exports === 'object' && value.exports !== null);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Required identity fields are checked here; dependency and export values are checked against each tarball below and malformed values fail closed.
    return value as Manifest;
}

function targets(value: ExportTarget): Array<string> {
    return typeof value === 'string' ? [value] : Object.values(value).flatMap((entry) => targets(entry));
}

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['core', 'generator', 'react', 'inertia', 'laravel'];
const output = path.join(root, 'artifacts/npm');
const manifests = packages.map((name) =>
    parseManifest(readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')),
);
const [first] = manifests;
assert.ok(first !== undefined);
const { version } = first;
for (const manifest of manifests) {
    assert.equal(manifest.version, version, 'Release package versions must agree.');
}

const releaseTag = process.env['RELEASE_TAG'];
if (releaseTag !== undefined && releaseTag !== '') {
    assert.equal(releaseTag, `v${version}`, 'Release tag must match every package version.');
    assert.equal(
        process.env['RELEASE_PRERELEASE'],
        String(version.includes('-')),
        'GitHub prerelease status must match the version.',
    );
}
const distTag = version.includes('-') ? 'next' : 'latest';
const command = process.argv.at(2);

if (command === 'bootstrap') {
    for (const manifest of manifests) {
        const directory = path.join(root, 'artifacts/npm-bootstrap', manifest.name.replace('@formbraid/', ''));
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            path.join(directory, 'package.json'),
            `${JSON.stringify(
                {
                    name: manifest.name,
                    version: '0.0.0-bootstrap.0',
                    description: 'Namespace reservation for Formbraid. This placeholder contains no implementation.',
                    license: 'MIT',
                    repository: manifest.repository,
                    publishConfig: { access: 'public' },
                },
                null,
                2,
            )}\n`,
        );
        process.stdout.write(`Created ${directory}/package.json\n`);
    }
} else if (command === 'pack') {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    for (const name of packages) {
        execFileSync('pnpm', ['pack', '--pack-destination', output], {
            cwd: path.join(root, 'packages', name),
            stdio: 'inherit',
        });
    }
} else if (command !== 'check' && command !== 'smoke' && command !== 'stage') {
    throw new Error('Usage: node scripts/npm-release.ts <bootstrap|pack|check|smoke|stage>');
}

if (command === 'check' || command === 'smoke' || command === 'stage') {
    const archives = readdirSync(output).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, packages.length, 'Expected exactly five release tarballs.');
    for (const expected of manifests) {
        const archive = path.join(output, `${expected.name.replace('@', '').replace('/', '-')}-${version}.tgz`);
        const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
        const manifest = parseManifest(
            execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }),
        );
        assert.equal(manifest.name, expected.name);
        assert.equal(manifest.version, version);
        assert.equal(manifest.private, undefined);
        assert.equal(manifest.repository.url, 'git+https://github.com/nickwelsh/formbraid.git');
        assert.ok(files.includes('package/LICENSE'), `${manifest.name} must ship its license.`);
        assert.ok(files.includes('package/README.md'), `${manifest.name} must ship its README.`);
        const exported = JSON.stringify([
            manifest.dependencies,
            manifest.peerDependencies,
            manifest.optionalDependencies,
        ]);
        assert.ok(!/workspace:|file:|link:/u.test(exported), `${manifest.name} contains local dependencies.`);
        for (const entry of targets({ ...manifest.exports, ...manifest.bin })) {
            assert.ok(
                files.includes(`package/${entry.replace(/^\.\//u, '')}`),
                `${manifest.name} is missing ${entry}.`,
            );
        }
        assert.ok(
            !files.some((file) => /\.test\.|\.type-test\.|node_modules\/|vendor\//u.test(file)),
            `${manifest.name} contains development files.`,
        );
        process.stdout.write(`Verified ${manifest.name}@${version}\n`);
    }
    if (command === 'smoke') {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'formbraid-packages-'));
        try {
            writeFileSync(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
            writeFileSync(path.join(directory, '.npmrc'), '');
            execFileSync(
                'npm',
                [
                    'install',
                    '--ignore-scripts',
                    '--no-package-lock',
                    '--no-audit',
                    '--no-fund',
                    '--userconfig',
                    path.join(directory, '.npmrc'),
                    ...archives.map((archive) => path.join(output, archive)),
                    'react@^19.0.0',
                    '@inertiajs/core@3.7.1',
                ],
                { cwd: directory, stdio: 'inherit' },
            );
            execFileSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `
                import assert from 'node:assert/strict';
                for (const [specifier, member] of [
                    ['@formbraid/core', 'defineForm'],
                    ['@formbraid/react', 'createFormbraid'],
                    ['@formbraid/generator', 'defineConfig'],
                    ['@formbraid/react/generator', 'react'],
                    ['@formbraid/inertia', 'inertia'],
                    ['@formbraid/inertia/generator', 'inertia'],
                    ['@formbraid/laravel/generator', 'laravel'],
                ]) {
                    const exports = await import(specifier);
                    assert.equal(typeof exports[member], 'function', specifier);
                }
                console.log('All packed package entry points load outside the workspace.');
            `,
                ],
                { cwd: directory, stdio: 'inherit' },
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
    if (command === 'stage') {
        assert.ok(
            releaseTag !== undefined && releaseTag !== '',
            'Staging requires RELEASE_TAG and RELEASE_PRERELEASE.',
        );
        for (const archive of archives) {
            execFileSync(
                'npm',
                ['stage', 'publish', path.join(output, archive), '--access', 'public', '--tag', distTag],
                { cwd: root, stdio: 'inherit' },
            );
        }
    }
}
