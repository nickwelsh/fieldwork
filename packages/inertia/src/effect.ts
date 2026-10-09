import type { SubmissionDriver, SubmissionResult } from '@fieldwork/core';
import { router as defaultRouter } from '@inertiajs/core';
import type { NavigationFailure, VisitOptions, VisitOutcome } from '@inertiajs/core';
import { Deferred, Effect, Fiber } from 'effect';
import { isEffectPayload, isHttpBinding } from './payload.js';

export interface InertiaEffectRouter {
    readonly visitEffect: (url: string, options: VisitOptions) => Effect.Effect<VisitOutcome, NavigationFailure>;
}

export interface InertiaEffectOptions {
    readonly router?: InertiaEffectRouter;
    readonly visit?: Omit<VisitOptions, 'method' | 'data' | 'onProgress'>;
}

function submissionResult(outcome: VisitOutcome): SubmissionResult {
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Native Inertia outcomes use tagged unions.
    switch (outcome._tag) {
        case 'Success': {
            return { status: 'success' };
        }
        case 'Validation': {
            return { status: 'invalid', errors: outcome.errors };
        }
        case 'HttpException': {
            return { status: 'failure', error: outcome.response };
        }
        case 'NetworkError': {
            return { status: 'failure', error: outcome.error };
        }
        case 'Cancelled':
        case 'Interrupted':
        case 'Prevented':
        case 'Discarded':
        case 'Redirected': {
            // Redirects initiate another navigation without awaiting its validation/commit.
            return { status: 'cancelled' };
        }
        default: {
            const unhandled: never = outcome;
            throw new Error(`Unknown Inertia outcome: ${String(unhandled)}`);
        }
    }
}

/** Compose Inertia Effect's navigation in the submitting fiber. */
export function inertia(options: InertiaEffectOptions = {}): SubmissionDriver {
    const router: InertiaEffectRouter = options.router ?? defaultRouter;
    return {
        submit: ({ data, binding, signal, onProgress }) =>
            Effect.gen(function* submitVisit() {
                if (signal.aborted) {
                    return { status: 'cancelled' } as const;
                }
                if (!isHttpBinding(binding)) {
                    return {
                        status: 'failure',
                        error: new Error('Inertia requires an HTTP operation binding.'),
                    } as const;
                }
                if (!isEffectPayload(data)) {
                    return {
                        status: 'failure',
                        error: new Error('The form contains values Inertia cannot serialize.'),
                    } as const;
                }
                const cancelled = yield* Deferred.make<SubmissionResult>();
                let active = true;
                const abort = (): void => {
                    active = false;
                    Deferred.doneUnsafe(cancelled, Effect.succeed({ status: 'cancelled' }));
                };
                return yield* Effect.acquireUseRelease(
                    Effect.sync(() => {
                        signal.addEventListener('abort', abort, { once: true });
                        // Payload getters and listener registration can abort synchronously.
                        if (signal.aborted) {
                            abort();
                        }
                    }),
                    () =>
                        Effect.uninterruptibleMask((restore) =>
                            Effect.gen(function* ownVisit() {
                                if (!active) {
                                    return { status: 'cancelled' } as const;
                                }
                                const visit = yield* Effect.forkChild(
                                    Effect.interruptible(
                                        Effect.suspend(() =>
                                            router
                                                .visitEffect(binding.url, {
                                                    ...options.visit,
                                                    method: binding.method,
                                                    data,
                                                    onProgress: (progress) => {
                                                        if (active && !signal.aborted && progress !== undefined) {
                                                            onProgress?.({
                                                                loaded: progress.loaded,
                                                                total: progress.total ?? 0,
                                                                ...(progress.percentage === undefined
                                                                    ? {}
                                                                    : { percentage: progress.percentage }),
                                                            });
                                                        }
                                                    },
                                                })
                                                .pipe(
                                                    Effect.map(submissionResult),
                                                    Effect.catch((error) =>
                                                        Effect.succeed({ status: 'failure', error } as const),
                                                    ),
                                                ),
                                        ),
                                    ),
                                );
                                return yield* restore(
                                    Effect.raceFirst(Fiber.join(visit), Deferred.await(cancelled)),
                                ).pipe(
                                    Effect.ensuring(
                                        Effect.gen(function* releaseVisit() {
                                            // Disable callbacks before native interruption finalizers run.
                                            active = false;
                                            yield* Fiber.interrupt(visit);
                                        }),
                                    ),
                                );
                            }),
                        ),
                    () =>
                        Effect.sync(() => {
                            active = false;
                            signal.removeEventListener('abort', abort);
                        }),
                );
            }),
    };
}
