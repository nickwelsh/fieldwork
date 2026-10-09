#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Cause, Effect, Stdio, Stream } from 'effect';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { createJiti } from 'jiti';
import { GenerationError, generationStep } from './contracts.js';
import type { FieldworkConfig } from './contracts.js';
import { generate } from './generate.js';

const main = Effect.gen(function* runCli() {
    const stdio = yield* Stdio.Stdio;
    const args = yield* stdio.args;
    const { values, positionals } = yield* generationStep('configuration', () =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                config: { type: 'string', default: 'fieldwork.config.ts' },
                check: { type: 'boolean', default: false },
            },
        }),
    );
    const command = positionals[0] ?? 'generate';
    if (!['generate', 'fields'].includes(command)) {
        yield* new GenerationError({
            stage: 'configuration',
            message: 'Usage: fieldwork <generate|fields> [--config path] [--check]',
        });
    }
    const filename = path.resolve(values.config);
    const config = yield* Effect.tryPromise({
        try: async () =>
            await createJiti(import.meta.url).import<FieldworkConfig<unknown, NodeServices.NodeServices>>(
                pathToFileURL(filename).href,
                { default: true },
            ),
        catch: (cause) =>
            new GenerationError({
                stage: 'configuration',
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
            }),
    });
    const result = yield* generate(config, {
        root: path.dirname(filename),
        check: values.check,
        fieldsOnly: command === 'fields',
    });
    yield* Stream.run(
        Stream.make(`${values.check ? 'Checked' : 'Generated'} ${result.files.length} files.\n`),
        stdio.stdout(),
    );
    if (result.diagnostics.length > 0) {
        yield* Stream.run(
            Stream.fromIterable(result.diagnostics.map((diagnostic) => `${diagnostic}\n`)),
            stdio.stderr(),
        );
    }
});

NodeRuntime.runMain(
    main.pipe(
        Effect.tapCause((cause) =>
            Effect.gen(function* reportFailure() {
                const error = Cause.squash(cause);
                const stdio = yield* Stdio.Stdio;
                yield* Stream.run(
                    Stream.make(`${error instanceof Error ? error.message : String(error)}\n`),
                    stdio.stderr(),
                );
            }),
        ),
        Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
);
