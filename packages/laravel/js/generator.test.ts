// @vitest-environment node
/* oxlint-disable eslint/new-cap -- Effect constructors use capitalized functional APIs. */
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { Cause, Effect, Exit, Fiber, FileSystem, Schedule, Schema, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import type { ChildProcess } from 'effect/process';
import { NodeServices } from '@effect/platform-node';
import type { GenerationContext, RegistryManifest } from '@fieldwork/generator';
import { exportPhp, laravel, LaravelParseError, LaravelProcessError } from './generator.js';
import type { LaravelError } from './generator.js';

vi.setConfig({ testTimeout: 10_000 });

const context: GenerationContext = { root: '/workspace', output: { forms: 'generated' } };
const manifest: RegistryManifest = {
    fields: { TextField: { props: {} } },
    components: { SubmitButton: { props: {} } },
    groups: { AddressGroup: { props: {} } },
};
const extraction = { version: 1, forms: [], diagnostics: [] };

function responseSpawner(stdout: string, stderr = '', commands: Array<ChildProcess.Command> = []) {
    const encoder = new TextEncoder();
    return ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
            commands.push(command);
            return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode(stdout)),
                stderr: Stream.make(encoder.encode(stderr)),
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
            });
        }),
    );
}

async function decoded<A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    stdout: string,
    stderr = '',
) {
    const spawner = responseSpawner(stdout, stderr);
    return await Effect.runPromise(
        effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
}

describe('native Laravel generator adapter', () => {
    it('decodes the portable extraction and retains command arguments and root', async () => {
        expect.hasAssertions();
        const commands: Array<ChildProcess.Command> = [];
        const source = laravel({ root: 'app', php: '/custom/php', profile: 'settings' });
        const spawner = responseSpawner(JSON.stringify(extraction), '', commands);
        const output = await Effect.runPromise(
            source.extract(context).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        );
        expect(output).toStrictEqual(extraction);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
            _tag: 'StandardCommand',
            command: '/custom/php',
            args: ['artisan', 'fieldwork:export', '--no-ansi', '--profile=settings'],
            options: { cwd: '/workspace/app', stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        });
    });

    it('decodes enum targets and produces backend registry artifacts', async () => {
        expect.hasAssertions();
        const source = laravel();
        const effect = source.artifacts(manifest, context);
        const files = await decoded(
            effect,
            JSON.stringify([
                { registry: 'fields', path: 'app/Enums/FormField.php', namespace: 'App\\Enums', name: 'FormField' },
            ]),
        );
        expect(files).toHaveLength(1);
        expect(files[0]?.path).toBe('/workspace/app/Enums/FormField.php');
        expect(files[0]?.contents).toContain("case TextField = 'TextField';");
        expect(files[0]?.contents).toContain(String.raw`namespace App\Enums;`);
    });

    it('decodes typed HTTP bindings and optional parameters', async () => {
        expect.hasAssertions();
        const source = laravel();
        const operations = [
            {
                name: 'profile.update',
                schema: 'ProfileRequest',
                parameters: [{ name: 'user', optional: true }],
                binding: { uri: 'users/{user?}', method: 'patch' },
            },
        ];
        expect(source.http().source).toBe(source);
        await expect(
            decoded(source.http().extract(context), JSON.stringify({ version: 1, operations })),
        ).resolves.toStrictEqual(operations);
    });

    it.each([
        ['extraction', 'not json'],
        ['extraction', JSON.stringify({ version: 2, forms: [], diagnostics: [] })],
        ['extraction', JSON.stringify({ ...extraction, extra: true })],
        ['enums', JSON.stringify([{ registry: 'unknown', path: 'Enum.php', namespace: 'App', name: 'Enum' }])],
        [
            'http',
            JSON.stringify({
                version: 1,
                operations: [
                    {
                        name: 'bad',
                        schema: 'Request',
                        parameters: [{ name: 'id', optional: 'yes' }],
                        binding: { uri: '/bad', method: 'patch' },
                    },
                ],
            }),
        ],
        [
            'http',
            JSON.stringify({
                version: 1,
                operations: [
                    { name: 'bad', schema: 'Request', parameters: [], binding: { uri: '/bad', method: 'PATCH' } },
                ],
            }),
        ],
    ] as const)('returns a typed parse failure for invalid %s exports', async (kind, stdout) => {
        expect.hasAssertions();
        const source = laravel();
        const exports: Record<
            LaravelParseError['kind'],
            Effect.Effect<unknown, LaravelError, ChildProcessSpawner.ChildProcessSpawner>
        > = {
            extraction: source.extract(context),
            http: source.http().extract(context),
            enums: source.artifacts(manifest, context),
        };
        const error = await decoded(Effect.flip(exports[kind]), stdout, 'backend diagnostic');
        expect(error).toBeInstanceOf(LaravelParseError);
        expect(error).toMatchObject({ kind, stdout, stderr: 'backend diagnostic' });
        expect(error.cause).toBeInstanceOf(Schema.SchemaError);
    });

    it('drains large stdout and stderr concurrently without deadlocking', async () => {
        expect.hasAssertions();
        const output = await Effect.runPromise(
            exportPhp(
                process.execPath,
                ['-e', 'process.stdout.write("o".repeat(256 * 1024)); process.stderr.write("e".repeat(256 * 1024));'],
                process.cwd(),
            ).pipe(Effect.provide(NodeServices.layer)),
        );
        expect(output.stdout).toBe('o'.repeat(256 * 1024));
        expect(output.stderr).toBe('e'.repeat(256 * 1024));
    });

    it('preserves nonzero exit codes and both output streams as a typed process failure', async () => {
        expect.hasAssertions();
        const error = await Effect.runPromise(
            exportPhp(
                process.execPath,
                [
                    '-e',
                    'process.stdout.write("partial"); process.stderr.write("backend failed"); process.exitCode = 7;',
                ],
                process.cwd(),
            ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
        );
        expect(error).toBeInstanceOf(LaravelProcessError);
        expect(error).toMatchObject({
            exitCode: 7,
            stdout: 'partial',
            stderr: 'backend failed',
            executable: process.execPath,
        });
    });

    it('preserves native spawn errors in its typed failure', async () => {
        expect.hasAssertions();
        const error = await Effect.runPromise(
            exportPhp('/fieldwork/missing-php-executable', [], process.cwd()).pipe(
                Effect.flip,
                Effect.provide(NodeServices.layer),
            ),
        );
        expect(error).toBeInstanceOf(LaravelProcessError);
        expect(error.cause).toMatchObject({ _tag: 'PlatformError', reason: { _tag: 'NotFound' } });
    });

    it('fails on output beyond the capture limit and closes the running child scope', async () => {
        expect.hasAssertions();
        const error = await Effect.runPromise(
            exportPhp(
                process.execPath,
                ['-e', 'process.stdout.write("x".repeat(16 * 1024 * 1024 + 1)); setInterval(() => {}, 1000);'],
                process.cwd(),
            ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
        );
        expect(error).toBeInstanceOf(LaravelProcessError);
        expect(error.cause).toMatchObject({
            _tag: 'LaravelOutputLimitError',
            stream: 'stdout',
            limit: 16 * 1024 * 1024,
        });
    });

    it('kills the native child when the capturing fiber is interrupted', async () => {
        expect.hasAssertions();
        const result = await Effect.runPromise(
            Effect.gen(function* interruptCommand() {
                const fs = yield* FileSystem.FileSystem;
                const root = yield* fs.makeTempDirectoryScoped();
                const pidFile = path.join(root, 'child.pid');
                const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
                const child = yield* Effect.forkChild(exportPhp(process.execPath, ['-e', code], root));
                const pidText = yield* fs
                    .readFileString(pidFile)
                    .pipe(Effect.retry({ times: 100, schedule: Schedule.spaced('10 millis') }));
                const pid = Number(pidText);
                yield* Effect.sync(() => {
                    expect(() => process.kill(pid, 0)).not.toThrow();
                });
                yield* Fiber.interrupt(child);
                return { pid, exit: yield* Fiber.await(child) };
            }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );
        expect(() => process.kill(result.pid, 0)).toThrow(/ESRCH/u);
        expect(Exit.isFailure(result.exit)).toBe(true);
        const interrupted = Exit.match(result.exit, { onSuccess: () => false, onFailure: Cause.hasInterrupts });
        expect(interrupted).toBe(true);
    });
});
