/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema constructors. */
/* oxlint-disable eslint/max-classes-per-file -- The adapter's tagged failures define one public error union. */
import path from 'node:path';
import { ExtractionSchema, HttpOperationSchema, operationSchema } from '@fieldwork/core';
import type { HttpOperation } from '@fieldwork/core';
import type { GeneratedFile, SourceDriver, OperationProvider } from '@fieldwork/generator';
import { Data, Effect, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import type { ChildProcessSpawner } from 'effect/process';
import type { PlatformError } from 'effect';

const outputLimit = 16 * 1024 * 1024;

export class LaravelProcessError extends Data.TaggedError('LaravelProcessError')<{
    readonly message: string;
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly root: string;
    readonly cause: unknown;
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
}> {}

export class LaravelParseError extends Data.TaggedError('LaravelParseError')<{
    readonly message: string;
    readonly kind: 'extraction' | 'enums' | 'http';
    readonly stdout: string;
    readonly stderr: string;
    readonly cause: Schema.SchemaError;
}> {}

class LaravelOutputLimitError extends Data.TaggedError('LaravelOutputLimitError')<{
    readonly stream: 'stdout' | 'stderr';
    readonly limit: number;
}> {}

export type LaravelError = LaravelProcessError | LaravelParseError;

export interface PhpOutput {
    readonly stdout: string;
    readonly stderr: string;
}

function collectOutput(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>, name: 'stdout' | 'stderr') {
    return Stream.runFoldEffect(
        Stream.decodeText(stream),
        () => ({ chunks: new Array<string>(), bytes: 0 }),
        (collected, chunk) => {
            const bytes = collected.bytes + new TextEncoder().encode(chunk).byteLength;
            if (bytes > outputLimit) {
                return Effect.fail(new LaravelOutputLimitError({ stream: name, limit: outputLimit }));
            }
            collected.chunks.push(chunk);
            collected.bytes = bytes;
            return Effect.succeed(collected);
        },
    ).pipe(Effect.map(({ chunks }) => chunks.join('')));
}

/** The supplied spawner owns the child; scope closure interrupts and terminates it. */
export function exportPhp(
    file: string,
    args: ReadonlyArray<string>,
    root: string,
): Effect.Effect<PhpOutput, LaravelProcessError, ChildProcessSpawner.ChildProcessSpawner> {
    return Effect.scoped(
        Effect.gen(function* executePhp() {
            const child = yield* ChildProcess.make(file, args, {
                cwd: root,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            // Drain both pipes concurrently with the exit wait so neither can block the child.
            return yield* Effect.all(
                {
                    stdout: collectOutput(child.stdout, 'stdout'),
                    stderr: collectOutput(child.stderr, 'stderr'),
                    exitCode: child.exitCode,
                },
                { concurrency: 'unbounded' },
            );
        }),
    ).pipe(
        Effect.mapError(
            (cause) =>
                new LaravelProcessError({
                    message: `Laravel command failed: ${file}`,
                    executable: file,
                    args,
                    root,
                    cause,
                }),
        ),
        Effect.flatMap((output) =>
            output.exitCode === 0
                ? Effect.succeed({ stdout: output.stdout, stderr: output.stderr })
                : Effect.fail(
                      new LaravelProcessError({
                          message: `Laravel command exited with code ${output.exitCode}: ${file}`,
                          executable: file,
                          args,
                          root,
                          cause: undefined,
                          exitCode: output.exitCode,
                          stdout: output.stdout,
                          stderr: output.stderr,
                      }),
                  ),
        ),
    );
}

export interface LaravelOptions {
    readonly root?: string;
    readonly profile?: string;
    readonly php?: string;
}

export const EnumTargetSchema = Schema.Struct({
    registry: Schema.Literals(['fields', 'components', 'groups']),
    path: Schema.String,
    namespace: Schema.String,
    name: Schema.String,
});

export const EnumTargetsSchema = Schema.Array(EnumTargetSchema);
export const HttpExportSchema = Schema.Struct({
    version: Schema.Literal(1),
    operations: Schema.Array(operationSchema(HttpOperationSchema)),
});

function decodeExport<S extends Schema.Constraint>(schema: S, output: PhpOutput, kind: LaravelParseError['kind']) {
    return Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
        errors: 'all',
        onExcessProperty: 'error',
    })(output.stdout).pipe(
        Effect.mapError(
            (cause) =>
                new LaravelParseError({
                    message: `Laravel did not return a valid Fieldwork ${kind} JSON export. ${output.stderr}`,
                    kind,
                    stdout: output.stdout,
                    stderr: output.stderr,
                    cause,
                }),
        ),
    );
}

export interface LaravelSource extends SourceDriver<LaravelError, ChildProcessSpawner.ChildProcessSpawner> {
    readonly artifacts: NonNullable<SourceDriver<LaravelError, ChildProcessSpawner.ChildProcessSpawner>['artifacts']>;
    readonly http: () => OperationProvider<HttpOperation, LaravelError, ChildProcessSpawner.ChildProcessSpawner>;
}

export function laravel(options: LaravelOptions = {}): LaravelSource {
    const source: LaravelSource = {
        artifacts: (manifest, context) => {
            const root = path.resolve(context.root, options.root ?? '.');
            return exportPhp(
                options.php ?? 'php',
                [path.resolve(import.meta.dirname, '../bin/enums.php'), root],
                root,
            ).pipe(
                Effect.flatMap((output) => decodeExport(EnumTargetsSchema, output, 'enums')),
                Effect.map((targets) =>
                    targets.map((target): GeneratedFile => ({
                        path: path.resolve(root, target.path),
                        contents: `<?php\n\ndeclare(strict_types=1);\n\n// Generated by Fieldwork. Edit the frontend component registry.\n\nnamespace ${target.namespace};\n\nenum ${target.name}: string\n{\n${Object.keys(
                            manifest[target.registry],
                        )
                            .map((name) => `    case ${name} = '${name}';`)
                            .join('\n')}\n}\n`,
                    })),
                ),
            );
        },
        extract: (context) => {
            const root = path.resolve(context.root, options.root ?? '.');
            return exportPhp(
                options.php ?? 'php',
                [
                    'artisan',
                    'fieldwork:export',
                    '--no-ansi',
                    ...(options.profile === undefined ? [] : [`--profile=${options.profile}`]),
                ],
                root,
            ).pipe(Effect.flatMap((output) => decodeExport(ExtractionSchema, output, 'extraction')));
        },
        http: () => ({
            source,
            extract: (context) => {
                const root = path.resolve(context.root, options.root ?? '.');
                return exportPhp(options.php ?? 'php', ['artisan', 'fieldwork:http', '--no-ansi'], root).pipe(
                    Effect.flatMap((output) => decodeExport(HttpExportSchema, output, 'http')),
                    Effect.map((output) => output.operations),
                );
            },
        }),
    };
    return source;
}
