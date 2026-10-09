/* oxlint-disable vitest/max-expects -- Each test proves a single lifetime invariant across state, execution and transport outcomes. */
/* oxlint-disable eslint/max-classes-per-file, typescript/class-literal-property-style -- Getter-based class envelopes reproduce valid structural driver results. */
import { Context, Effect, Fiber, Schema as EffectSchema } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createFormSession, defineForm, definitionSchema, normalizePath } from './index.js';
// oxlint-disable-next-line import/no-namespace -- Observe compiler calls to prove identity reuse independently of timing.
import * as validation from './validation.js';
import type { EffectRunner, FieldDefinition, FormState, SubmissionResult, OperationContext } from './index.js';

const definition = defineForm<{ name: string; contacts: Array<{ email: string }>; file: File | null }>()({
    id: 'session',
    defaultValues: { name: 'original', contacts: [{ email: 'one' }, { email: 'two' }], file: null },
    fields: {},
    groups: {},
});
vi.setConfig({ testTimeout: 10_000 });

function deferred<T>() {
    // The constructor installs this test gate's resolver synchronously.
    // oxlint-disable-next-line eslint/init-declarations
    let finish!: (value: T) => void;
    // oxlint-disable-next-line promise/avoid-new -- Tests need explicit completion gates to prove races and cancellation.
    const promise = new Promise<T>((resolve) => {
        finish = resolve;
    });
    return { promise, resolve: finish };
}
const tick = async () => {
    // oxlint-disable-next-line promise/avoid-new -- Yield to deferred transport finalizers.
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
};

describe('effect form sessions', () => {
    it('owns immutable containers and keeps File identity and path equivalence', () => {
        expect.hasAssertions();
        const defaults = { name: 'original', contacts: [{ email: 'one' }], file: new File(['hello'], 'hello.txt') };
        const session = createFormSession({ definition, defaultValues: defaults, operation: () => Effect.void });
        const initial = session.getSnapshot();
        expect(initial.baseline).toBe(initial.values);
        defaults.contacts[0] = { email: 'mutated externally' };
        session.setValue('contacts[0].email', 'edited');
        expect(initial.values.contacts[0]?.email).toBe('one');
        expect(session.getField('contacts.0.email').value).toBe('edited');
        expect(session.getSnapshot().values.file).toBe(defaults.file);
        expect(Object.isFrozen(session.getSnapshot().values.contacts[0])).toBe(true);
        expect(() => normalizePath('contacts[0]trailing')).toThrow('Invalid field path');
        expect(() => normalizePath('constructor.polluted')).toThrow('Invalid field path');
        expect(() => session.setValue('contacts.99.email', 'no')).toThrow('Invalid array index');
    });

    it('validates only on submit and supports native Effect Schema transformations', async () => {
        expect.hasAssertions();
        const count = EffectSchema.NumberFromString.check(EffectSchema.isFinite());
        // oxlint-disable-next-line eslint/new-cap -- Effect Schema constructors are factory functions.
        const countSchema = EffectSchema.Struct({ count });
        const numberDefinition = defineForm<{ count: string }, { count: number }>()({
            id: 'decode',
            defaultValues: { count: '2' },
            fields: {},
            groups: {},
            schema: countSchema,
        });
        const operation = vi.fn<(data: { count: number }, context: OperationContext) => Effect.Effect<number>>((data) =>
            Effect.succeed(data.count + 1),
        );
        const session = createFormSession({ definition: numberDefinition, operation });
        session.setValue('count', 'invalid');
        expect(session.getSnapshot().errors).toStrictEqual({});
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getField('count').errors).toHaveLength(1);
        expect(operation).not.toHaveBeenCalled();
        session.setValue('count', '42');
        await expect(session.submit()).resolves.toStrictEqual({ status: 'success', value: 43 });
        expect(operation.mock.calls[0]?.[0]).toStrictEqual({ count: 42 });
        expect(operation.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
        expect(session.getSnapshot().values.count).toBe('42');
    });

    it('coalesces concurrent submits into one workflow and returns typed failures', async () => {
        expect.hasAssertions();
        const gate = deferred<null>();
        const ran = vi.fn<() => void>();
        const run: EffectRunner = async (effect, options) => {
            ran();
            return await Effect.runPromise(effect, options);
        };
        const operation = vi.fn<() => Effect.Effect<never, { readonly tag: 'offline' }>>(() =>
            Effect.andThen(
                Effect.promise(async () => await gate.promise),
                Effect.fail({ tag: 'offline' as const }),
            ),
        );
        const session = createFormSession({ definition, operation, run });
        const first = session.submit();
        const second = session.submit();
        expect(first).toBe(second);
        gate.resolve(null);
        await expect(first).resolves.toStrictEqual({ status: 'failure', error: { tag: 'offline' } });
        expect(ran).toHaveBeenCalledTimes(1);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(session.getSnapshot().submitCount).toBe(1);
    });

    it.each(['success', 'failure'] as const)(
        'preserves opaque %s payloads for Promise and Effect waiters',
        async (status) => {
            expect.hasAssertions();
            const marker = Symbol('domain marker');
            const payload: { self?: unknown; readonly [marker]: string } = { [marker]: 'preserved' };
            payload.self = payload;
            Object.defineProperty(payload, 'unreadable', {
                enumerable: true,
                get: () => {
                    throw new Error('Domain getters must not be read.');
                },
            });
            const onResult = vi.fn<(result: SubmissionResult<typeof payload, typeof payload>) => void>();
            const session = createFormSession({
                definition,
                // oxlint-disable-next-line vitest/no-conditional-in-test -- Each parameter explicitly selects the success or expected-failure path.
                operation: () => (status === 'success' ? Effect.succeed(payload) : Effect.fail(payload)),
                onResult,
            });
            const native = Effect.runPromise(session.submitEffect());
            const promise = session.submit();
            const [result, nativeResult] = await Promise.all([promise, native]);
            // oxlint-disable-next-line vitest/no-conditional-in-test -- The outcome determines the public payload slot under test.
            const key = status === 'success' ? 'value' : 'error';
            expect(result.status).toBe(status);
            expect(nativeResult).toBe(result);
            expect(Reflect.get(result, key)).toBe(payload);
            expect(Reflect.get(session.getSnapshot().execution, key)).toBe(payload);
            expect(payload[marker]).toBe('preserved');
            expect(Object.isFrozen(payload)).toBe(false);
            expect(Object.isFrozen(session.getSnapshot().execution)).toBe(true);
            expect(onResult).toHaveBeenCalledTimes(1);
            expect(onResult.mock.calls[0]?.[0]).toBe(result);
            await expect(session.submit()).resolves.toHaveProperty('status', status);
        },
    );

    it('preserves opaque defect payloads and settles every waiter', async () => {
        expect.hasAssertions();
        const marker = Symbol('defect marker');
        const payload: { self?: unknown; readonly [marker]: string } = { [marker]: 'preserved' };
        payload.self = payload;
        const session = createFormSession({
            definition,
            driver: { submit: () => Effect.succeed({ status: 'defect', error: payload }) },
        });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        expect(result.status).toBe('defect');
        expect(nativeResult).toBe(result);
        expect(Reflect.get(result, 'error')).toBe(payload);
        expect(Reflect.get(session.getSnapshot().execution, 'error')).toBe(payload);
        expect(payload[marker]).toBe('preserved');
        expect(Object.isFrozen(session.getSnapshot().execution)).toBe(true);
        expect(session.getSnapshot().errors['']).toHaveLength(1);
    });

    it('settles publication defects from unreadable driver validation messages', async () => {
        expect.hasAssertions();
        const failure = new Error('Unreadable validation messages.');
        const session = createFormSession({
            definition,
            driver: {
                submit: () =>
                    Effect.succeed({
                        status: 'invalid',
                        get errors(): Readonly<Record<string, string>> {
                            throw failure;
                        },
                    }),
            },
        });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        expect(result.status).toBe('defect');
        expect(nativeResult).toBe(result);
        expect(Reflect.get(result, 'error')).toBe(failure);
        expect(session.getSnapshot().execution.status).toBe('defect');
        expect(session.getSnapshot().errors['']).toHaveLength(1);
    });

    it('normalizes inherited success discriminants and preserves optional value presence', async () => {
        expect.hasAssertions();
        class EmptySuccess {
            public get status(): 'success' {
                return 'success';
            }
        }
        class ExplicitUndefinedSuccess extends EmptySuccess {
            public get value(): undefined {
                return undefined;
            }
        }
        await Promise.all(
            [new EmptySuccess(), new ExplicitUndefinedSuccess()].map(async (incoming) => {
                const session = createFormSession({ definition, driver: { submit: () => Effect.succeed(incoming) } });
                const native = Effect.runPromise(session.submitEffect());
                const promise = session.submit();
                const [result, nativeResult] = await Promise.all([promise, native]);
                expect(result.status).toBe('success');
                expect(nativeResult).toBe(result);
                expect(Object.hasOwn(result, 'status')).toBe(true);
                expect(Object.hasOwn(result, 'value')).toBe('value' in incoming);
                expect(Object.hasOwn(session.getSnapshot().execution, 'value')).toBe('value' in incoming);
                expect(Object.isFrozen(result)).toBe(true);
                expect(Object.isFrozen(session.getSnapshot().execution)).toBe(true);
                expect(session.getSnapshot().baseline).toBe(session.getSnapshot().values);
            }),
        );
    });

    it('normalizes class-based invalid envelopes and owns their validation messages', async () => {
        expect.hasAssertions();
        const messages = { name: ['Required.'] };
        class Invalid {
            public get status(): 'invalid' {
                return 'invalid';
            }
            public get errors(): Readonly<Record<string, ReadonlyArray<string>>> {
                return messages;
            }
        }
        const session = createFormSession({ definition, driver: { submit: () => Effect.succeed(new Invalid()) } });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        messages.name.push('Later external mutation.');
        expect(result.status).toBe('invalid');
        expect(nativeResult).toBe(result);
        expect(Object.hasOwn(result, 'status')).toBe(true);
        expect(Reflect.get(result, 'errors')).toStrictEqual({ name: ['Required.'] });
        expect(session.getField('name').errors).toStrictEqual(['Required.']);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(Reflect.get(result, 'errors'))).toBe(true);
        expect(Object.isFrozen(session.getField('name').errors)).toBe(true);
    });

    it('owns class-based error dictionaries without freezing the driver objects', async () => {
        expect.hasAssertions();
        class ErrorRecord {
            [key: string]: string | ReadonlyArray<string>;
            public name = ['Required.'];
            public toString = 'Another field error.';
        }
        const messages = new ErrorRecord();
        const session = createFormSession({
            definition,
            driver: { submit: () => Effect.succeed({ status: 'invalid', errors: messages }) },
        });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        const snapshot = session.getSnapshot();
        messages.name.push('External mutation.');
        messages.toString = 'External replacement.';
        expect(result.status).toBe('invalid');
        expect(nativeResult).toBe(result);
        expect(Reflect.get(result, 'errors')).toStrictEqual({ name: ['Required.'], toString: 'Another field error.' });
        expect(Reflect.get(snapshot.execution, 'errors')).toStrictEqual({
            name: ['Required.'],
            toString: 'Another field error.',
        });
        expect(snapshot.errors).toStrictEqual({ name: ['Required.'], toString: ['Another field error.'] });
        expect(Reflect.get(result, 'errors')).not.toBe(messages);
        expect(Object.isFrozen(Reflect.get(result, 'errors'))).toBe(true);
        expect(Object.isFrozen(snapshot.errors['name'])).toBe(true);
        expect(Object.isFrozen(messages)).toBe(false);
        expect(Object.isFrozen(messages.name)).toBe(false);
    });

    it('normalizes class-based failures while preserving opaque error identity', async () => {
        expect.hasAssertions();
        const payload: { self?: unknown } = {};
        payload.self = payload;
        class Failure {
            public get status(): 'failure' {
                return 'failure';
            }
            public get error(): unknown {
                return payload;
            }
        }
        const session = createFormSession({ definition, driver: { submit: () => Effect.succeed(new Failure()) } });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        expect(result.status).toBe('failure');
        expect(nativeResult).toBe(result);
        expect(Reflect.get(result, 'error')).toBe(payload);
        expect(Reflect.get(session.getSnapshot().execution, 'error')).toBe(payload);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(payload)).toBe(false);
    });

    it('normalizes non-enumerable discriminants and settles throwing discriminant getters', async () => {
        expect.hasAssertions();
        const incoming: SubmissionResult = { status: 'success' };
        Object.defineProperty(incoming, 'status', { enumerable: false });
        const session = createFormSession({ definition, driver: { submit: () => Effect.succeed(incoming) } });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'success' });
        const failure = new Error('Unreadable result status.');
        session.updateOptions({
            definition,
            driver: {
                submit: () =>
                    Effect.succeed({
                        get status(): 'success' {
                            throw failure;
                        },
                    }),
            },
        });
        const native = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        const [result, nativeResult] = await Promise.all([promise, native]);
        expect(result.status).toBe('defect');
        expect(nativeResult).toBe(result);
        expect(Reflect.get(result, 'error')).toBe(failure);
        expect(session.getSnapshot().execution.status).toBe('defect');
    });

    it.each(['status', 'value', 'error', 'errors'] as const)(
        'preserves a reset successor started by a result %s getter',
        async (key) => {
            expect.hasAssertions();
            const envelopes: Readonly<Record<typeof key, SubmissionResult>> = {
                status: { status: 'success' },
                value: { status: 'success', value: undefined },
                error: { status: 'failure', error: 'old failure' },
                errors: { status: 'invalid', errors: { name: ['Old error.'] } },
            };
            const incoming = envelopes[key];
            const original: unknown = Reflect.get(incoming, key);
            const replacement: { pending?: Promise<SubmissionResult> } = {};
            const session = createFormSession({ definition, driver: { submit: () => Effect.succeed(incoming) } });
            Object.defineProperty(incoming, key, {
                get: () => {
                    session.reset({ ...definition.defaultValues, name: 'replacement' });
                    session.updateOptions({ definition, operation: () => Effect.never });
                    replacement.pending = session.submit();
                    return original;
                },
            });
            const native = Effect.runPromise(session.submitEffect());
            const promise = session.submit();
            const [result, nativeResult] = await Promise.all([promise, native]);
            expect(result.status).toBe('cancelled');
            expect(nativeResult).toBe(result);
            expect(session.getSnapshot().execution.status).toBe('submitting');
            expect(session.getSnapshot().baseline.name).toBe('replacement');
            expect(session.getSnapshot().values.name).toBe('replacement');
            expect(session.getSnapshot().isDirty).toBe(false);
            expect(session.getSnapshot().errors).toStrictEqual({});
            session.cancel();
            await expect(replacement.pending).resolves.toStrictEqual({ status: 'cancelled' });
        },
    );

    it('interrupts an actual native async decoder and runs its finalizer', async () => {
        expect.hasAssertions();
        const captured: { resume: ((effect: Effect.Effect<null>) => void) | undefined } = { resume: undefined };
        const finalizer = vi.fn<() => void>();
        const pendingCheck = Effect.callback<null>((resume) => {
            captured.resume = resume;
            return Effect.sync(finalizer);
        });
        const schema = definitionSchema(definition).pipe(
            EffectSchema.middlewareDecoding((decode) => Effect.andThen(pendingCheck, decode)),
        );
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition, schema, operation });
        const pending = session.submit();
        await tick();
        expect(session.getSnapshot().execution.status).toBe('validating');
        session.cancel();
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        await tick();
        expect(finalizer).toHaveBeenCalledTimes(1);
        const cancelled = session.getSnapshot();
        captured.resume?.(Effect.succeed(null));
        await tick();
        expect(session.getSnapshot()).toBe(cancelled);
        expect(operation).not.toHaveBeenCalled();
    });

    it('interrupts transport resources and suppresses late progress after reset', async () => {
        expect.hasAssertions();
        const finalizer = vi.fn<() => void>();
        const captured: { context: OperationContext | undefined } = { context: undefined };
        const session = createFormSession({
            definition,
            operation: (_, current) => {
                captured.context = current;
                return Effect.callback<undefined>(() => Effect.sync(finalizer));
            },
        });
        const pending = session.submit();
        await tick();
        captured.context?.onProgress({ loaded: 1, total: 2 });
        expect(session.getSnapshot().progress?.loaded).toBe(1);
        session.reset();
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        await tick();
        expect(captured.context?.signal.aborted).toBe(true);
        expect(finalizer).toHaveBeenCalledTimes(1);
        captured.context?.onProgress({ loaded: 2, total: 2 });
        expect(session.getSnapshot().progress).toBeUndefined();
        expect(session.getSnapshot().execution.status).toBe('idle');
    });

    it('saves the captured draft baseline while preserving newer edits and resets to that baseline', async () => {
        expect.hasAssertions();
        const gate = deferred<null>();
        const session = createFormSession({
            definition,
            operation: () => Effect.promise(async () => await gate.promise),
        });
        session.setValue('name', 'saved');
        const pending = session.submit();
        session.setValue('name', 'newer');
        gate.resolve(null);
        await pending;
        expect(session.getSnapshot().values.name).toBe('newer');
        expect(session.getSnapshot().baseline.name).toBe('saved');
        expect(session.getSnapshot().isDirty).toBe(true);
        session.reset();
        expect(session.getSnapshot().values.name).toBe('saved');
        expect(session.getSnapshot().isDirty).toBe(false);
    });

    it('attaches server errors only to unedited fields and unchanged array structure', async () => {
        expect.hasAssertions();
        const gate = deferred<SubmissionResult>();
        const session = createFormSession({
            definition,
            driver: { submit: () => Effect.promise(async () => await gate.promise) },
        });
        const pending = session.submit();
        session.setValue('name', 'changed');
        session.move('contacts', 0, 1);
        gate.resolve({
            status: 'invalid',
            errors: { name: 'stale', 'contacts.0.email': 'wrong row', file: 'upload rejected' },
        });
        await pending;
        expect(session.getSnapshot().errors).toStrictEqual({ file: ['upload rejected'] });
        session.setValue('file', new File(['fixed'], 'fixed.txt'));
        expect(session.getSnapshot().errors).toStrictEqual({});
    });

    it('keeps touched metadata with rows on move/removal and isolates subscriptions', () => {
        expect.hasAssertions();
        const session = createFormSession({ definition, operation: () => Effect.void });
        const listener = vi.fn<() => void>();
        const unsubscribe = session.subscribe(listener);
        const snapshot = session.getSnapshot();
        expect(session.getSnapshot()).toBe(snapshot);
        session.touch('contacts[0].email');
        session.move('contacts', 0, 1);
        expect(session.getField('contacts.1.email').touched).toBe(true);
        expect(session.getField('contacts.0.email').touched).toBe(false);
        session.remove('contacts', 0);
        expect(session.getField('contacts.0.email').touched).toBe(true);
        unsubscribe();
        const count = listener.mock.calls.length;
        session.setValue('name', 'after unsubscribe');
        expect(listener).toHaveBeenCalledTimes(count);
    });

    it('runs operations with application services provided by a typed runner', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Context.Service creates a service key without new.
        const Save = Context.Service<{ prefix: string }>('session/Save');
        const session = createFormSession({
            definition,
            operation: (data) => Save.pipe(Effect.map((service) => `${service.prefix}${data.name}`)),
            run: Effect.runPromiseWith(Context.make(Save, { prefix: 'saved:' })),
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'success', value: 'saved:original' });
    });

    it('disposes without publishing and ignores completions of runners that do not observe cancellation', async () => {
        expect.hasAssertions();
        const result = deferred<SubmissionResult>();
        const session = createFormSession({
            definition,
            operation: () => Effect.void,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This deliberate bad runner simulates ignoring the supplied Effect and AbortSignal.
            run: async () => (await result.promise) as never,
        });
        const listener = vi.fn<() => void>();
        session.subscribe(listener);
        const pending = session.submit();
        const state: FormState<typeof definition.defaultValues> = session.getSnapshot();
        const calls = listener.mock.calls.length;
        session.dispose();
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        result.resolve({ status: 'success' });
        await tick();
        expect(session.getSnapshot()).toBe(state);
        expect(listener).toHaveBeenCalledTimes(calls);
        expect(() => session.setValue('name', 'disposed')).toThrow('disposed');
    });

    it('fills optional and nullable nested paths and edits nested arrays', () => {
        expect.hasAssertions();
        const optional = defineForm<{
            nickname?: string;
            billing: { city: string } | null;
            rows: Array<{ children: Array<{ name: string }> }>;
            matrix: Array<Array<number>>;
        }>()({
            id: 'optional',
            defaultValues: { billing: null, rows: [{ children: [{ name: 'old' }] }], matrix: [[1]] },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: optional, operation: () => Effect.void });
        session.setValue('nickname', 'Nick');
        session.setValue('billing.city', 'Boston');
        session.setValue('rows.0.children[0].name', 'new');
        session.setValue('matrix[0][0]', 2);
        expect(session.getSnapshot().values.nickname).toBe('Nick');
        expect(session.getSnapshot().values.billing).toStrictEqual({ city: 'Boston' });
        expect(session.getSnapshot().values.rows[0]?.children[0]?.name).toBe('new');
        expect(session.getField('matrix.0.0').value).toBe(2);
    });

    it('preserves numeric record keys and shares padded array aliases across reads and edits', () => {
        expect.hasAssertions();
        const numeric = defineForm<{ codes: { '01': string }; rows: Array<{ items: Array<string> }> }>()({
            id: 'numeric-paths',
            defaultValues: { codes: { '01': 'original' }, rows: [{ items: ['original'] }] },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: numeric, operation: () => Effect.void });
        expect(session.getField('codes.01').value).toBe('original');
        session.setValue('codes.01', 'edited');
        session.touch('codes.01');
        expect(session.getSnapshot().values.codes).toStrictEqual({ '01': 'edited' });
        expect(session.getSnapshot().fields['codes.01']?.touched).toBe(true);
        expect(session.getField('rows[00].items').value).toStrictEqual(['original']);
        session.append('rows[00].items', 'added');
        session.touch('rows[00].items[01]');
        expect(session.getSnapshot().values.rows).toStrictEqual([{ items: ['original', 'added'] }]);
        expect(session.getField('rows.0.items.1').touched).toBe(true);
        session.move('rows[00].items', 1, 0);
        expect(session.getField('rows.0.items.0').touched).toBe(true);
        session.remove('rows[00].items', 1);
        expect(session.getField('rows.0.items').value).toStrictEqual(['added']);
    });

    it('uses encoded native container shapes when optional records and arrays are absent', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const item = EffectSchema.Struct({ name: EffectSchema.String });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const entry = EffectSchema.Struct({ rows: EffectSchema.optionalKey(EffectSchema.Array(item)) });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const schema = EffectSchema.Struct({
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            metadata: EffectSchema.optionalKey(EffectSchema.Record(EffectSchema.String, EffectSchema.String)),
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            nested: EffectSchema.optionalKey(EffectSchema.Record(EffectSchema.String, entry)),
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            rows: EffectSchema.NullOr(EffectSchema.Array(item)),
        });
        const optional = defineForm<{
            metadata?: Record<string, string>;
            nested?: Record<string, { rows?: ReadonlyArray<{ name: string }> }>;
            rows: ReadonlyArray<{ name: string }> | null;
        }>()({ id: 'native-absent-containers', defaultValues: { rows: null }, fields: {}, groups: {}, schema });
        const session = createFormSession({ definition: optional, operation: () => Effect.void });
        session.setValue('metadata.0', 'value');
        session.setValue('metadata.01', 'literal');
        session.setValue('nested.01.rows[00].name', 'nested');
        session.setValue('rows[00].name', 'row');
        expect(session.getSnapshot().values).toStrictEqual({
            metadata: { '0': 'value', '01': 'literal' },
            nested: { '01': { rows: [{ name: 'nested' }] } },
            rows: [{ name: 'row' }],
        });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('keeps distinct long numeric record keys while rejecting imprecise array indexes', () => {
        expect.hasAssertions();
        const numeric = defineForm<{ codes: Record<string, string>; rows: Array<string> }>()({
            id: 'long-numeric-keys',
            defaultValues: { codes: { '9007199254740992': 'first', '9007199254740993': 'second' }, rows: ['row'] },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: numeric, operation: () => Effect.void });
        session.setValue('codes.9007199254740992', 'edited first');
        session.setValue('codes.9007199254740993', 'edited second');
        expect(session.getField('codes.9007199254740992').value).toBe('edited first');
        expect(session.getField('codes.9007199254740993').value).toBe('edited second');
        expect(session.getSnapshot().values.codes).toStrictEqual({
            '9007199254740992': 'edited first',
            '9007199254740993': 'edited second',
        });
        expect(() => session.setValue('rows[9007199254740993]', 'bad')).toThrow('Invalid array index');
        expect(() => session.getField('rows[9007199254740993]')).toThrow('Invalid array index');
    });

    it('infers absent array containers from field metadata without compiling validation', () => {
        expect.hasAssertions();
        const factory = vi.spyOn(validation, 'definitionSchema');
        const nullable = defineForm<{ rows: Array<{ name: string }> | null }>()({
            id: 'metadata-absent-array',
            defaultValues: { rows: null },
            fields: {
                rows: {
                    name: 'rows',
                    type: 'array',
                    component: 'Rows',
                    label: 'Rows',
                    props: {},
                    nullable: true,
                    constraints: {},
                    serverRules: [],
                },
            },
            groups: {},
        });
        const session = createFormSession({ definition: nullable, operation: () => Effect.void });
        session.touch('rows[00].name');
        session.setValue('rows[00].name', 'row');
        expect(session.getField('rows.0.name').value).toBe('row');
        expect(session.getField('rows.0.name').touched).toBe(true);
        expect(factory).not.toHaveBeenCalled();
    });

    it('matches nested metadata array aliases without rewriting numeric object keys', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this metadata-only fixture beside its alias regression.
        const field = (name: string, type: FieldDefinition['type']): FieldDefinition => ({
            name,
            type,
            component: 'Input',
            label: name,
            props: {},
            nullable: true,
            constraints: {},
            serverRules: [],
        });
        const nested = defineForm<{
            rows: Array<{ items: Array<{ name: string }> | null }> | null;
            codes?: Record<string, { items?: Array<{ name: string }> }>;
        }>()({
            id: 'metadata-padded-arrays',
            defaultValues: { rows: null },
            fields: {
                rows: field('rows', 'array'),
                'rows[00].items': field('rows[00].items', 'array'),
                'rows[00].items.*.name': field('rows[00].items.*.name', 'string'),
                codes: field('codes', 'object'),
                'codes.01.items': field('codes.01.items', 'array'),
                'codes.01.items.*.name': field('codes.01.items.*.name', 'string'),
            },
            groups: {},
        });
        const session = createFormSession({ definition: nested, operation: () => Effect.void });
        session.touch('rows[00].items[00].name');
        session.setValue('rows[00].items[0].name', 'row');
        session.setValue('codes.01.items[00].name', 'literal');
        expect(session.getSnapshot().values).toStrictEqual({
            rows: [{ items: [{ name: 'row' }] }],
            codes: { '01': { items: [{ name: 'literal' }] } },
        });
        expect(session.getField('rows.0.items.0.name').touched).toBe(true);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('resolves raw leaf paths independently in draft and baseline union containers', () => {
        expect.hasAssertions();
        const union = defineForm<{ value: Record<string, { name: string }> | Array<{ name: string }> }>()({
            id: 'union-container-dirty',
            defaultValues: { value: { '00': { name: 'original' } } },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: union, operation: () => Effect.void });
        session.setValue('value', [{ name: 'original' }]);
        expect(session.getField('value[00].name').value).toBe('original');
        expect(session.getField('value[00].name').dirty).toBe(false);
        expect(session.getSnapshot().isDirty).toBe(true);
        session.reset({ value: [{ name: 'original' }] });
        session.setValue('value', { '00': { name: 'original' } });
        expect(session.getField('value[00].name').value).toBe('original');
        expect(session.getField('value[00].name').dirty).toBe(false);
        expect(session.getSnapshot().isDirty).toBe(true);
        session.setValue('value[00].name', 'edited');
        expect(session.getField('value[00].name').dirty).toBe(true);
    });

    it('supports root bracket paths through native Array and Tuple sessions', async () => {
        expect.hasAssertions();
        const rootArray = defineForm<ReadonlyArray<{ name: string }>>()({
            id: 'root-array',
            defaultValues: [{ name: 'original' }],
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Array(EffectSchema.Struct({ name: EffectSchema.String })),
        });
        const arraySession = createFormSession({ definition: rootArray, operation: () => Effect.void });
        arraySession.setValue('[00].name', 'edited');
        arraySession.touch('[00].name');
        expect(arraySession.getField('0.name')).toMatchObject({ value: 'edited', touched: true });
        expect(arraySession.resolvePath('[00].name')).toBe('0.name');
        await expect(arraySession.submit()).resolves.toHaveProperty('status', 'success');
        const rootTuple = defineForm<readonly [string, number]>()({
            id: 'root-tuple',
            defaultValues: ['original', 0],
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Tuple([EffectSchema.String, EffectSchema.Number]),
        });
        const tupleSession = createFormSession({ definition: rootTuple, operation: () => Effect.void });
        tupleSession.setValue('[00]', 'edited');
        tupleSession.setValue('[01]', 42);
        expect(tupleSession.getSnapshot().values).toStrictEqual(['edited', 42]);
        await expect(tupleSession.submit()).resolves.toHaveProperty('status', 'success');
        expect(() => tupleSession.resolvePath('[0]trailing')).toThrow('Invalid field path');
        expect(() => tupleSession.resolvePath('[0].constructor')).toThrow('Invalid field path');
    });

    it('preserves replacement state when setter and reset inputs reenter the session', () => {
        expect.hasAssertions();
        const ownDraft = defineForm<{ name: string; address: { city: string } }>()({
            id: 'getter-draft',
            defaultValues: { name: 'original', address: { city: 'original' } },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: ownDraft, operation: () => Effect.void });
        session.setValue('address', {
            get city() {
                session.reset({ name: 'replacement', address: { city: 'replacement' } });
                return 'stale';
            },
        });
        expect(session.getSnapshot().values).toStrictEqual({ name: 'replacement', address: { city: 'replacement' } });
        expect(session.getSnapshot().values).toBe(session.getSnapshot().baseline);
        session.setValue('address', {
            get city() {
                session.setValue('name', 'newer edit');
                return 'stale';
            },
        });
        expect(session.getSnapshot().values).toStrictEqual({ name: 'newer edit', address: { city: 'replacement' } });
        session.reset({
            get name() {
                session.reset({ name: 'inner reset', address: { city: 'inner reset' } });
                return 'outer reset';
            },
            address: { city: 'outer reset' },
        });
        expect(session.getSnapshot().values).toStrictEqual({ name: 'inner reset', address: { city: 'inner reset' } });
        const before = session.getSnapshot();
        const listener = vi.fn<() => void>();
        session.subscribe(listener);
        session.setValue('address', {
            get city() {
                session.dispose();
                return 'disposed edit';
            },
        });
        expect(session.getSnapshot()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it('settles runner property defects for shared Promise and Effect waiters', async () => {
        expect.hasAssertions();
        const failure = new Error('Runner unavailable.');
        const onResult = vi.fn<(result: SubmissionResult<void, never>) => void>();
        const session = createFormSession({
            definition,
            operation: () => Effect.void,
            onResult,
            get run(): EffectRunner {
                throw failure;
            },
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'defect', error: failure });
        await expect(Effect.runPromise(session.submitEffect())).resolves.toStrictEqual({
            status: 'defect',
            error: failure,
        });
        expect(session.getSnapshot().execution.status).toBe('defect');
        expect(session.getSnapshot().errors['']).toHaveLength(1);
        expect(onResult).toHaveBeenCalledTimes(2);
        session.updateOptions({ definition, operation: () => Effect.void });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it.each(['promise', 'effect'] as const)('settles %s callers disposed during observer acquisition', async (mode) => {
        expect.hasAssertions();
        const observer = vi.fn<(result: SubmissionResult<void, never>) => void>();
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({
            definition,
            operation,
            get onResult() {
                session.dispose();
                return observer;
            },
        });
        const listener = vi.fn<() => void>();
        session.subscribe(listener);
        // oxlint-disable-next-line vitest/no-conditional-in-test -- Each parameter independently exercises its public waiter entry point.
        const pending = mode === 'promise' ? session.submit() : Effect.runPromise(session.submitEffect());
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        expect(session.getSnapshot().execution.status).toBe('idle');
        expect(listener).not.toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
    });

    it('preserves a cancellation successor started during observer acquisition', async () => {
        expect.hasAssertions();
        const observer = vi.fn<(result: SubmissionResult<void, never>) => void>();
        const pending: { replacement?: Promise<SubmissionResult<void, never>> } = {};
        const session = createFormSession({
            definition,
            operation: () => Effect.void,
            get onResult() {
                session.cancel();
                session.updateOptions({ definition, operation: () => Effect.never });
                pending.replacement = session.submit();
                return observer;
            },
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'cancelled' });
        expect(session.getSnapshot().execution.status).toBe('submitting');
        expect(observer).not.toHaveBeenCalled();
        session.cancel();
        await expect(pending.replacement).resolves.toStrictEqual({ status: 'cancelled' });
    });

    it.each(['promise', 'effect'] as const)('settles observer acquisition defects for %s callers', async (mode) => {
        expect.hasAssertions();
        const failure = new Error('Observer unavailable.');
        const session = createFormSession({
            definition,
            operation: () => Effect.void,
            get onResult(): (result: SubmissionResult<void, never>) => void {
                throw failure;
            },
        });
        // oxlint-disable-next-line vitest/no-conditional-in-test -- Each parameter independently exercises its public waiter entry point.
        const pending = mode === 'promise' ? session.submit() : Effect.runPromise(session.submitEffect());
        await expect(pending).resolves.toStrictEqual({ status: 'defect', error: failure });
        expect(session.getSnapshot().execution.status).toBe('defect');
        session.updateOptions({ definition, operation: () => Effect.void });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('coalesces observer reentrancy and reads the callback only once per submission', async () => {
        expect.hasAssertions();
        const gate = deferred<null>();
        const observer = vi.fn<(result: SubmissionResult<void, never>) => void>();
        const captured: { reads: number; shared?: Promise<SubmissionResult<void, never>> } = { reads: 0 };
        const session = createFormSession({
            definition,
            operation: () => Effect.asVoid(Effect.promise(async () => await gate.promise)),
            get onResult() {
                captured.reads += 1;
                captured.shared = session.submit();
                return observer;
            },
        });
        const promise = session.submit();
        const native = Effect.runPromise(session.submitEffect());
        expect(captured.shared).toBe(promise);
        gate.resolve(null);
        const [result, nativeResult] = await Promise.all([promise, native]);
        expect(result.status).toBe('success');
        expect(nativeResult).toBe(result);
        expect(captured.reads).toBe(1);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer.mock.calls[0]?.[0]).toBe(result);
    });

    it('does not start a runner after its property getter resets and replaces the submission', async () => {
        expect.hasAssertions();
        const ran = vi.fn<() => void>();
        const run: EffectRunner = async (effect, options) => {
            ran();
            return await Effect.runPromise(effect, options);
        };
        const pending: { replacement?: Promise<SubmissionResult<void, never>> } = {};
        const session = createFormSession({
            definition,
            operation: () => Effect.void,
            get run(): EffectRunner {
                session.reset();
                session.updateOptions({ definition, operation: () => Effect.never });
                pending.replacement = session.submit();
                return run;
            },
        });
        await expect(session.submit()).resolves.toHaveProperty('status', 'cancelled');
        expect(ran).not.toHaveBeenCalled();
        expect(session.getSnapshot().execution.status).toBe('submitting');
        session.cancel();
        await expect(pending.replacement).resolves.toHaveProperty('status', 'cancelled');
    });

    it('appends to active array branches of union containers', () => {
        expect.hasAssertions();
        const union = defineForm<{ value: Array<{ name: string }> | Record<string, { name: string }> }>()({
            id: 'union-append',
            defaultValues: { value: [{ name: 'original' }] },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: union, operation: () => Effect.void });
        session.append('value', { name: 'added' });
        expect(session.getSnapshot().values.value).toStrictEqual([{ name: 'original' }, { name: 'added' }]);
        session.setValue('value', { literal: { name: 'record' } });
        expect(() => session.append('value', { name: 'array item' })).toThrow('Field is not an array');
    });

    it('routes unaddressable native issue keys to root and preserves all messages', async () => {
        expect.hasAssertions();
        const keys = ['a.b', 'bad[0]', '', 'constructor', '__proto__', 'prototype', 'safe'];
        const fields = Object.fromEntries(
            keys.map((key) => [
                key,
                // oxlint-disable-next-line vitest/no-conditional-in-test -- Label the empty-key fixture without changing the tested validation behavior.
                EffectSchema.String.check(EffectSchema.isMinLength(1, { message: `${key || 'empty'} is required.` })),
            ]),
        );
        const native = defineForm<Record<string, string>>()({
            id: 'native-unaddressable',
            defaultValues: Object.fromEntries(keys.map((key) => [key, ''])),
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Struct(fields),
        });
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition: native, operation });
        await expect(session.submit()).resolves.toHaveProperty('status', 'invalid');
        expect(session.getSnapshot().errors['']).toStrictEqual(
            // oxlint-disable-next-line vitest/no-conditional-in-test -- The expected root list uses the same deterministic empty-key label as the fixture.
            keys.slice(0, -1).map((key) => `${key || 'empty'} is required.`),
        );
        expect(session.getSnapshot().errors['safe']).toStrictEqual(['safe is required.']);
        expect(Object.keys(session.getSnapshot().errors)).toStrictEqual(['', 'safe']);
        expect(operation).not.toHaveBeenCalled();
    });

    it('creates unknown missing numeric-key containers as objects', () => {
        expect.hasAssertions();
        const record = defineForm<{ metadata?: Record<string, string> }>()({
            id: 'missing-record',
            defaultValues: {},
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: record, operation: () => Effect.void });
        session.setValue('metadata.01', 'literal');
        expect(session.getSnapshot().values).toStrictEqual({ metadata: { '01': 'literal' } });
    });

    it('does not skip sparse array edits when comparing values and dirty state', () => {
        expect.hasAssertions();
        const sparse = defineForm<{ rows: ReadonlyArray<string | undefined> }>()({
            id: 'sparse-edit',
            defaultValues: { rows: ['original'] },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: sparse, operation: () => Effect.void });
        const holes: Array<string | undefined> = [];
        holes.length = 1;
        session.setValue('rows', holes);
        expect(session.getSnapshot().values.rows).toHaveLength(1);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 0)).toBe(false);
        expect(session.getField('rows.0').value).toBeUndefined();
        expect(session.getSnapshot().isDirty).toBe(true);
        session.setValue('rows', [undefined]);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 0)).toBe(true);
        session.setValue('rows', ['original']);
        expect(session.getSnapshot().isDirty).toBe(false);
    });

    it('normalizes inherited progress properties into immutable declared fields', async () => {
        expect.hasAssertions();
        class Progress {
            public get loaded() {
                return 2;
            }
            public get total() {
                return 4;
            }
            public get percentage() {
                return 50;
            }
        }
        const session = createFormSession({
            definition,
            operation: (_, context) => {
                context.onProgress(new Progress());
                return Effect.never;
            },
        });
        const pending = session.submit();
        await tick();
        expect(session.getSnapshot().progress).toStrictEqual({ loaded: 2, total: 4, percentage: 50 });
        expect(Object.isFrozen(session.getSnapshot().progress)).toBe(true);
        session.cancel();
        await expect(pending).resolves.toHaveProperty('status', 'cancelled');
    });

    it('preserves untouched and moved holes through array edits and metadata remapping', () => {
        expect.hasAssertions();
        const rows: Array<string | undefined> = [];
        rows.length = 3;
        rows[1] = 'original';
        const sparse = defineForm<{ rows: Array<string | undefined> }>()({
            id: 'sparse-structure',
            defaultValues: { rows },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition: sparse, operation: () => Effect.void });
        session.touch('rows.0');
        session.setValue('rows.1', 'edited');
        expect(Object.hasOwn(session.getSnapshot().values.rows, 0)).toBe(false);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 2)).toBe(false);
        session.append('rows', 'added');
        expect(Object.hasOwn(session.getSnapshot().values.rows, 0)).toBe(false);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 2)).toBe(false);
        session.move('rows', 0, 3);
        expect(session.getField('rows.3').touched).toBe(true);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 3)).toBe(false);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 1)).toBe(false);
        session.remove('rows', 2);
        expect(session.getSnapshot().values.rows).toHaveLength(3);
        expect(session.getField('rows.0').value).toBe('edited');
        expect(session.getField('rows.2').touched).toBe(true);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 1)).toBe(false);
        expect(Object.hasOwn(session.getSnapshot().values.rows, 2)).toBe(false);
    });

    it('discards progress when a property getter resets the active submission', async () => {
        expect.hasAssertions();
        const session = createFormSession({
            definition,
            operation: (_, context) => {
                context.onProgress({
                    get loaded() {
                        session.reset();
                        return 2;
                    },
                    total: 4,
                });
                return Effect.void;
            },
        });
        await expect(session.submit()).resolves.toHaveProperty('status', 'cancelled');
        expect(session.getSnapshot().execution.status).toBe('idle');
        expect(session.getSnapshot().progress).toBeUndefined();
    });

    it('converts hostile server paths to a visible defect without stranding submission', async () => {
        expect.hasAssertions();
        const session = createFormSession({
            definition,
            driver: {
                submit: () => Effect.succeed({ status: 'invalid', errors: { '__proto__.polluted': 'hostile' } }),
            },
        });
        const result = await session.submit();
        expect(result.status).toBe('defect');
        expect(session.getSnapshot().errors['']).toStrictEqual(['Unable to submit the form. Please try again.']);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
        await expect(session.submit()).resolves.toMatchObject({ status: 'defect' });
    });

    it('isolates observer and result callback failures while cancelling once', async () => {
        expect.hasAssertions();
        const reporting = vi.fn<(error: unknown) => void>();
        vi.stubGlobal('reportError', reporting);
        try {
            const onResult = vi.fn<(result: SubmissionResult) => void>(() => {
                throw new Error('callback failed');
            });
            const session = createFormSession({ definition, operation: () => Effect.void, onResult });
            session.subscribe(() => {
                throw new Error('observer failed');
            });
            await expect(session.submit()).resolves.toMatchObject({ status: 'success' });
            expect(onResult).toHaveBeenCalledTimes(1);
            expect(reporting).toHaveBeenCalledWith(new Error('callback failed'));
            const cancelled = createFormSession({ definition, operation: () => Effect.never, onResult });
            const pending = cancelled.submit();
            cancelled.cancel();
            cancelled.cancel();
            await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
            expect(onResult).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('checks the lifetime after synchronous submitting observers cancel', async () => {
        expect.hasAssertions();
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition, operation });
        session.subscribe(() => {
            // oxlint-disable-next-line vitest/no-conditional-in-test -- The observer deliberately reproduces reentrant cancellation at the transport boundary.
            if (session.getSnapshot().execution.status === 'submitting') {
                session.cancel();
            }
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'cancelled' });
        expect(operation).not.toHaveBeenCalled();
    });

    it('keeps valid prototype-named field errors in owned dictionaries', async () => {
        expect.hasAssertions();
        const text = EffectSchema.String.check(EffectSchema.isMinLength(1, { message: 'Required.' }));
        // oxlint-disable-next-line eslint/new-cap -- Effect schema factories are called without new.
        const schema = EffectSchema.Struct({ toString: text });
        const prototypeNamed = defineForm<{ toString: string }>()({
            id: 'prototype-name',
            defaultValues: { toString: '' },
            fields: {},
            groups: {},
            schema,
        });
        const session = createFormSession({ definition: prototypeNamed, operation: () => Effect.void });
        expect(session.getField('toString').errors).toStrictEqual([]);
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getField('toString').errors).toStrictEqual(['Required.']);
    });

    it('publishes reset values before a cancellation callback starts another submission', async () => {
        expect.hasAssertions();
        const restart: {
            pending: Promise<SubmissionResult<string, never>> | undefined;
            submit: (() => Promise<SubmissionResult<string, never>>) | undefined;
        } = { pending: undefined, submit: undefined };
        const session = createFormSession({
            definition,
            // oxlint-disable-next-line vitest/no-conditional-in-test -- The first transport stays pending; the reset transport completes.
            operation: (values) => (values.name === 'draft' ? Effect.never : Effect.succeed(values.name)),
            onResult: (result) => {
                // oxlint-disable-next-line vitest/no-conditional-in-test -- Exercise a reentrant application callback at cancellation.
                if (result.status === 'cancelled') {
                    restart.pending = restart.submit?.();
                }
            },
        });
        restart.submit = session.submit;
        session.setValue('name', 'draft');
        const first = session.submit();
        await tick();
        session.reset({ ...definition.defaultValues, name: 'reset draft' });
        await expect(first).resolves.toStrictEqual({ status: 'cancelled' });
        await expect(restart.pending).resolves.toStrictEqual({ status: 'success', value: 'reset draft' });
        expect(session.getSnapshot().baseline.name).toBe('reset draft');
    });

    it('provides schema and operation services to a single native workflow', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect service keys are factory functions.
        const Validation = Context.Service<{ marker: string }>('session/Validation');
        // oxlint-disable-next-line eslint/new-cap -- Effect service keys are factory functions.
        const Storage = Context.Service<{ prefix: string }>('session/Storage');
        const used: Array<string> = [];
        const schema = definitionSchema(definition).pipe(
            EffectSchema.middlewareDecoding((decode) =>
                Effect.andThen(
                    Validation.pipe(
                        Effect.tap((service) =>
                            Effect.sync(() => {
                                used.push(service.marker);
                            }),
                        ),
                    ),
                    decode,
                ),
            ),
        );
        const servicedDefinition = defineForm<typeof definition.defaultValues>()({ ...definition, schema });
        const services = Context.make(Validation, { marker: 'validated' }).pipe(
            Context.add(Storage, { prefix: 'stored:' }),
        );
        const session = createFormSession({
            definition: servicedDefinition,
            operation: (values) => Storage.pipe(Effect.map((storage) => `${storage.prefix}${values.name}`)),
            run: Effect.runPromiseWith(services),
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'success', value: 'stored:original' });
        expect(used).toStrictEqual(['validated']);
    });

    it('routes native composite root-check issues to nested field and form errors', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schema factories are called without new.
        const shape = EffectSchema.Struct({ name: EffectSchema.String });
        const schema = shape.check(
            EffectSchema.makeFilter(() => [
                { path: ['name'], issue: 'Name has a conflict.' },
                { path: ['contacts', 0, 'email'], issue: 'Contact is unavailable.' },
                'The form has a conflict.',
            ]),
        );
        const simple = defineForm<{ name: string }>()({
            id: 'native-pointers',
            defaultValues: { name: 'Nick' },
            fields: {},
            groups: {},
            schema,
        });
        const session = createFormSession({ definition: simple, operation: () => Effect.void });
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getSnapshot().errors).toStrictEqual({
            name: ['Name has a conflict.'],
            'contacts.0.email': ['Contact is unavailable.'],
            '': ['The form has a conflict.'],
        });
    });

    it('keeps native decoder defects distinct from validation rejection', async () => {
        expect.hasAssertions();
        const schema = definitionSchema(definition).pipe(
            EffectSchema.middlewareDecoding(() => Effect.die('decoder defect')),
        );
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition, schema, operation });
        await expect(session.submit()).resolves.toMatchObject({ status: 'defect' });
        expect(operation).not.toHaveBeenCalled();
        expect(session.getSnapshot().errors['']).toStrictEqual(['Unable to submit the form. Please try again.']);
    });

    it('preserves generated validation messages at concrete wildcard field paths', async () => {
        expect.hasAssertions();
        const base: FieldDefinition = {
            name: 'primaryEmail',
            label: 'Primary email',
            type: 'string',
            component: 'TextField',
            nullable: false,
            props: {},
            constraints: {},
            serverRules: [],
        };
        const generated = defineForm<{ primaryEmail: string; contacts: Array<{ email: string }> }>()({
            id: 'generated-issues',
            defaultValues: { primaryEmail: 'ab', contacts: [{ email: 'bad' }, { email: '' }] },
            groups: {},
            fields: {
                primaryEmail: { ...base, constraints: { minLength: 5, format: 'email' } },
                contactEmail: {
                    ...base,
                    name: 'contacts.*.email',
                    label: 'Contact email',
                    constraints: { required: true, format: 'email' },
                },
            },
        });
        const session = createFormSession({ definition: generated, operation: () => Effect.void });
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getSnapshot().errors).toStrictEqual({
            primaryEmail: [
                'Primary email must have at least 5 characters.',
                'Primary email must be a valid email address.',
            ],
            'contacts.0.email': ['Contact email must be a valid email address.'],
            'contacts.1.email': ['Contact email is required.'],
        });
    });

    it('blocks only enabled wildcard rows and submits after their condition changes', async () => {
        expect.hasAssertions();
        const conditional = defineForm<{ contacts: Array<{ enabled: boolean; email: string }> }>()({
            id: 'conditional-rows',
            defaultValues: {
                contacts: [
                    { enabled: true, email: '' },
                    { enabled: false, email: '' },
                ],
            },
            groups: {},
            fields: {
                email: {
                    name: 'contacts.*.email',
                    label: 'Email',
                    type: 'string',
                    component: 'TextField',
                    nullable: false,
                    props: {},
                    constraints: {
                        requiredWhen: [{ field: 'contacts.*.enabled', operator: 'equals', values: ['true'] }],
                    },
                    serverRules: [],
                },
            },
        });
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition: conditional, operation });
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getSnapshot().errors).toStrictEqual({ 'contacts.0.email': ['Email is required.'] });
        expect(operation).not.toHaveBeenCalled();
        session.setValue('contacts.0.enabled', false);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        expect(operation).toHaveBeenCalledTimes(1);
        expect(session.getSnapshot().errors).toStrictEqual({});
    });

    it('retains nested native Struct and Array parser field pointers', async () => {
        expect.hasAssertions();
        const email = EffectSchema.String.check(
            EffectSchema.isMinLength(5, { message: 'Email must have five characters.' }),
        );
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const contact = EffectSchema.Struct({ email });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const billing = EffectSchema.Struct({ contacts: EffectSchema.Array(contact) });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const schema = EffectSchema.Struct({ billing });
        const nested = defineForm<{ billing: { contacts: ReadonlyArray<{ email: string }> } }>()({
            id: 'native-nested-parser',
            defaultValues: { billing: { contacts: [{ email: 'bad' }] } },
            fields: {},
            groups: {},
            schema,
        });
        const session = createFormSession({ definition: nested, operation: () => Effect.void });
        await expect(session.submit()).resolves.toMatchObject({ status: 'invalid' });
        expect(session.getSnapshot().errors).toStrictEqual({
            'billing.contacts.0.email': ['Email must have five characters.'],
        });
    });

    it('keeps an abort-handler replacement submission active after cancel', async () => {
        expect.hasAssertions();
        const replacement = deferred<null>();
        const captured: {
            restart: (() => Promise<SubmissionResult<string, never>>) | undefined;
            pending: Promise<SubmissionResult<string, never>> | undefined;
        } = { restart: undefined, pending: undefined };
        const session = createFormSession({
            definition,
            operation: (values, context) => {
                // oxlint-disable-next-line vitest/no-conditional-in-test -- The first transport registers the deliberately reentrant abort callback.
                if (values.name === 'original') {
                    context.signal.addEventListener(
                        'abort',
                        () => {
                            captured.pending = captured.restart?.();
                        },
                        { once: true },
                    );
                    return Effect.never;
                }
                return Effect.as(
                    Effect.promise(async () => await replacement.promise),
                    values.name,
                );
            },
        });
        captured.restart = session.submit;
        const first = session.submit();
        await tick();
        session.setValue('name', 'replacement');
        session.cancel();
        await expect(first).resolves.toStrictEqual({ status: 'cancelled' });
        await tick();
        expect(session.getSnapshot().execution.status).toBe('submitting');
        replacement.resolve(null);
        await expect(captured.pending).resolves.toStrictEqual({ status: 'success', value: 'replacement' });
    });

    it('lets a reset abort handler submit only the replacement draft and baseline', async () => {
        expect.hasAssertions();
        const captured: {
            restart: (() => Promise<SubmissionResult<string, never>>) | undefined;
            pending: Promise<SubmissionResult<string, never>> | undefined;
        } = { restart: undefined, pending: undefined };
        const session = createFormSession({
            definition,
            operation: (values, context) => {
                // oxlint-disable-next-line vitest/no-conditional-in-test -- Reproduce a transport abort callback restarting the session.
                if (values.name === 'original') {
                    context.signal.addEventListener(
                        'abort',
                        () => {
                            captured.pending = captured.restart?.();
                        },
                        { once: true },
                    );
                    return Effect.never;
                }
                return Effect.succeed(values.name);
            },
        });
        captured.restart = session.submit;
        const first = session.submit();
        await tick();
        session.reset({ ...definition.defaultValues, name: 'reset replacement' });
        await expect(first).resolves.toStrictEqual({ status: 'cancelled' });
        await expect(captured.pending).resolves.toStrictEqual({ status: 'success', value: 'reset replacement' });
        expect(session.getSnapshot().baseline.name).toBe('reset replacement');
        expect(session.getSnapshot().isDirty).toBe(false);
    });

    it('caches generated codecs by definition identity and respects option changes and overrides', async () => {
        expect.hasAssertions();
        const factory = vi.spyOn(validation, 'definitionSchema');
        const first = defineForm<{ name: string }>()({
            id: 'cache-first',
            defaultValues: { name: 'first' },
            fields: {},
            groups: {},
        });
        const second = defineForm<{ name: string }>()({
            id: 'cache-second',
            defaultValues: { name: 'second' },
            fields: {},
            groups: {},
        });
        const operation = vi.fn<() => Effect.Effect<void>>(() => Effect.void);
        const session = createFormSession({ definition: first, operation });
        await session.submit();
        await session.submit();
        expect(factory).toHaveBeenCalledTimes(1);
        // oxlint-disable-next-line eslint/new-cap -- Native Effect schema factories are called without new.
        const override = EffectSchema.Struct({ name: EffectSchema.String });
        session.updateOptions({ definition: second, schema: override, operation });
        await session.submit();
        expect(factory).toHaveBeenCalledTimes(1);
        session.updateOptions({ definition: second, operation });
        await session.submit();
        session.updateOptions({ definition: first, operation });
        await session.submit();
        expect(factory).toHaveBeenCalledTimes(2);
        expect(factory).toHaveBeenLastCalledWith(second);
    });

    it('settles schema-construction defects and permits a later corrected submission', async () => {
        expect.hasAssertions();
        const broken = {
            ...definition,
            get fields(): typeof definition.fields {
                throw new Error('metadata unavailable');
            },
        };
        const session = createFormSession({ definition: broken, operation: () => Effect.void });
        await expect(session.submit()).resolves.toMatchObject({ status: 'defect' });
        expect(session.getSnapshot().execution.status).toBe('defect');
        session.updateOptions({ definition, operation: () => Effect.void });
        await expect(session.submit()).resolves.toMatchObject({ status: 'success' });
    });

    it('exposes a lazy composable Effect waiter and coalesces mixed callers', async () => {
        expect.hasAssertions();
        const gate = deferred<string>();
        const operation = vi.fn<() => Effect.Effect<string>>(() => Effect.promise(async () => await gate.promise));
        const session = createFormSession({ definition, operation });
        const effect = session.submitEffect().pipe(
            Effect.map((result) => ({
                result,
                execution: session.getSnapshot().execution.status,
                baseline: session.getSnapshot().baseline.name,
            })),
        );
        expect(session.getSnapshot().execution.status).toBe('idle');
        expect(operation).not.toHaveBeenCalled();
        session.setValue('name', 'saved draft');
        const pendingEffect = Effect.runPromise(effect);
        const pendingPromise = session.submit();
        gate.resolve('saved');
        await expect(pendingPromise).resolves.toStrictEqual({ status: 'success', value: 'saved' });
        await expect(pendingEffect).resolves.toStrictEqual({
            result: { status: 'success', value: 'saved' },
            execution: 'success',
            baseline: 'saved draft',
        });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('detaches interrupted Effect waiters without cancelling shared execution', async () => {
        expect.hasAssertions();
        const gate = deferred<string>();
        const captured: { signal: AbortSignal | undefined } = { signal: undefined };
        const session = createFormSession({
            definition,
            operation: (_, context) => {
                captured.signal = context.signal;
                return Effect.promise(async () => await gate.promise);
            },
        });
        const interrupted = Effect.runFork(session.submitEffect());
        const pending = session.submit();
        await tick();
        await Effect.runPromise(Fiber.interrupt(interrupted));
        expect(captured.signal?.aborted).toBe(false);
        expect(session.getSnapshot().execution.status).toBe('submitting');
        gate.resolve('still running');
        await expect(pending).resolves.toStrictEqual({ status: 'success', value: 'still running' });
    });

    it('cancels every Promise and native Effect waiter through the session owner', async () => {
        expect.hasAssertions();
        const session = createFormSession({ definition, operation: () => Effect.never });
        const first = Effect.runPromise(session.submitEffect());
        const second = Effect.runPromise(session.submitEffect());
        const promise = session.submit();
        session.cancel();
        await expect(first).resolves.toStrictEqual({ status: 'cancelled' });
        await expect(second).resolves.toStrictEqual({ status: 'cancelled' });
        await expect(promise).resolves.toStrictEqual({ status: 'cancelled' });
        expect(session.getSnapshot().execution.status).toBe('cancelled');
    });

    it('reuses unchanged field metadata and shares reset baseline values', () => {
        expect.hasAssertions();
        const session = createFormSession({ definition, operation: () => Effect.void });
        session.touch('name');
        const { fields } = session.getSnapshot();
        session.setValue('contacts.0.email', 'changed');
        expect(session.getSnapshot().fields).toBe(fields);
        expect(fields['name']?.touched).toBe(true);
        session.reset();
        expect(session.getSnapshot().values).toBe(session.getSnapshot().baseline);
        expect(session.getSnapshot().fields).toStrictEqual({});
    });

    it.each([{ middle: [] }, { middle: [1, 2] }])(
        'infers missing array containers in a fixed tuple tail after rest values $middle',
        async ({ middle }) => {
            expect.hasAssertions();
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            const row = EffectSchema.Struct({ name: EffectSchema.String });
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            const rows = EffectSchema.Array(row);
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            const tail = EffectSchema.Struct({ rows: EffectSchema.optionalKey(rows) });
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            const headSchema = EffectSchema.Tuple([EffectSchema.String]);
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            const tupleSchema = EffectSchema.TupleWithRest(headSchema, [EffectSchema.Number, tail]);
            const tuple: readonly [string, ...Array<number>, { rows?: ReadonlyArray<{ name: string }> }] = [
                'head',
                ...middle,
                {},
            ];
            const native = defineForm<{ tuple: typeof tuple }>()({
                id: 'native-post-rest-array',
                defaultValues: { tuple },
                fields: {},
                groups: {},
                // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
                schema: EffectSchema.Struct({
                    tuple: tupleSchema,
                }),
            });
            const session = createFormSession({ definition: native, operation: () => Effect.void });
            await expect(session.submit()).resolves.toHaveProperty('status', 'success');
            session.setValue(`tuple[${tuple.length - 1}].rows[00].name`, 'added');
            expect(session.getSnapshot().values.tuple).toStrictEqual([
                'head',
                ...middle,
                { rows: [{ name: 'added' }] },
            ]);
            await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        },
    );

    it('uses the concrete array length to distinguish multiple fixed tuple tails', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const row = EffectSchema.Struct({ name: EffectSchema.String });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const rows = EffectSchema.Array(row);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const records = EffectSchema.Record(EffectSchema.String, row);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const arrayTail = EffectSchema.Struct({ items: EffectSchema.optionalKey(rows) });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const recordTail = EffectSchema.Struct({
            items: EffectSchema.optionalKey(records),
        });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const headSchema = EffectSchema.Tuple([EffectSchema.String]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const tupleSchema = EffectSchema.TupleWithRest(headSchema, [EffectSchema.Number, arrayTail, recordTail]);
        const native = defineForm<{
            tuple: readonly [
                string,
                ...Array<number>,
                { items?: ReadonlyArray<{ name: string }> },
                { items?: Record<string, { name: string }> },
            ];
        }>()({
            id: 'native-multiple-post-rest',
            defaultValues: { tuple: ['head', 2, {}, {}] },
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Struct({
                tuple: tupleSchema,
            }),
        });
        const session = createFormSession({ definition: native, operation: () => Effect.void });
        session.setValue('tuple[2].items[0].name', 'array');
        session.setValue('tuple[3].items.01.name', 'literal');
        expect(session.getSnapshot().values.tuple).toStrictEqual([
            'head',
            2,
            { items: [{ name: 'array' }] },
            { items: { '01': { name: 'literal' } } },
        ]);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('retains possible trailing schemas when a nullable tuple has no concrete length yet', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const row = EffectSchema.Struct({ name: EffectSchema.String });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const rows = EffectSchema.Array(row);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const tail = EffectSchema.Struct({
            rows: EffectSchema.optionalKey(rows),
        });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const headSchema = EffectSchema.Tuple([]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const tupleSchema = EffectSchema.TupleWithRest(headSchema, [EffectSchema.Number, tail]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const nullableTuple = EffectSchema.NullOr(tupleSchema);
        const native = defineForm<{
            tuple: readonly [...Array<number>, { rows?: ReadonlyArray<{ name: string }> }] | null;
        }>()({
            id: 'native-absent-post-rest',
            defaultValues: { tuple: null },
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Struct({
                tuple: nullableTuple,
            }),
        });
        const session = createFormSession({ definition: native, operation: () => Effect.void });
        session.setValue('tuple[0].rows[0].name', 'added');
        expect(session.getSnapshot().values.tuple).toStrictEqual([{ rows: [{ name: 'added' }] }]);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('infers nested missing array containers in existing native array elements', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const child = EffectSchema.Struct({ name: EffectSchema.String });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const children = EffectSchema.Array(child);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const row = EffectSchema.Struct({ children: EffectSchema.optionalKey(children) });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const rows = EffectSchema.Array(row);
        const native = defineForm<{ rows: ReadonlyArray<{ children?: ReadonlyArray<{ name: string }> }> }>()({
            id: 'native-empty-nested-array',
            defaultValues: { rows: [{}] },
            fields: {},
            groups: {},
            // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
            schema: EffectSchema.Struct({ rows }),
        });
        const session = createFormSession({ definition: native, operation: () => Effect.void });
        session.setValue('rows[0].children[0].name', 'added');
        expect(session.getSnapshot().values.rows).toStrictEqual([{ children: [{ name: 'added' }] }]);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        session.reset({ rows: [] });
        expect(() => session.setValue('rows[0].children[0].name', 'outside')).toThrow('Invalid array index: 0');
        expect(session.getSnapshot().values.rows).toStrictEqual([]);
    });

    it('reads and replaces native Map and Set values as atomic fields', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const tagsSchema = EffectSchema.ReadonlySet(EffectSchema.String);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const countsSchema = EffectSchema.ReadonlyMap(EffectSchema.String, EffectSchema.Number);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const schema = EffectSchema.Struct({ tags: tagsSchema, counts: countsSchema });
        const tags = new Set(['one']);
        const counts = new Map([['one', 1]]);
        const native = defineForm<typeof schema.Type>()({
            id: 'native-atomic-collections',
            defaultValues: { tags, counts },
            fields: {},
            groups: {},
            schema,
        });
        const session = createFormSession({ definition: native, operation: () => Effect.void });
        expect(session.getField('tags').value).toBe(tags);
        expect(session.getField('counts').value).toBe(counts);
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        const replacementTags = new Set(['two']);
        const replacementCounts = new Map([['two', 2]]);
        session.setValue('tags', replacementTags);
        session.setValue('counts', replacementCounts);
        expect(session.getField('tags')).toMatchObject({ value: replacementTags, dirty: true });
        expect(session.getField('counts')).toMatchObject({ value: replacementCounts, dirty: true });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        expect(session.getSnapshot().isDirty).toBe(false);
    });

    it('matches native index signature key patterns when inferring missing containers', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const row = EffectSchema.Struct({ name: EffectSchema.String });
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const listKeys = EffectSchema.TemplateLiteral(['list-', EffectSchema.String]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const objectKeys = EffectSchema.TemplateLiteral(['object-', EffectSchema.String]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const rows = EffectSchema.Array(row);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const records = EffectSchema.Record(EffectSchema.String, row);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const lists = EffectSchema.Record(listKeys, rows);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const objects = EffectSchema.Record(objectKeys, records);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const empty = EffectSchema.Struct({});
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const entries = EffectSchema.StructWithRest(empty, [objects, lists]);
        // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
        const schema = EffectSchema.Struct({ entries: EffectSchema.optionalKey(entries) });
        const native = defineForm<typeof schema.Type>()({
            id: 'native-patterned-record-containers',
            defaultValues: {},
            fields: {},
            groups: {},
            schema,
        });
        const session = createFormSession({ definition: native, operation: () => Effect.void });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
        session.setValue('entries.list-one[00].name', 'array');
        session.setValue('entries.object-one.01.name', 'literal');
        expect(session.getSnapshot().values).toStrictEqual({
            entries: {
                'list-one': [{ name: 'array' }],
                'object-one': { '01': { name: 'literal' } },
            },
        });
        await expect(session.submit()).resolves.toHaveProperty('status', 'success');
    });

    it('closes native operation resources before publishing successful completion', async () => {
        expect.hasAssertions();
        const resource = { id: 42 };
        const release = vi.fn<() => void>();
        const completed: Array<number> = [];
        const session = createFormSession({
            definition,
            operation: () => Effect.acquireRelease(Effect.succeed(resource), () => Effect.sync(release)),
            onResult: () => {
                completed.push(release.mock.calls.length);
            },
        });
        const first = session.submit();
        const shared = session.submit();
        const native = Effect.runPromise(session.submitEffect());
        expect(shared).toBe(first);
        const result = await first;
        expect(result).toStrictEqual({ status: 'success', value: resource });
        await expect(native).resolves.toBe(result);
        expect(release).toHaveBeenCalledTimes(1);
        expect(completed).toStrictEqual([1]);
        expect(session.getSnapshot().execution).toStrictEqual(result);
    });

    it.each(['cancel', 'dispose'] as const)(
        'closes scoped resources and child fibers through the session %s boundary',
        async (action) => {
            expect.hasAssertions();
            const release = vi.fn<() => void>();
            const childRelease = vi.fn<() => void>();
            const childStarted = vi.fn<() => void>();
            const session = createFormSession({
                definition,
                operation: () =>
                    Effect.gen(function* operation() {
                        yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release));
                        yield* Effect.forkScoped(
                            Effect.callback<undefined>(() => {
                                childStarted();
                                return Effect.sync(childRelease);
                            }),
                            { startImmediately: true },
                        );
                        return yield* Effect.never;
                    }),
            });
            const pending = session.submit();
            const firstWaiter = Effect.runPromise(session.submitEffect());
            const secondWaiter = Effect.runPromise(session.submitEffect());
            await tick();
            expect(childStarted).toHaveBeenCalledTimes(1);
            session[action]();
            const result = await pending;
            expect(result).toStrictEqual({ status: 'cancelled' });
            await expect(firstWaiter).resolves.toBe(result);
            await expect(secondWaiter).resolves.toBe(result);
            await tick();
            expect(release).toHaveBeenCalledTimes(1);
            expect(childRelease).toHaveBeenCalledTimes(1);
            session.dispose();
            expect(release).toHaveBeenCalledTimes(1);
        },
    );

    it('provides session-owned scopes alongside application operation services', async () => {
        expect.hasAssertions();
        // oxlint-disable-next-line eslint/new-cap -- Effect service keys are factory functions.
        const Resource = Context.Service<{ value: string }>('session/ScopedResource');
        const release = vi.fn<() => void>();
        const session = createFormSession({
            definition,
            operation: () =>
                Effect.gen(function* operation() {
                    const service = yield* Resource;
                    return yield* Effect.acquireRelease(Effect.succeed(service.value), () => Effect.sync(release));
                }),
            run: Effect.runPromiseWith(Context.make(Resource, { value: 'scoped' })),
        });
        await expect(session.submit()).resolves.toStrictEqual({ status: 'success', value: 'scoped' });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('settles synchronous runner failures before reset or another submission can supersede them', async () => {
        expect.hasAssertions();
        const errors: Array<Error> = [];
        const signals: Array<AbortSignal> = [];
        const session = createFormSession({
            definition,
            run: (_, options) => {
                signals.push(options.signal);
                const error = new Error(String(errors.length));
                errors.push(error);
                throw error;
            },
        });
        const first = session.submit();
        expect(session.getSnapshot().execution.status).toBe('defect');
        session.reset();
        const second = session.submit();
        const third = session.submit();
        expect(third).not.toBe(second);
        await expect(Promise.all([first, second, third])).resolves.toStrictEqual(
            errors.map((error) => ({ status: 'defect', error })),
        );
        expect(errors).toHaveLength(3);
        expect(signals.map((signal) => signal.aborted)).toStrictEqual([true, true, true]);
    });
});
