import { isRecord } from '@fieldwork/core';
import type { SubmissionDriver, SubmissionResult } from '@fieldwork/core';
import { router as defaultRouter } from '@inertiajs/core';
import { Effect } from 'effect';
import type { PendingVisit, VisitOptions } from '@inertiajs/core';

import { isHttpBinding, isPayload } from './payload.js';

type ManagedOption =
    | 'method'
    | 'data'
    | 'onBefore'
    | 'onCancelToken'
    | 'onSuccess'
    | 'onError'
    | 'onCancel'
    | 'onFinish'
    | 'onProgress'
    | 'onHttpException'
    | 'onNetworkError';

export type InertiaVisitOptions = Omit<VisitOptions, 'onFinish' | 'onSuccess'> & {
    readonly onFinish?: () => void;
    readonly onSuccess?: () => void;
};
export interface InertiaRouter {
    readonly visit: (url: string, options: InertiaVisitOptions) => void;
}

export interface InertiaOptions {
    readonly router?: InertiaRouter;
    readonly visit?: Omit<VisitOptions, ManagedOption>;
}

export function inertia(options: InertiaOptions = {}): SubmissionDriver {
    const router: InertiaRouter = options.router ?? defaultRouter;
    return {
        submit: ({ data, binding, signal, onProgress }) =>
            Effect.callback<SubmissionResult>((resume): Effect.Effect<void> | undefined => {
                const resolve = (result: SubmissionResult): void => {
                    resume(Effect.succeed(result));
                };
                if (signal.aborted) {
                    resolve({ status: 'cancelled' });
                    return undefined;
                }
                if (!isHttpBinding(binding)) {
                    resolve({ status: 'failure', error: new Error('Inertia requires an HTTP operation binding.') });
                    return undefined;
                }
                if (!isPayload(data)) {
                    resolve({
                        status: 'failure',
                        error: new Error('The form contains values Inertia cannot serialize.'),
                    });
                    return undefined;
                }
                // Reading payload getters can synchronously abort the caller.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- User getters can change the signal after the initial check.
                if (signal.aborted) {
                    resolve({ status: 'cancelled' });
                    return undefined;
                }
                let result: SubmissionResult | null = null;
                let cancel: (() => void) | null = null;
                let settled = false;
                const before: { visit: PendingVisit | undefined; event: Event | undefined } = {
                    visit: undefined,
                    event: undefined,
                };
                let observingBefore = false;
                function finish(fallback?: SubmissionResult): void {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    removeBefore();
                    signal.removeEventListener('abort', abort);
                    resolve(
                        result ??
                            fallback ?? {
                                status: 'failure',
                                error: new Error('The Inertia visit finished without an outcome.'),
                            },
                    );
                }
                function abort(): void {
                    if (settled) {
                        return;
                    }
                    preventAcceptance();
                    result = { status: 'cancelled' };
                    finish();
                    cancel?.();
                }
                signal.addEventListener('abort', abort, { once: true });
                const eventTarget = (globalThis as { readonly window?: Window }).window;
                function preventAcceptance(): void {
                    // During before dispatch no cancel token exists yet, so veto
                    // acceptance before Inertia can perform visit side effects.
                    if (before.event !== undefined && before.event.eventPhase !== 0) {
                        before.event.preventDefault();
                    }
                }
                function removeBefore(): void {
                    if (observingBefore) {
                        observingBefore = false;
                        eventTarget?.removeEventListener('inertia:before', observeBefore, true);
                    }
                }
                function observeBefore(event: Event): void {
                    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
                    if (before.visit !== undefined && isRecord(detail) && detail['visit'] === before.visit) {
                        before.event = event;
                        removeBefore();
                        // Check after all listeners have run, including when an injected
                        // router dispatches before asynchronously after visit() returns.
                        queueMicrotask(() => {
                            if (!settled && event.defaultPrevented) {
                                finish({ status: 'cancelled' });
                            }
                        });
                    }
                }
                try {
                    // Inertia dispatches before on document. Observe its ancestor capture
                    // phase so document listeners cannot hide a veto by stopping propagation.
                    observingBefore = eventTarget !== undefined;
                    eventTarget?.addEventListener('inertia:before', observeBefore, true);
                    router.visit(binding.url, {
                        ...options.visit,
                        method: binding.method,
                        // The core deliberately permits portable object schemas; Inertia performs payload/file conversion.
                        data,
                        onBefore: (visit) => {
                            before.visit = visit;
                            return !settled && !signal.aborted;
                        },
                        onCancelToken: (token) => {
                            cancel = () => {
                                token.cancel();
                            };
                            if (signal.aborted || (settled && result?.status === 'cancelled')) {
                                token.cancel();
                            }
                        },
                        onStart: (visit) => {
                            if (settled) {
                                return;
                            }
                            try {
                                options.visit?.onStart?.(visit);
                            } catch (error) {
                                // Inertia invokes onStart before its async error/finally chain.
                                // Observer failures must not prevent the transport from reaching onFinish.
                                if (typeof reportError === 'function') {
                                    reportError(error);
                                }
                            }
                        },
                        onSuccess: () => {
                            if (!settled) {
                                result = { status: 'success' };
                            }
                        },
                        onError: (errors) => {
                            if (!settled) {
                                result = { status: 'invalid', errors };
                            }
                        },
                        onCancel: () => {
                            if (!settled) {
                                result = { status: 'cancelled' };
                                finish();
                            }
                        },
                        onFinish: () => {
                            finish();
                        },
                        onProgress: (progress) => {
                            if (!settled && progress !== undefined) {
                                onProgress?.({
                                    loaded: progress.loaded,
                                    total: progress.total ?? 0,
                                    ...(progress.percentage === undefined ? {} : { percentage: progress.percentage }),
                                });
                            }
                        },
                        onNetworkError: (error) => {
                            if (!settled) {
                                result = { status: 'failure', error };
                            }
                            return true;
                        },
                        onHttpException: (error) => {
                            if (!settled) {
                                result = { status: 'failure', error };
                            }
                            return true;
                        },
                    });
                    // The global event can be vetoed by a later listener. Dispatch is
                    // synchronous, so inspect the same event after visit() returns.
                    // A veto emits no transport lifecycle callbacks, including finish.
                    if (before.event?.defaultPrevented === true) {
                        finish({ status: 'cancelled' });
                    }
                } catch (error) {
                    finish({ status: 'failure', error });
                }
                // Effect interruption owns the visit even without an external abort.
                return Effect.sync(() => {
                    if (!settled) {
                        preventAcceptance();
                        result = { status: 'cancelled' };
                        settled = true;
                        removeBefore();
                        signal.removeEventListener('abort', abort);
                        cancel?.();
                    }
                });
            }),
    };
}
