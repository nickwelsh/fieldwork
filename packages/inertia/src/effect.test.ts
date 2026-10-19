import { describe, expect, it, vi } from 'vite-plus/test';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { http, HttpNetworkError, NavigationError, router } from '@inertiajs/core';
import type {
    HttpRequestConfig,
    HttpResponse,
    NavigationFailure,
    Page,
    VisitOptions,
    VisitOutcome,
} from '@inertiajs/core';
import type { SubmissionContext, SubmissionResult, UploadProgress } from '@formbraid/core';
import { inertia } from './effect.js';
import type { InertiaEffectOptions, InertiaEffectRouter } from './effect.js';

vi.setConfig({ testTimeout: 10_000 });

const page: Page = {
    component: 'Profile',
    props: { errors: {} },
    url: '/users',
    version: null,
    rescuedProps: [],
    flash: {},
    rememberedState: {},
};
const response: HttpResponse = { status: 503, data: 'Unavailable', headers: {} };
const networkError = new HttpNetworkError('Offline', '/users');

function setup(visitOptions: InertiaEffectOptions['visit'] = {}, nativeRelease?: (options: VisitOptions) => void) {
    const outcome = Deferred.makeUnsafe<VisitOutcome, NavigationFailure>();
    const started = Deferred.makeUnsafe<boolean>();
    const released = vi.fn<() => void>();
    let callbacks: VisitOptions = {};
    const visitEffect = vi.fn<InertiaEffectRouter['visitEffect']>((_url, options) =>
        Effect.gen(function* controlledVisit() {
            callbacks = options;
            yield* Deferred.succeed(started, true);
            return yield* Deferred.await(outcome);
        }).pipe(
            Effect.ensuring(
                Effect.sync(() => {
                    nativeRelease?.(options);
                    released();
                }),
            ),
        ),
    );
    const driver = inertia({ router: { visitEffect }, visit: visitOptions });
    const controller = new AbortController();
    const request: SubmissionContext = {
        data: { name: 'Nick' },
        binding: { kind: 'http', url: '/users', method: 'post' },
        signal: controller.signal,
    };
    return { driver, controller, request, visitEffect, started, outcome, released, callbacks: () => callbacks };
}

const outcomeCases: ReadonlyArray<readonly [VisitOutcome, SubmissionResult]> = [
    [{ _tag: 'Success', page }, { status: 'success' }],
    [
        { _tag: 'Validation', page, errors: { name: 'Required' } },
        { status: 'invalid', errors: { name: 'Required' } },
    ],
    [
        { _tag: 'HttpException', response },
        { status: 'failure', error: response },
    ],
    [
        { _tag: 'NetworkError', error: networkError },
        { status: 'failure', error: networkError },
    ],
    [{ _tag: 'Cancelled' }, { status: 'cancelled' }],
    [{ _tag: 'Interrupted' }, { status: 'cancelled' }],
    [{ _tag: 'Prevented' }, { status: 'cancelled' }],
    [{ _tag: 'Discarded', page }, { status: 'cancelled' }],
    [{ _tag: 'Redirected', url: '/login' }, { status: 'cancelled' }],
];

function publicRouterSetup(render: (next: Page, initial: boolean) => Effect.Effect<unknown>) {
    const originalClient = http.getClient();
    const originalUrl = globalThis.window.location.href;
    const originalHistory: unknown = globalThis.window.history.state;
    const scroll = vi.spyOn(globalThis.window, 'scrollTo').mockImplementation(vi.fn<() => void>());
    const requested = Deferred.makeUnsafe<HttpRequestConfig>();
    const responseGate = Deferred.makeUnsafe<HttpResponse>();
    const released = vi.fn<() => void>();
    const request = vi.fn<() => Promise<HttpResponse>>(
        async () => await Effect.runPromise(Deferred.await(responseGate)),
    );
    http.setClient({
        request,
        requestEffect: (config) =>
            Effect.gen(function* controlledHttpRequest() {
                yield* Deferred.succeed(requested, config);
                return yield* Deferred.await(responseGate);
            }).pipe(Effect.ensuring(Effect.sync(released))),
    });
    globalThis.window.history.replaceState({}, '', '/start');
    router.init<string>({
        initialPage: { ...page, url: '/start' },
        resolveComponent: (name) => name,
        swapComponent: ({ page: next, initialRender }) => render(next, initialRender),
    });
    return {
        requested,
        responseGate,
        released,
        request,
        cleanup: () => {
            router.teardown();
            http.setClient(originalClient);
            globalThis.window.history.replaceState(originalHistory, '', originalUrl);
            scroll.mockRestore();
        },
    };
}

describe('native Inertia Effect submission', () => {
    it.each(outcomeCases)('maps the native outcome %j without observing callbacks', async (outcome, expected) => {
        expect.hasAssertions();
        const fixture = setup();
        const remove = vi.spyOn(fixture.controller.signal, 'removeEventListener');
        const fiber = Effect.runFork(fixture.driver.submit(fixture.request));
        await Effect.runPromise(Deferred.await(fixture.started));
        Deferred.doneUnsafe(fixture.outcome, Effect.succeed(outcome));
        const result = await Effect.runPromise(Fiber.join(fiber));
        expect(result).toStrictEqual(expected);
        expect(fixture.released).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it.each([
        { outcome: { _tag: 'HttpException', response } satisfies VisitOutcome, error: response },
        { outcome: { _tag: 'NetworkError', error: networkError } satisfies VisitOutcome, error: networkError },
    ])('retains the native transport failure object for %j', async ({ outcome, error }) => {
        expect.hasAssertions();
        const fixture = setup();
        const fiber = Effect.runFork(fixture.driver.submit(fixture.request));
        await Effect.runPromise(Deferred.await(fixture.started));
        Deferred.doneUnsafe(fixture.outcome, Effect.succeed(outcome));
        const result = await Effect.runPromise(Fiber.join(fiber));
        expect(result.status).toBe('failure');
        expect(Reflect.get(result, 'error')).toBe(error);
    });

    it('starts lazily and waits for native completion after legacy observer callbacks', async () => {
        expect.hasAssertions();
        const onSuccess = vi.fn<() => void>();
        const onError = vi.fn<() => void>();
        const onCancel = vi.fn<() => void>();
        const fixture = setup({ preserveScroll: true, errorBag: 'profile', onSuccess, onError, onCancel });
        const submit = fixture.driver.submit(fixture.request);
        expect(fixture.visitEffect).not.toHaveBeenCalled();
        const fiber = Effect.runFork(submit);
        await Effect.runPromise(Deferred.await(fixture.started));
        expect(fixture.visitEffect).toHaveBeenCalledWith(
            '/users',
            expect.objectContaining({
                method: 'post',
                data: fixture.request.data,
                preserveScroll: true,
                errorBag: 'profile',
                onSuccess,
            }),
        );
        fixture.callbacks().onSuccess?.(page);
        fixture.callbacks().onError?.({ name: 'Transient callback' });
        fixture.callbacks().onCancel?.();
        expect([onSuccess.mock.calls.length, onError.mock.calls.length, onCancel.mock.calls.length]).toStrictEqual([
            1, 1, 1,
        ]);
        expect([fiber.pollUnsafe(), fixture.released.mock.calls.length]).toStrictEqual([undefined, 0]);
        Deferred.doneUnsafe(fixture.outcome, Effect.succeed({ _tag: 'Success', page }));
        await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toStrictEqual({ status: 'success' });
    });

    it('maps typed native navigation failures while preserving their identity', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const failure = new NavigationError(new Error('Render failed'));
        const fiber = Effect.runFork(fixture.driver.submit(fixture.request));
        await Effect.runPromise(Deferred.await(fixture.started));
        Deferred.doneUnsafe(fixture.outcome, Effect.fail(failure));
        const result = await Effect.runPromise(Fiber.join(fiber));
        expect(result).toStrictEqual({ status: 'failure', error: failure });
        expect(Reflect.get(result, 'error')).toBe(failure);
        expect(fixture.released).toHaveBeenCalledTimes(1);
    });

    it('preserves native defects and cleans up its abort listener', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const remove = vi.spyOn(fixture.controller.signal, 'removeEventListener');
        const defect = new Error('Native defect');
        const fiber = Effect.runFork(fixture.driver.submit(fixture.request));
        await Effect.runPromise(Deferred.await(fixture.started));
        Deferred.doneUnsafe(fixture.outcome, Effect.die(defect));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        const preserved = Exit.match(exit, {
            onSuccess: () => null,
            onFailure: (cause) => cause.reasons.find(Cause.isDieReason)?.defect,
        });
        expect(preserved).toBe(defect);
        expect(fixture.released).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('normalizes progress while active and suppresses late reports after completion', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const fiber = Effect.runFork(fixture.driver.submit({ ...fixture.request, onProgress: progress }));
        await Effect.runPromise(Deferred.await(fixture.started));
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The native callback may report an absent progress event.
        fixture.callbacks().onProgress?.(undefined);
        fixture.callbacks().onProgress?.({ loaded: 3, total: undefined, progress: undefined });
        fixture.callbacks().onProgress?.({ loaded: 5, total: 10, percentage: 50, progress: 0.5 });
        Deferred.doneUnsafe(fixture.outcome, Effect.succeed({ _tag: 'Success', page }));
        await Effect.runPromise(Fiber.join(fiber));
        fixture.callbacks().onProgress?.({ loaded: 10, total: 10, percentage: 100, progress: 1 });
        expect(progress.mock.calls).toStrictEqual([
            [{ loaded: 3, total: 0 }],
            [{ loaded: 5, total: 10, percentage: 50 }],
        ]);
    });

    it('aborts the native effect, suppresses cleanup progress and removes its listener', async () => {
        expect.hasAssertions();
        const fixture = setup({}, (options) => {
            options.onProgress?.({ loaded: 9, total: 10, progress: 0.9 });
        });
        const add = vi.spyOn(fixture.controller.signal, 'addEventListener');
        const remove = vi.spyOn(fixture.controller.signal, 'removeEventListener');
        const progress = vi.fn<(value: UploadProgress) => void>();
        const fiber = Effect.runFork(fixture.driver.submit({ ...fixture.request, onProgress: progress }));
        await Effect.runPromise(Deferred.await(fixture.started));
        fixture.controller.abort();
        await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toStrictEqual({ status: 'cancelled' });
        fixture.callbacks().onProgress?.({ loaded: 10, total: 10, progress: 1 });
        expect(progress).not.toHaveBeenCalled();
        expect(fixture.released).toHaveBeenCalledTimes(1);
        const abortListener = add.mock.calls.find(([name]) => name === 'abort')?.[1];
        expect(abortListener).toBeDefined();
        expect(remove).toHaveBeenCalledWith('abort', abortListener);
    });

    it('interrupts only its own visit and suppresses progress while native cleanup runs', async () => {
        expect.hasAssertions();
        const first = setup({}, (options) => {
            options.onProgress?.({ loaded: 9, total: 10, progress: 0.9 });
        });
        const second = setup();
        const remove = vi.spyOn(first.controller.signal, 'removeEventListener');
        const progress = vi.fn<(value: UploadProgress) => void>();
        const firstFiber = Effect.runFork(first.driver.submit({ ...first.request, onProgress: progress }));
        const secondFiber = Effect.runFork(second.driver.submit(second.request));
        await Effect.runPromise(Effect.all([Deferred.await(first.started), Deferred.await(second.started)]));
        await Effect.runPromise(Fiber.interrupt(firstFiber));
        first.callbacks().onProgress?.({ loaded: 10, total: 10, progress: 1 });
        expect([
            first.released.mock.calls.length,
            second.released.mock.calls.length,
            secondFiber.pollUnsafe(),
        ]).toStrictEqual([1, 0, undefined]);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        Deferred.doneUnsafe(second.outcome, Effect.succeed({ _tag: 'Success', page }));
        await expect(Effect.runPromise(Fiber.join(secondFiber))).resolves.toStrictEqual({ status: 'success' });
        expect(progress).not.toHaveBeenCalled();
    });

    it('does not invoke native navigation for an already aborted signal', async () => {
        expect.hasAssertions();
        const fixture = setup();
        fixture.controller.abort();
        await expect(Effect.runPromise(fixture.driver.submit(fixture.request))).resolves.toStrictEqual({
            status: 'cancelled',
        });
        expect(fixture.visitEffect).not.toHaveBeenCalled();
    });

    it('skips navigation when a payload getter aborts synchronously', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const data = {
            get name() {
                fixture.controller.abort();
                return 'Cancelled';
            },
        };
        await expect(Effect.runPromise(fixture.driver.submit({ ...fixture.request, data }))).resolves.toStrictEqual({
            status: 'cancelled',
        });
        expect(fixture.visitEffect).not.toHaveBeenCalled();
    });

    it.each([null, { kind: 'other' }, { kind: 'http', url: '/users', method: 'HEAD' }])(
        'rejects an invalid binding before native navigation: %j',
        async (binding) => {
            expect.hasAssertions();
            const fixture = setup();
            await expect(
                Effect.runPromise(fixture.driver.submit({ ...fixture.request, binding })),
            ).resolves.toMatchObject({ status: 'failure' });
            expect(fixture.visitEffect).not.toHaveBeenCalled();
        },
    );

    it.each([new Map([['key', 'value']]), [], { count: Infinity }, { date: new Date('invalid') }])(
        'rejects an unserializable payload before native navigation: %j',
        async (data) => {
            expect.hasAssertions();
            const fixture = setup();
            await expect(Effect.runPromise(fixture.driver.submit({ ...fixture.request, data }))).resolves.toMatchObject(
                { status: 'failure' },
            );
            expect(fixture.visitEffect).not.toHaveBeenCalled();
        },
    );

    it('accepts nested bigint values supported by the native fork serializer', async () => {
        expect.hasAssertions();
        const fixture = setup();
        const data = { rows: [{ id: 1n, balance: 42n }] };
        const fiber = Effect.runFork(fixture.driver.submit({ ...fixture.request, data }));
        await Effect.runPromise(Deferred.await(fixture.started));
        expect(fixture.callbacks().data).toBe(data);
        Deferred.doneUnsafe(fixture.outcome, Effect.succeed({ _tag: 'Success', page }));
        await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toStrictEqual({ status: 'success' });
    });

    it('maps a real native router prevention into a cancelled submission', async () => {
        expect.hasAssertions();
        const before = vi.fn<() => boolean>(() => false);
        const controller = new AbortController();
        await expect(
            Effect.runPromise(
                inertia({ visit: { onBefore: before } }).submit({
                    data: {},
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: controller.signal,
                }),
            ),
        ).resolves.toStrictEqual({ status: 'cancelled' });
        expect(before).toHaveBeenCalledTimes(1);
        expect(router.visitEffect).toBeTypeOf('function');
    });

    it('waits for the public router renderer acknowledgement after a native HTTP response', async () => {
        expect.hasAssertions();
        const rendering = Deferred.makeUnsafe<boolean>();
        const acknowledgement = Deferred.makeUnsafe<boolean>();
        const fixture = publicRouterSetup((_next, initial) =>
            // oxlint-disable-next-line vitest/no-conditional-in-test -- Only subsequent native renders wait for the test's DOM acknowledgement.
            initial ? Effect.void : Effect.andThen(Deferred.succeed(rendering, true), Deferred.await(acknowledgement)),
        );
        const onSuccess = vi.fn<() => void>();
        try {
            await Effect.runPromise(router.readyEffect());
            const fiber = Effect.runFork(
                inertia({ visit: { onSuccess } }).submit({
                    data: { name: 'Nick' },
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: new AbortController().signal,
                }),
            );
            const config = await Effect.runPromise(Deferred.await(fixture.requested));
            expect(config).toMatchObject({ method: 'post', data: { name: 'Nick' } });
            Deferred.doneUnsafe(
                fixture.responseGate,
                Effect.succeed({
                    status: 200,
                    data: JSON.stringify(page),
                    headers: { 'x-inertia': 'true' },
                }),
            );
            await Effect.runPromise(Deferred.await(rendering));
            expect([fiber.pollUnsafe(), onSuccess.mock.calls.length]).toStrictEqual([undefined, 0]);
            Deferred.doneUnsafe(acknowledgement, Effect.succeed(true));
            await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toStrictEqual({ status: 'success' });
            expect([
                onSuccess.mock.calls.length,
                fixture.released.mock.calls.length,
                fixture.request.mock.calls.length,
            ]).toStrictEqual([1, 1, 0]);
        } finally {
            Deferred.doneUnsafe(acknowledgement, Effect.succeed(true));
            fixture.cleanup();
        }
    });

    it('interrupts the public router transport and stops upload reports on external abort', async () => {
        expect.hasAssertions();
        const fixture = publicRouterSetup(() => Effect.void);
        const controller = new AbortController();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const reported = Deferred.makeUnsafe<boolean>();
        const data = new FormData();
        data.append('avatar', new File(['avatar'], 'avatar.png'));
        try {
            await Effect.runPromise(router.readyEffect());
            const fiber = Effect.runFork(
                inertia().submit({
                    data,
                    binding: { kind: 'http', url: '/users', method: 'post' },
                    signal: controller.signal,
                    onProgress: (value) => {
                        progress(value);
                        Deferred.doneUnsafe(reported, Effect.succeed(true));
                    },
                }),
            );
            const config = await Effect.runPromise(Deferred.await(fixture.requested));
            config.onUploadProgress?.({ loaded: 3, total: 10, progress: 0.3 });
            await Effect.runPromise(Deferred.await(reported));
            controller.abort();
            await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toStrictEqual({ status: 'cancelled' });
            expect(config.signal?.aborted).toBe(true);
            expect(fixture.released).toHaveBeenCalledTimes(1);
            config.onUploadProgress?.({ loaded: 10, total: 10, progress: 1 });
            expect(progress.mock.calls).toStrictEqual([[{ loaded: 3, total: 10 }]]);
            expect(fixture.request).not.toHaveBeenCalled();
        } finally {
            controller.abort();
            fixture.cleanup();
        }
    });
});
