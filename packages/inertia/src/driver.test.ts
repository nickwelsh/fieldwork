import { vi, describe, expect, it } from 'vite-plus/test';

import { Effect, Fiber } from 'effect';
import { router } from '@inertiajs/core';
import type { GlobalEvent, PendingVisit } from '@inertiajs/core';
import type { UploadProgress } from '@fieldwork/core';

import type { InertiaOptions, InertiaVisitOptions } from './driver.js';

import { inertia } from './driver.js';

vi.setConfig({ testTimeout: 10_000 });

function setup(visitOptions: InertiaOptions['visit'] = {}) {
    let callbacks: InertiaVisitOptions = {};
    const visit = vi.fn<(url: string | URL, options?: InertiaVisitOptions) => void>(
        (_url: string | URL, options?: InertiaVisitOptions) => {
            callbacks = options ?? {};
        },
    );
    const driver = inertia({
        router: { visit },
        visit: { preserveScroll: true, errorBag: 'profile', ...visitOptions },
    });
    const controller = new AbortController();
    return { driver, controller, visit, callbacks: () => callbacks };
}

function pendingVisit(url: string): PendingVisit {
    return {
        id: url,
        url: new URL(url, 'http://localhost'),
        method: 'post',
        data: {},
        replace: false,
        preserveScroll: false,
        preserveState: false,
        only: [],
        except: [],
        headers: {},
        errorBag: '',
        forceFormData: false,
        queryStringArrayFormat: 'brackets',
        async: true,
        showProgress: false,
        prefetch: false,
        fresh: false,
        reset: [],
        preserveUrl: false,
        preserveErrors: false,
        invalidateCacheTags: [],
        viewTransition: false,
        component: null,
        pageProps: null,
        cached: false,
        completed: false,
        cancelled: false,
        interrupted: false,
    };
}

describe('inertia submission lifecycle', () => {
    it('reports a throwing start observer and completes with the transport outcome', async () => {
        expect.hasAssertions();
        const error = new Error('Start observer failed');
        const report = vi.fn<(error: unknown) => void>();
        vi.stubGlobal('reportError', report);
        const fixture = setup({
            onStart: () => {
                throw error;
            },
        });
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        const cancel = vi.fn<() => void>();
        fixture.callbacks().onCancelToken?.({ cancel });
        try {
            expect(() => fixture.callbacks().onStart?.(pendingVisit('/users'))).not.toThrow();
            expect(report).toHaveBeenCalledWith(error);
            fixture.callbacks().onSuccess?.();
            fixture.callbacks().onFinish?.();
            await expect(pending).resolves.toStrictEqual({ status: 'success' });
            expect(cancel).not.toHaveBeenCalled();
        } finally {
            fixture.controller.abort();
            vi.unstubAllGlobals();
        }
    });

    it('preserves cancellation when a start observer aborts and then throws', async () => {
        expect.hasAssertions();
        const fixture = setup({
            onStart: () => {
                fixture.controller.abort();
                throw new Error('After cancellation');
            },
        });
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        const cancel = vi.fn<() => void>();
        fixture.callbacks().onCancelToken?.({ cancel });
        expect(() => fixture.callbacks().onStart?.(pendingVisit('/users'))).not.toThrow();
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('forwards a successful start observer and waits for the transport outcome', async () => {
        expect.hasAssertions();
        const onStart = vi.fn<() => void>();
        const fixture = setup({ onStart });
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        const visit = pendingVisit('/users');
        fixture.callbacks().onStart?.(visit);
        expect(onStart).toHaveBeenCalledWith(visit);
        fixture.callbacks().onSuccess?.();
        fixture.callbacks().onFinish?.();
        await expect(pending).resolves.toStrictEqual({ status: 'success' });
    });

    it('vetoes acceptance when the Effect is interrupted during before dispatch', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const fiber = Effect.runFork(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        const visit = pendingVisit('/users');
        const remove = router.on('before', () => {
            Effect.runFork(Fiber.interrupt(fiber));
        });
        try {
            expect(fixture.callbacks().onBefore?.(visit)).toBe(true);
            const event = new CustomEvent('inertia:before', { cancelable: true, detail: { visit } });
            expect(document.dispatchEvent(event)).toBe(false);
            const cancel = vi.fn<() => void>();
            fixture.callbacks().onCancelToken?.({ cancel });
            await Effect.runPromise(Fiber.await(fiber));
            expect(cancel).toHaveBeenCalledTimes(1);
        } finally {
            remove();
        }
    });

    it('observes an asynchronously dispatched native veto and rejects late acceptance after interruption', async () => {
        expect.hasAssertions();
        const before = vi.fn<(event: GlobalEvent<'before'>) => boolean>((event) => {
            event.stopImmediatePropagation();
            return false;
        });
        const remove = router.on('before', before);
        const visit = vi.fn<(url: string, options: InertiaVisitOptions) => void>((url, options) => {
            queueMicrotask(() => {
                router.visit(url, options);
            });
        });
        const driver = inertia({ router: { visit } });
        const request = {
            data: {},
            binding: { kind: 'http', url: '/users', method: 'post' },
            signal: new AbortController().signal,
        } as const;
        try {
            await expect(Effect.runPromise(driver.submit(request))).resolves.toStrictEqual({ status: 'cancelled' });
            expect(before).toHaveBeenCalledTimes(1);
            const fiber = Effect.runFork(driver.submit(request));
            await Effect.runPromise(Fiber.interrupt(fiber));
            await Promise.resolve();
            expect(visit).toHaveBeenCalledTimes(2);
            expect(before).toHaveBeenCalledTimes(1);
        } finally {
            remove();
        }
    });

    it('skips a visit when reading its payload synchronously aborts the caller', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const data = {
            get name() {
                fixture.controller.abort();
                return 'cancelled';
            },
        };
        await expect(
            Effect.runPromise(
                fixture.driver.submit({
                    data,
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: fixture.controller.signal,
                }),
            ),
        ).resolves.toStrictEqual({ status: 'cancelled' });
        expect(fixture.visit).not.toHaveBeenCalled();
    });

    it('vetoes native acceptance when the caller aborts during global before dispatch', async () => {
        expect.hasAssertions();
        const controller = new AbortController();
        const observed: { event: GlobalEvent<'before'> | undefined } = { event: undefined };
        const remove = router.on('before', (event) => {
            observed.event = event;
            controller.abort();
        });
        try {
            await expect(
                Effect.runPromise(
                    inertia().submit({
                        data: {},
                        binding: { kind: 'http', url: '/users', method: 'post' },
                        signal: controller.signal,
                    }),
                ),
            ).resolves.toStrictEqual({ status: 'cancelled' });
            expect(observed.event?.defaultPrevented).toBe(true);
        } finally {
            remove();
        }
    });

    it.each([new Map([['enabled', true]]), new Set(['enabled']), Number.NaN, Infinity, new Date('invalid')])(
        'rejects values that would lose their meaning during serialization: %s',
        async (value) => {
            expect.hasAssertions();
            const fixture = setup();
            await expect(
                Effect.runPromise(
                    fixture.driver.submit({
                        data: { settings: value },
                        binding: { kind: 'http', url: '/users', method: 'post' },
                        signal: fixture.controller.signal,
                    }),
                ),
            ).resolves.toMatchObject({ status: 'failure' });
            expect(fixture.visit).not.toHaveBeenCalled();
        },
    );

    it.each([new Date(), new Blob(['value']), new File(['value'], 'value.txt'), []])(
        'rejects a non-record root payload: %s',
        async (data) => {
            expect.hasAssertions();
            const fixture = setup();
            await expect(
                Effect.runPromise(
                    fixture.driver.submit({
                        data,
                        binding: { kind: 'http', url: '/users', method: 'post' },
                        signal: fixture.controller.signal,
                    }),
                ),
            ).resolves.toMatchObject({ status: 'failure' });
            expect(fixture.visit).not.toHaveBeenCalled();
        },
    );

    it('rejects cyclic containers while accepting shared acyclic records and native payload values', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const cyclic: { self?: object } = {};
        cyclic.self = cyclic;
        await expect(
            Effect.runPromise(
                fixture.driver.submit({
                    data: cyclic,
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: fixture.controller.signal,
                }),
            ),
        ).resolves.toMatchObject({ status: 'failure' });
        expect(fixture.visit).not.toHaveBeenCalled();
        const shared = { enabled: true };
        const data = { records: [shared, shared], date: new Date(), file: new File(['avatar'], 'avatar.png') };
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data,
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        fixture.callbacks().onSuccess?.();
        fixture.callbacks().onFinish?.();
        await expect(pending).resolves.toStrictEqual({ status: 'success' });
        expect(fixture.visit.mock.calls[0]?.[1]?.data).toBe(data);
    });

    it.each([false, true])('settles a global before veto with stopped propagation=%s', async (stopped) => {
        expect.hasAssertions();
        const veto = vi.fn<(event: GlobalEvent<'before'>) => boolean>((event) => {
            // oxlint-disable-next-line vitest/no-conditional-in-test -- Exercise ordinary and propagation-stopping vetoes against the native router.
            if (stopped) {
                event.stopImmediatePropagation();
            }
            return false;
        });
        const removeVeto = router.on('before', veto);
        const removeObserver = vi.spyOn(globalThis.window, 'removeEventListener');
        const driver = inertia();
        const controller = new AbortController();
        const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
        try {
            await expect(
                Effect.runPromise(
                    driver.submit({
                        data: {},
                        binding: { kind: 'http', url: '/users', method: 'post' },
                        signal: controller.signal,
                    }),
                ),
            ).resolves.toStrictEqual({ status: 'cancelled' });
            expect(veto).toHaveBeenCalledTimes(1);
            expect(removeObserver).toHaveBeenCalledWith('inertia:before', expect.any(Function), true);
            expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
        } finally {
            removeVeto();
        }
    });

    it('ignores foreign vetoes and waits for a delayed accepted visit when propagation is stopped', async () => {
        expect.hasAssertions();
        const own = pendingVisit('/users');
        const foreign = pendingVisit('/foreign');
        const removeVeto = router.on('before', (event) => {
            event.stopImmediatePropagation();
            return event.detail.visit !== foreign;
        });
        let callbacks: InertiaVisitOptions = {};
        const driver = inertia({
            router: {
                visit: (_url, options) => {
                    callbacks = options;
                    options.onBefore?.(own);
                    document.dispatchEvent(
                        new CustomEvent('inertia:before', { cancelable: true, detail: { visit: foreign } }),
                    );
                    document.dispatchEvent(
                        new CustomEvent('inertia:before', { cancelable: true, detail: { visit: own } }),
                    );
                },
            },
        });
        try {
            const pending = Effect.runPromise(
                driver.submit({
                    data: {},
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: new AbortController().signal,
                }),
            );
            let settled = false;
            const observe = async (): Promise<void> => {
                await pending;
                settled = true;
            };
            void observe();
            await Promise.resolve();
            expect(settled).toBe(false);
            const cancel = vi.fn<() => void>();
            callbacks.onCancelToken?.({ cancel });
            callbacks.onSuccess?.();
            callbacks.onFinish?.();
            await expect(pending).resolves.toStrictEqual({ status: 'success' });
            expect(cancel).not.toHaveBeenCalled();
        } finally {
            removeVeto();
        }
    });

    it('waits for finish and forwards visit options, files, and scoped errors', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const file = new File(['avatar'], 'avatar.png');
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: { avatar: file },
                binding: { kind: 'http', url: '/users/42', method: 'patch' },
                signal: fixture.controller.signal,
            }),
        );
        let finished = false;
        async function observe(): Promise<void> {
            await pending;
            finished = true;
        }
        void observe();
        fixture.callbacks().onError?.({ 'contacts.0.email': 'Already used.' });
        await Promise.resolve();
        expect(finished).toBe(false);
        // Callback arguments unused by the adapter are supplied by Inertia in production.
        fixture.callbacks().onFinish?.();
        await expect(pending).resolves.toStrictEqual({
            status: 'invalid',
            errors: { 'contacts.0.email': 'Already used.' },
        });
        expect(fixture.visit.mock.calls[0]?.[1]).toMatchObject({
            method: 'patch',
            data: { avatar: file },
            preserveScroll: true,
            errorBag: 'profile',
        });
    });

    it('cancels only its own visit and handles cancellation before the token arrives', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        fixture.controller.abort();
        const cancel = vi.fn<() => void>();
        fixture.callbacks().onCancelToken?.({ cancel });
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-HTTP binding before visiting a URL', async () => {
        expect.hasAssertions();
        const fixture = setup();
        await expect(
            Effect.runPromise(
                fixture.driver.submit({
                    data: {},
                    binding: { kind: 'mutation', name: 'save' },
                    signal: fixture.controller.signal,
                }),
            ),
        ).resolves.toMatchObject({ status: 'failure' });
        expect(fixture.visit).not.toHaveBeenCalled();
    });

    it('returns failures for thrown visits and skips already aborted requests', async () => {
        expect.hasAssertions();
        const visit = vi.fn<() => void>(() => {
            throw new Error('Offline');
        });
        const driver = inertia({ router: { visit } });
        const controller = new AbortController();
        await expect(
            Effect.runPromise(
                driver.submit({
                    data: {},
                    binding: { kind: 'http', url: '/', method: 'post' },
                    signal: controller.signal,
                }),
            ),
        ).resolves.toMatchObject({ status: 'failure' });
        controller.abort();
        await expect(
            Effect.runPromise(
                driver.submit({
                    data: {},
                    binding: { kind: 'http', url: '/', method: 'post' },
                    signal: controller.signal,
                }),
            ),
        ).resolves.toStrictEqual({ status: 'cancelled' });
        expect(visit).toHaveBeenCalledTimes(1);
    });

    it('releases an interrupted Effect visit and cancels a late token once', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const progress = vi.fn<(progress: UploadProgress) => void>();
        const fiber = Effect.runFork(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
                onProgress: progress,
            }),
        );
        await Effect.runPromise(Fiber.interrupt(fiber));
        // Late transport callbacks cannot revive an interrupted execution.
        fixture.callbacks().onSuccess?.();
        fixture.callbacks().onProgress?.({ loaded: 10, total: 20, percentage: 50, progress: 0.5 });
        const cancel = vi.fn<() => void>();
        fixture.callbacks().onCancelToken?.({ cancel });
        fixture.callbacks().onFinish?.();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(progress).not.toHaveBeenCalled();
    });

    it('interrupts only one of two concurrent form visits', async () => {
        expect.hasAssertions();
        const first = setup();
        const second = setup();
        const request = { data: {}, binding: { kind: 'http', url: '/users', method: 'post' } } as const;
        const fiber = Effect.runFork(first.driver.submit({ ...request, signal: first.controller.signal }));
        const pending = Effect.runPromise(second.driver.submit({ ...request, signal: second.controller.signal }));
        const cancelFirst = vi.fn<() => void>();
        const cancelSecond = vi.fn<() => void>();
        first.callbacks().onCancelToken?.({ cancel: cancelFirst });
        second.callbacks().onCancelToken?.({ cancel: cancelSecond });
        await Effect.runPromise(Fiber.interrupt(fiber));
        second.callbacks().onSuccess?.();
        second.callbacks().onFinish?.();
        await expect(pending).resolves.toStrictEqual({ status: 'success' });
        expect(cancelFirst).toHaveBeenCalledTimes(1);
        expect(cancelSecond).not.toHaveBeenCalled();
    });

    it('reports a finish without an outcome and releases the abort listener', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const remove = vi.spyOn(fixture.controller.signal, 'removeEventListener');
        const pending = Effect.runPromise(
            fixture.driver.submit({
                data: {},
                binding: { kind: 'http', url: '/users', method: 'post' },
                signal: fixture.controller.signal,
            }),
        );
        fixture.callbacks().onFinish?.();
        await expect(pending).resolves.toMatchObject({ status: 'failure' });
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
});
