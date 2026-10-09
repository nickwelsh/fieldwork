import { Effect } from 'effect';
import type { FileSystem, PlatformError, Scope } from 'effect';
import type { FrameworkDriver, GenerationError, OperationProvider, SourceDriver } from './contracts.js';
import { defineConfig, defineSubmission } from './contracts.js';
import { generate } from './generate.js';
import type { GenerationResult } from './generate.js';

interface SourceFailure {
    readonly sourceFailure: true;
}
interface OtherFailure {
    readonly otherFailure: true;
}
interface OperationFailure {
    readonly operationFailure: true;
}
interface SourceService {
    readonly sourceService: true;
}
interface OtherService {
    readonly otherService: true;
}
interface OperationService {
    readonly operationService: true;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Quantified functions test exact type identity, including accidental any/unknown widening.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Distinct source/provider error and service types compose without widening or explicit config annotations. */
export function GeneratorTypeProof(
    app: SourceDriver<SourceFailure, SourceService | Scope.Scope>,
    external: SourceDriver<OtherFailure, OtherService>,
    options: {
        readonly bindings: OperationProvider<{ mutation: string }, OperationFailure, OperationService | Scope.Scope>;
        readonly framework: FrameworkDriver;
    },
) {
    const { bindings, framework } = options;
    const submission = defineSubmission({ bindings, emitBinding: (operation) => JSON.stringify(operation.binding) });
    const config = defineConfig({
        sources: { app, external },
        submissions: { submission },
        framework,
        output: { forms: 'forms' },
    });
    const preservedSource: typeof app = config.sources.app;
    const program = generate(config, { root: '.' });
    const preserved: Effect.Effect<
        GenerationResult,
        SourceFailure | OtherFailure | OperationFailure | GenerationError | PlatformError.PlatformError,
        SourceService | OtherService | OperationService | FileSystem.FileSystem
    > = program;
    const exactErrors: Equal<
        Effect.Error<typeof program>,
        SourceFailure | OtherFailure | OperationFailure | GenerationError | PlatformError.PlatformError
    > = true;
    const exactServices: Equal<
        Effect.Services<typeof program>,
        SourceService | OtherService | OperationService | FileSystem.FileSystem
    > = true;
    // @ts-expect-error Required source/provider services cannot be omitted at the execution boundary.
    void Effect.runPromise(program);
    // @ts-expect-error Source and operation failures cannot disappear from the composed error channel.
    const lostErrors: Effect.Effect<
        GenerationResult,
        GenerationError | PlatformError.PlatformError,
        Effect.Services<typeof program>
    > = program;
    return { preserved, preservedSource, lostErrors, exactErrors, exactServices };
}
