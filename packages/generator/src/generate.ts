/* oxlint-disable eslint/no-underscore-dangle -- PlatformError reason tags use the native _tag discriminator. */
import path from 'node:path';
import { Effect, FileSystem } from 'effect';
import type { Scope } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { format } from 'oxfmt';
import type { Extraction } from '@fieldwork/core';
import { GenerationError, generationStep } from './contracts.js';
import type { FieldworkConfig, GeneratedFile, RegistryManifest, SourceDriver } from './contracts.js';

function missing<A>(effect: Effect.Effect<A, PlatformError>, fallback: A): Effect.Effect<A, PlatformError> {
    return Effect.catchIf(
        effect,
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed(fallback),
    );
}

function update(fs: FileSystem.FileSystem, files: ReadonlyArray<GeneratedFile>, check: boolean) {
    return Effect.gen(function* updateFiles() {
        const stale = yield* Effect.forEach(
            files,
            (file) =>
                Effect.gen(function* updateFile() {
                    const existing = yield* missing<string | null>(fs.readFileString(file.path), null);
                    const formatted = file.path.endsWith('.ts')
                        ? yield* Effect.tryPromise({
                              try: async () =>
                                  await format(file.path, file.contents, {
                                      semi: true,
                                      singleQuote: true,
                                      tabWidth: 4,
                                      printWidth: 120,
                                  }),
                              catch: (cause) =>
                                  new GenerationError({
                                      stage: 'formatting',
                                      message: `Cannot format generated file ${file.path}.`,
                                      cause,
                                  }),
                          })
                        : { code: file.contents, errors: [] };
                    if (formatted.errors.length > 0) {
                        return yield* new GenerationError({
                            stage: 'formatting',
                            message: `Cannot format generated file ${file.path}.`,
                        });
                    }
                    if (existing === formatted.code) {
                        return null;
                    }
                    if (check) {
                        return file.path;
                    }
                    yield* fs.makeDirectory(path.dirname(file.path), { recursive: true });
                    yield* fs.writeFileString(file.path, formatted.code);
                    return null;
                }),
            { concurrency: 'unbounded' },
        );
        const paths = stale.filter((file) => file !== null);
        if (paths.length > 0) {
            yield* new GenerationError({
                stage: 'drift',
                message: `Generated files are stale:\n${paths.join('\n')}`,
            });
        }
    });
}

export interface GenerateOptions {
    readonly root: string;
    readonly check?: boolean;
    readonly fieldsOnly?: boolean;
}

export interface GenerationResult {
    readonly manifest: RegistryManifest;
    readonly files: ReadonlyArray<string>;
    readonly diagnostics: ReadonlyArray<string>;
}

function configured<E, R>(config: FieldworkConfig<E, R>) {
    const entries = Object.entries(config.sources);
    if (entries.length === 0) {
        throw new Error('Configure at least one schema source.');
    }
    const submissions = Object.entries(config.submissions ?? {});
    for (const name of [...entries.map(([key]) => key), ...submissions.map(([key]) => key)]) {
        if (!/^[A-Za-z_]\w*$/u.test(name)) {
            throw new Error(`Invalid source or submission name: ${name}.`);
        }
    }
    if (new Set(entries.map(([, source]) => source)).size !== entries.length) {
        throw new Error('Register each source instance once; reuse it through operation providers.');
    }
    for (const [name, submission] of submissions) {
        if (!entries.some(([, source]) => source === submission.source)) {
            throw new Error(`Submission ${name} references an unregistered schema source.`);
        }
    }
    return { entries, submissions };
}

type MethodEffect<T, K extends PropertyKey> =
    T extends Readonly<Record<K, (...args: Array<never>) => infer F>> ? F : never;
type SourceEffects<C extends FieldworkConfig<unknown, unknown>> =
    | MethodEffect<C['sources'][keyof C['sources']], 'extract'>
    | MethodEffect<C['sources'][keyof C['sources']], 'artifacts'>;
type SubmissionEffects<C> = C extends { readonly submissions: infer S }
    ? MethodEffect<S[keyof S], 'operations'>
    : never;
export type GenerationEffects<C extends FieldworkConfig<unknown, unknown>> = SourceEffects<C> | SubmissionEffects<C>;

export function generate<const C extends FieldworkConfig<unknown, unknown>>(
    config: C & FieldworkConfig<Effect.Error<GenerationEffects<C>>, Effect.Services<GenerationEffects<C>>>,
    options: GenerateOptions,
): Effect.Effect<
    GenerationResult,
    Effect.Error<GenerationEffects<C>> | GenerationError | PlatformError,
    Exclude<Effect.Services<GenerationEffects<C>>, Scope.Scope> | FileSystem.FileSystem
> {
    return generateConfigured<Effect.Error<GenerationEffects<C>>, Effect.Services<GenerationEffects<C>>>(
        config,
        options,
    );
}

function generateConfigured<E, R>(
    config: FieldworkConfig<E, R>,
    options: GenerateOptions,
): Effect.Effect<
    GenerationResult,
    E | GenerationError | PlatformError,
    Exclude<R, Scope.Scope> | FileSystem.FileSystem
> {
    return Effect.scoped(
        Effect.gen(function* generateFiles() {
            const fs = yield* FileSystem.FileSystem;
            const context = { root: options.root, output: config.output };
            const { entries, submissions } = yield* generationStep('configuration', () => configured(config));
            const manifest = yield* generationStep('inspection', () => config.framework.inspect(context));
            const files: Array<GeneratedFile> = [];
            const diagnostics: Array<string> = [];
            const paths = new Map<string, string>();
            function claim(generated: ReadonlyArray<GeneratedFile>): Effect.Effect<void, GenerationError> {
                return generationStep('artifacts', () => {
                    for (const file of generated) {
                        const existing = paths.get(file.path);
                        if (existing !== undefined && existing !== file.contents) {
                            throw new Error(`Conflicting generated artifact: ${file.path}`);
                        }
                        if (existing === undefined) {
                            paths.set(file.path, file.contents);
                            files.push(file);
                        }
                    }
                });
            }
            // Source-owned artifacts must exist before extraction boots a backend.
            const artifacts = yield* Effect.forEach(
                entries,
                ([, source]) => source.artifacts?.(manifest, context) ?? Effect.succeed([]),
                { concurrency: 'unbounded' },
            );
            for (const generated of artifacts) {
                yield* claim(generated);
            }
            yield* update(fs, files, options.check === true);
            if (options.fieldsOnly !== true) {
                const extracted = new Map<SourceDriver<unknown, unknown>, Extraction>();
                const results = yield* Effect.forEach(entries, ([, source]) => source.extract(context), {
                    concurrency: 'unbounded',
                });
                for (const [index, [name, source]] of entries.entries()) {
                    const result = results[index];
                    if (result === undefined) {
                        return yield* new GenerationError({
                            stage: 'emission',
                            message: `Missing extraction for ${name}.`,
                        });
                    }
                    extracted.set(source, result);
                    diagnostics.push(...result.diagnostics);
                    yield* claim(
                        yield* generationStep('emission', () =>
                            config.framework.generate(result, manifest, {
                                ...context,
                                ...(entries.length > 1 ? { source: name } : {}),
                            }),
                        ),
                    );
                }
                const operationSets = yield* Effect.forEach(
                    submissions,
                    ([, submission]) => submission.operations(context),
                    { concurrency: 'unbounded' },
                );
                for (const [index, [name, submission]] of submissions.entries()) {
                    const result = extracted.get(submission.source);
                    const sourceName = entries.find(([, source]) => source === submission.source)?.[0];
                    const operations = operationSets[index];
                    if (result === undefined || sourceName === undefined || operations === undefined) {
                        return yield* new GenerationError({
                            stage: 'emission',
                            message: `Missing operation context for ${name}.`,
                        });
                    }
                    yield* claim(
                        yield* generationStep('emission', () =>
                            config.framework.actions(operations, result, {
                                ...context,
                                submission: name,
                                ...(entries.length > 1 ? { source: sourceName } : {}),
                                output: {
                                    ...context.output,
                                    ...(submissions.length > 1 && context.output.actions !== undefined
                                        ? { actions: path.join(context.output.actions, name) }
                                        : {}),
                                },
                            }),
                        ),
                    );
                }
                const obsolete = yield* obsoleteFiles(fs, context, new Set(paths.keys()));
                if (options.check === true && obsolete.length > 0) {
                    return yield* new GenerationError({
                        stage: 'drift',
                        message: `Obsolete generated files:\n${obsolete.join('\n')}`,
                    });
                }
                yield* update(fs, files, options.check === true);
                yield* Effect.forEach(obsolete, (file) => fs.remove(file), { concurrency: 'unbounded' });
            }
            return { manifest, files: files.map((file) => file.path), diagnostics };
        }),
    );
}

function generatedIn(
    fs: FileSystem.FileSystem,
    directory: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> {
    return Effect.gen(function* findGenerated() {
        const entries = yield* missing(fs.readDirectory(directory), []);
        const files = yield* Effect.forEach(
            entries,
            (entry) =>
                Effect.gen(function* inspectEntry() {
                    const file = path.join(directory, entry);
                    // The platform stat operation follows links. Probe links first so cleanup
                    // never traverses an output symlink into another application's files.
                    const link = yield* Effect.catchIf(
                        fs.readLink(file),
                        (error) => {
                            const { cause } = error.reason;
                            return (
                                typeof cause === 'object' &&
                                cause !== null &&
                                'code' in cause &&
                                cause.code === 'EINVAL'
                            );
                        },
                        () => Effect.succeed(null),
                    );
                    if (link !== null) {
                        return [];
                    }
                    const stat = yield* fs.stat(file);
                    if (stat.type === 'Directory') {
                        return yield* generatedIn(fs, file);
                    }
                    if (stat.type === 'File' && file.endsWith('.ts')) {
                        const contents = yield* fs.readFileString(file);
                        if (contents.startsWith('// Generated by Fieldwork.')) {
                            return [file];
                        }
                    }
                    return [];
                }),
            { concurrency: 'unbounded' },
        );
        return files.flat();
    });
}

function obsoleteFiles(
    fs: FileSystem.FileSystem,
    context: { root: string; output: FieldworkConfig['output'] },
    expected: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<string>, PlatformError> {
    const directories = [context.output.forms, context.output.actions].filter((directory) => directory !== undefined);
    return Effect.map(
        Effect.forEach(directories, (directory) => generatedIn(fs, path.resolve(context.root, directory)), {
            concurrency: 'unbounded',
        }),
        (found) => [...new Set(found.flat())].filter((file) => !expected.has(file)),
    );
}
