/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema and Context constructors. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { bindForm, defineForm } from '@formbraid/core';
import type {
    FieldDefinition,
    OperationContext,
    SubmissionContext,
    SubmissionResult,
    UploadProgress,
} from '@formbraid/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Context, Effect, Schema, SchemaGetter } from 'effect';
import { Activity, StrictMode, Suspense, startTransition, useLayoutEffect, useRef, useState } from 'react';
import { createFormbraid } from './create-formbraid.js';
import { useFieldContext, useFormContext } from './hooks.js';
import { withFieldGroup } from './group.js';
import type { FieldProps } from './types.js';

vi.setConfig({ testTimeout: 10_000 });

const field = (name: string) =>
    ({
        name,
        type: 'string' as const,
        component: 'Input' as const,
        label: name,
        props: {},
        constraints: {},
        nullable: false,
        serverRules: [],
    }) satisfies FieldDefinition;
const definition = defineForm<{ first: string; second: string }>()({
    id: 'lifecycle',
    defaultValues: { first: '', second: '' },
    fields: { first: field('first'), second: field('second') },
    groups: {},
});

function SimpleInput({ label, constraints }: FieldProps<string>) {
    const current = useFieldContext<string>();
    return (
        <label>
            {label}
            <input
                value={current.value}
                maxLength={constraints.maxLength}
                onChange={(event) => {
                    current.setValue(event.target.value);
                }}
            />
        </label>
    );
}
function Submit() {
    return <button type="submit">Save</button>;
}

function progressOperation(_data: typeof definition.defaultValues, context: OperationContext): Effect.Effect<string> {
    context.onProgress({ loaded: 1, total: 1 });
    return Effect.succeed('saved');
}

function SuspendableChild({ blocker }: { readonly blocker: Promise<void> | null }) {
    if (blocker !== null) {
        // oxlint-disable-next-line typescript/only-throw-error -- React Suspense requires throwing the pending promise.
        throw blocker;
    }
    return <span>Ready</span>;
}

describe('owned React session lifecycle', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('subscribes fields and form selectors only to their selected values', async () => {
        expect.hasAssertions();
        const renders = vi.fn<(name: string) => void>();
        const status = vi.fn<(busy: boolean) => void>();
        const combined = vi.fn<(state: { busy: boolean }) => void>();
        function Input({ label }: FieldProps<string>) {
            const current = useFieldContext<string>();
            renders(current.name);
            return (
                <label>
                    {label}
                    <input
                        value={current.value}
                        onChange={(event) => {
                            current.setValue(event.target.value);
                        }}
                        onBlur={() => {
                            current.touch();
                        }}
                    />
                </label>
            );
        }
        function Status() {
            const form = useFormContext();
            return (
                <>
                    <form.Subscribe selector={(state) => state.isSubmitting}>
                        {(busy) => {
                            status(busy);
                            return null;
                        }}
                    </form.Subscribe>
                    <form.Subscribe selector={(state) => ({ busy: state.isSubmitting })}>
                        {(state) => {
                            combined(state);
                            return null;
                        }}
                    </form.Subscribe>
                </>
            );
        }
        const local = createFormbraid({ fieldComponents: { Input }, formComponents: { Status } });
        render(
            <local.Form form={definition}>
                {({ fields, components }) => (
                    <>
                        <fields.first />
                        <fields.second />
                        <components.Status />
                    </>
                )}
            </local.Form>,
        );
        const second = renders.mock.calls.filter(([name]) => name === 'second').length;
        const statusBefore = status.mock.calls.length;
        await userEvent.setup().type(screen.getByLabelText('first'), 'Changed');
        expect(renders.mock.calls.filter(([name]) => name === 'first').length).toBeGreaterThan(second);
        expect(renders.mock.calls.filter(([name]) => name === 'second')).toHaveLength(second);
        expect(status).toHaveBeenCalledTimes(statusBefore);
        expect(combined).not.toHaveBeenCalledTimes(0);
    });

    it('keeps a usable session through StrictMode cleanup and submits with the latest operation', async () => {
        expect.hasAssertions();
        const firstOperation = vi.fn<() => Effect.Effect<string>>(() => Effect.succeed('old'));
        const latestOperation = vi.fn<() => Effect.Effect<string>>(() => Effect.succeed('new'));
        const result = vi.fn<(value: SubmissionResult<string>) => void>();
        const local = createFormbraid({
            fieldComponents: { Input: SimpleInput },
            formComponents: { Submit },
            submitComponent: 'Submit',
        });
        const view = render(
            <StrictMode>
                <local.Form form={definition} operation={firstOperation} onResult={result} />
            </StrictMode>,
        );
        const input = screen.getByLabelText('first');
        await userEvent.setup().type(input, 'Edited');
        view.rerender(
            <StrictMode>
                <local.Form
                    form={definition}
                    operation={latestOperation}
                    onResult={result}
                    defaultValues={{ first: 'Replacement', second: '' }}
                />
            </StrictMode>,
        );
        expect(screen.getByLabelText('first')).toBe(input);
        expect(input.getAttribute('value')).toBe('Edited');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(latestOperation).toHaveBeenCalledTimes(1);
        });
        expect(firstOperation).not.toHaveBeenCalled();
        expect(result).toHaveBeenCalledWith({ status: 'success', value: 'new' });
    });

    it('installs committed options before child layout submissions and StrictMode replay', async () => {
        expect.hasAssertions();
        const operations = vi.fn<(revision: number) => void>();
        const results = vi.fn<(revision: number, result: SubmissionResult<number>) => void>();
        const progress = vi.fn<(revision: number) => void>();
        const pending: Array<Promise<SubmissionResult<number>>> = [];
        function AutoSubmit({ revision }: { readonly revision: number }) {
            const form = useFormContext<object, object, number>();
            useLayoutEffect(() => {
                pending[revision - 1] = form.handleSubmit();
            }, [form, revision]);
            return null;
        }
        const local = createFormbraid({ fieldComponents: {}, formComponents: { AutoSubmit } });
        function Harness({ revision }: { readonly revision: number }) {
            const instance = local.useForm(definition, {
                operation: (_data, context) => {
                    operations(revision);
                    context.onProgress({ loaded: revision, total: 2 });
                    return Effect.succeed(revision);
                },
                onResult: (result) => {
                    results(revision, result);
                },
                onProgress: () => {
                    progress(revision);
                },
            });
            return (
                <local.Form form={instance}>
                    {({ components }) => <components.AutoSubmit revision={revision} />}
                </local.Form>
            );
        }
        const view = render(
            <StrictMode>
                <Harness revision={1} />
            </StrictMode>,
        );
        await act(async () => {
            await pending.at(-1);
        });
        expect(results).toHaveBeenLastCalledWith(1, { status: 'success', value: 1 });
        expect(progress).toHaveBeenLastCalledWith(1);
        view.rerender(
            <StrictMode>
                <Harness revision={2} />
            </StrictMode>,
        );
        await act(async () => {
            await pending.at(-1);
        });
        expect(operations.mock.calls).toStrictEqual([[1], [1], [2]]);
        expect(results.mock.calls).toStrictEqual([
            [1, { status: 'success', value: 1 }],
            [2, { status: 'success', value: 2 }],
        ]);
        expect(progress).toHaveBeenLastCalledWith(2);
    });

    it('delivers progress once when its callback synchronously changes a field', async () => {
        expect.hasAssertions();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        function Harness() {
            const instance = local.useForm(definition, {
                operation: progressOperation,
                onProgress: (value) => {
                    progress(value);
                    instance.form.setFieldValue('first', String(value.loaded));
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return null;
        }
        render(<Harness />);
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'success', value: 'saved' });
        });
        expect(progress.mock.calls).toStrictEqual([[{ loaded: 1, total: 1 }]]);
    });

    it('retains progress changes published during a progress callback', async () => {
        expect.hasAssertions();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        function Harness() {
            const activeContext = useRef<OperationContext | null>(null);
            const instance = local.useForm(definition, {
                operation: (_data, context) => {
                    activeContext.current = context;
                    context.onProgress({ loaded: 1, total: 2 });
                    instance.form.setFieldValue('first', 'Changed after nested progress');
                    return Effect.succeed('saved');
                },
                onProgress: (value) => {
                    progress(value);
                    // oxlint-disable-next-line vitest/no-conditional-in-test -- Only the initial progress triggers a nested publication.
                    if (value.loaded === 1) {
                        activeContext.current?.onProgress({ loaded: 2, total: 2 });
                    }
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return null;
        }
        render(<Harness />);
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'success', value: 'saved' });
        });
        expect(progress.mock.calls).toStrictEqual([[{ loaded: 1, total: 2 }], [{ loaded: 2, total: 2 }]]);
    });

    it('clears progress during a reset from its callback without replaying it', async () => {
        expect.hasAssertions();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        function Harness() {
            const instance = local.useForm(definition, {
                operation: progressOperation,
                onProgress: (value) => {
                    progress(value);
                    instance.form.reset();
                    instance.form.setFieldValue('first', 'Changed after reset');
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return null;
        }
        render(<Harness />);
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'cancelled' });
        });
        expect(progress.mock.calls).toStrictEqual([[{ loaded: 1, total: 1 }]]);
    });

    it('uses the committed schema, runner and transport binding in child layout submissions', async () => {
        expect.hasAssertions();
        const Decode = Context.Service<{ prefix: string }>('react/CommittedDecode');
        const submitted = vi.fn<(context: SubmissionContext) => void>();
        const pending: Array<Promise<SubmissionResult>> = [];
        function AutoSubmit({ revision }: { readonly revision: number }) {
            const form = useFormContext();
            useLayoutEffect(() => {
                pending[revision - 1] = form.handleSubmit();
            }, [form, revision]);
            return null;
        }
        const local = createFormbraid({ fieldComponents: {}, formComponents: { AutoSubmit } });
        const nativeDefinitionFor = (revision: number) => {
            const decode = SchemaGetter.transformEffect((value: string) =>
                Effect.gen(function* decodeValue() {
                    const service = yield* Decode;
                    return `${service.prefix}-${revision}-${value}`;
                }),
            );
            const encode = SchemaGetter.passthrough<string>();
            const first = Schema.String.pipe(Schema.decode({ decode, encode }));
            const schema = Schema.Struct({ first, second: Schema.String });
            return defineForm<{ first: string; second: string }>()({ ...definition, schema });
        };
        function Harness({ revision }: { readonly revision: number }) {
            const nativeDefinition = nativeDefinitionFor(revision);
            const instance = local.useForm(bindForm(nativeDefinition, { driver: 'test', binding: revision }), {
                run: Effect.runPromiseWith(Context.make(Decode, { prefix: `runner${revision}` })),
                submission: {
                    submit: (context) => {
                        submitted(context);
                        return Effect.succeed({ status: 'success' });
                    },
                },
            });
            return (
                <local.Form form={instance}>
                    {({ components }) => <components.AutoSubmit revision={revision} />}
                </local.Form>
            );
        }
        const view = render(<Harness revision={1} />);
        await act(async () => {
            await pending.at(-1);
        });
        expect(submitted).toHaveBeenLastCalledWith(
            expect.objectContaining({ binding: 1, data: { first: 'runner1-1-', second: '' } }),
        );
        view.rerender(<Harness revision={2} />);
        await act(async () => {
            await pending.at(-1);
        });
        expect(submitted).toHaveBeenCalledTimes(2);
        expect(submitted).toHaveBeenLastCalledWith(
            expect.objectContaining({ binding: 2, data: { first: 'runner2-2-', second: '' } }),
        );
    });

    it('keeps suspended render options out of the committed session', async () => {
        expect.hasAssertions();
        const attempted = vi.fn<(revision: number) => void>();
        const operations = vi.fn<(revision: number) => void>();
        const results = vi.fn<(revision: number) => void>();
        const blocker = new Promise<void>(() => {
            // Remain suspended so this render cannot commit its candidate options.
        });
        const holder: { update?: () => void; submit?: () => Promise<SubmissionResult<number, never>> } = {};
        function Suspend({ revision }: { readonly revision: number }) {
            attempted(revision);
            // oxlint-disable-next-line vitest/no-conditional-in-test -- Simulate a render that Suspense abandons.
            if (revision === 2) {
                // oxlint-disable-next-line typescript/only-throw-error -- React Suspense requires throwing the pending promise.
                throw blocker;
            }
            return null;
        }
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        function Harness() {
            const [revision, setRevision] = useState(1);
            const instance = local.useForm(definition, {
                operation: () => {
                    operations(revision);
                    return Effect.succeed(revision);
                },
                onResult: () => {
                    results(revision);
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
                holder.update = () => {
                    startTransition(() => {
                        setRevision(2);
                    });
                };
            }, [instance.form]);
            return <Suspend revision={revision} />;
        }
        render(
            <Suspense fallback="Loading">
                <Harness />
            </Suspense>,
        );
        act(() => {
            holder.update?.();
        });
        await waitFor(() => {
            expect(attempted).toHaveBeenCalledWith(2);
        });
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'success', value: 1 });
        });
        expect(operations.mock.calls).toStrictEqual([[1]]);
        expect(results.mock.calls).toStrictEqual([[1]]);
    });

    it('suppresses hidden owner callbacks and restores both callbacks on Suspense reveal', async () => {
        expect.hasAssertions();
        const progress = vi.fn<() => void>();
        const result = vi.fn<(value: SubmissionResult<string>) => void>();
        const blocker = new Promise<void>(() => {
            // Reveal is controlled by the next committed props, not by this unresolved render.
        });
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        function Harness({ suspended }: { readonly suspended: boolean }) {
            const instance = local.useForm(definition, {
                operation: progressOperation,
                onProgress: progress,
                onResult: result,
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            // oxlint-disable-next-line vitest/no-conditional-in-test -- Committed props control Suspense hiding and revealing.
            const childBlocker = suspended ? blocker : null;
            return <SuspendableChild blocker={childBlocker} />;
        }
        const view = render(
            <StrictMode>
                <Suspense fallback="Loading">
                    <Harness suspended={false} />
                </Suspense>
            </StrictMode>,
        );
        view.rerender(
            <StrictMode>
                <Suspense fallback="Loading">
                    <Harness suspended />
                </Suspense>
            </StrictMode>,
        );
        expect(screen.getByText('Loading')).toBeDefined();
        await act(async () => {
            await holder.submit?.();
        });
        expect([progress.mock.calls.length, result.mock.calls.length]).toStrictEqual([0, 0]);
        view.rerender(
            <StrictMode>
                <Suspense fallback="Loading">
                    <Harness suspended={false} />
                </Suspense>
            </StrictMode>,
        );
        await screen.findByText('Ready');
        await act(async () => {
            await holder.submit?.();
        });
        expect(result).toHaveBeenLastCalledWith({ status: 'success', value: 'saved' });
        expect(progress).toHaveBeenCalledTimes(1);
        view.unmount();
        await act(async () => {
            await holder.submit?.();
        });
        expect([progress.mock.calls.length, result.mock.calls.length]).toStrictEqual([1, 1]);
    });

    it('does not activate callbacks for an initially hidden Activity owner', async () => {
        expect.hasAssertions();
        const progress = vi.fn<() => void>();
        const result = vi.fn<(value: SubmissionResult<string>) => void>();
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        function Harness() {
            const instance = local.useForm(definition, {
                operation: progressOperation,
                onProgress: progress,
                onResult: result,
            });
            // Capture the returned API during render to exercise a retained external caller before
            // Activity has ever activated this owner's layout effects.
            holder.submit = instance.form.handleSubmit;
            return null;
        }
        const view = render(
            <Activity mode="hidden">
                <Harness />
            </Activity>,
        );
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'success', value: 'saved' });
        });
        expect([progress.mock.calls.length, result.mock.calls.length]).toStrictEqual([0, 0]);
        view.rerender(
            <Activity mode="visible">
                <Harness />
            </Activity>,
        );
        await act(async () => {
            await holder.submit?.();
        });
        expect([progress.mock.calls.length, result.mock.calls.length]).toStrictEqual([1, 1]);
        view.rerender(
            <Activity mode="hidden">
                <Harness />
            </Activity>,
        );
        await act(async () => {
            await holder.submit?.();
        });
        expect([progress.mock.calls.length, result.mock.calls.length]).toStrictEqual([1, 1]);
    });

    it('discards queued child progress after cancellation, reset and replacement before activation', async () => {
        expect.hasAssertions();
        const progress = vi.fn<(value: UploadProgress) => void>();
        const result = vi.fn<(value: SubmissionResult<number, never>) => void>();
        const pending: Array<Promise<SubmissionResult<number, never>>> = [];
        let execution = 0;
        const operation = (
            _data: typeof definition.defaultValues,
            context: OperationContext,
        ): Effect.Effect<number> => {
            execution += 1;
            context.onProgress({ loaded: execution, total: 3 });
            return Effect.succeed(execution);
        };
        function AutoSubmit() {
            const form = useFormContext<object, object, number, never>();
            useLayoutEffect(() => {
                pending.push(form.handleSubmit());
                form.cancel();
                pending.push(form.handleSubmit());
                form.reset();
                pending.push(form.handleSubmit());
            }, [form]);
            return null;
        }
        const local = createFormbraid({ fieldComponents: {}, formComponents: { AutoSubmit } });
        function Harness() {
            const instance = local.useForm(definition, { operation, onProgress: progress, onResult: result });
            return <local.Form form={instance}>{({ components }) => <components.AutoSubmit />}</local.Form>;
        }
        render(<Harness />);
        await act(async () => {
            await expect(Promise.all(pending)).resolves.toStrictEqual([
                { status: 'cancelled' },
                { status: 'cancelled' },
                { status: 'success', value: 3 },
            ]);
        });
        expect(progress.mock.calls).toStrictEqual([[{ loaded: 3, total: 3 }]]);
        expect(result.mock.calls).toStrictEqual([[{ status: 'success', value: 3 }]]);
    });

    it('delivers synchronous runner defects after activation and drops reset or superseded defects', async () => {
        expect.hasAssertions();
        const result = vi.fn<(value: SubmissionResult) => void>();
        const errors = [new Error('0'), new Error('1'), new Error('2')];
        const pending: Array<Promise<SubmissionResult>> = [];
        let execution = 0;
        const run = (): never => {
            const error = new Error(String(execution));
            execution += 1;
            throw error;
        };
        function AutoSubmit() {
            const form = useFormContext();
            useLayoutEffect(() => {
                pending.push(form.handleSubmit());
                form.reset();
                pending.push(form.handleSubmit(), form.handleSubmit());
            }, [form]);
            return null;
        }
        const local = createFormbraid({ fieldComponents: {}, formComponents: { AutoSubmit } });
        function Harness() {
            const instance = local.useForm(definition, { run, onResult: result });
            return <local.Form form={instance}>{({ components }) => <components.AutoSubmit />}</local.Form>;
        }
        render(<Harness />);
        await act(async () => {
            await expect(Promise.all(pending)).resolves.toStrictEqual(
                errors.map((error) => ({ status: 'defect', error })),
            );
        });
        expect(result.mock.calls).toStrictEqual([[{ status: 'defect', error: errors[2] }]]);
    });

    it('preserves field focus and drafts across immutable metadata updates and reordering', async () => {
        expect.hasAssertions();
        const local = createFormbraid({ fieldComponents: { Input: SimpleInput }, formComponents: {} });
        const view = render(<local.Form form={definition} />);
        const input = screen.getByLabelText('first');
        await userEvent.setup().type(input, 'Edited');
        const updated = {
            ...definition,
            fields: {
                first: { ...field('first'), label: 'New label', constraints: { maxLength: 15 } },
                second: field('second'),
            },
            groups: {},
        };
        view.rerender(<local.Form form={updated} />);
        expect({
            sameInput: screen.getByLabelText('New label') === input,
            focused: document.activeElement === input,
            value: input.getAttribute('value'),
            maxLength: input.getAttribute('maxlength'),
        }).toStrictEqual({ sameInput: true, focused: true, value: 'Edited', maxLength: '15' });
        view.rerender(
            <local.Form form={{ ...updated, fields: { second: field('second'), first: updated.fields.first } }} />,
        );
        expect(screen.getByLabelText('New label')).toBe(input);
        expect(document.activeElement).toBe(input);
        expect(screen.getAllByRole('textbox')[0]).toBe(screen.getByLabelText('second'));
    });

    it('retains group bindings while updating metadata and automatic field membership', async () => {
        expect.hasAssertions();
        const Group = withFieldGroup({
            defaultValues: { local: '' },
            props: { label: 'Grouped' },
            render: ({ label, group }) => (
                <group.Field name="local">
                    {(current) => (
                        <label>
                            {label}
                            <input
                                value={current.value}
                                onChange={(event) => {
                                    current.setValue(event.target.value);
                                }}
                            />
                        </label>
                    )}
                </group.Field>
            ),
        });
        const local = createFormbraid({
            fieldComponents: { Input: SimpleInput },
            formComponents: {},
            fieldGroups: { Group },
        });
        const grouped = {
            ...definition,
            groups: { address: { component: 'Group', fields: { local: 'first' }, props: { label: 'Grouped' } } },
        };
        const view = render(<local.Form form={grouped} />);
        const input = screen.getByLabelText('Grouped');
        await userEvent.setup().type(input, 'First edit');
        view.rerender(
            <local.Form
                form={{
                    ...grouped,
                    fields: { ...grouped.fields },
                    groups: { address: { ...grouped.groups.address, props: { label: 'New group label' } } },
                }}
            />,
        );
        expect({
            sameInput: screen.getByLabelText('New group label') === input,
            focused: document.activeElement === input,
            value: input.getAttribute('value'),
        }).toStrictEqual({ sameInput: true, focused: true, value: 'First edit' });
        view.rerender(
            <local.Form
                form={{ ...grouped, groups: { address: { ...grouped.groups.address, fields: { local: 'second' } } } }}
            />,
        );
        expect({
            standaloneSecond: screen.queryByLabelText('second'),
            firstValue: screen.getByLabelText('first').getAttribute('value'),
        }).toStrictEqual({ standaloneSecond: null, firstValue: 'First edit' });
        await userEvent.setup().type(screen.getByLabelText('Grouped'), 'Second edit');
        view.rerender(<local.Form form={{ ...definition, fields: { ...definition.fields }, groups: {} }} />);
        expect(screen.queryByLabelText('Grouped')).toBeNull();
        expect(screen.getByLabelText('first').getAttribute('value')).toBe('First edit');
        expect(screen.getByLabelText('second').getAttribute('value')).toBe('Second edit');
    });

    it('renders automatic fields and groups that share the same name independently', () => {
        expect.hasAssertions();
        const Group = withFieldGroup({
            defaultValues: { local: '' },
            props: {},
            render: ({ group }) => (
                <group.Field name="local">
                    {(current) => (
                        <label>
                            Grouped second
                            <input value={current.value} readOnly />
                        </label>
                    )}
                </group.Field>
            ),
        });
        const local = createFormbraid({
            fieldComponents: { Input: SimpleInput },
            formComponents: {},
            fieldGroups: { Group },
        });
        const grouped = {
            ...definition,
            groups: { first: { component: 'Group', fields: { local: 'second' }, props: {} } },
        };
        const view = render(<local.Form form={grouped} />);
        expect(screen.getAllByRole('textbox')).toHaveLength(2);
        expect({
            standalone: screen.getByLabelText('first').getAttribute('value'),
            internalFormAttribute: view.container.querySelector('form')?.hasAttribute('form'),
        }).toStrictEqual({ standalone: '', internalFormAttribute: false });
        expect(screen.getByLabelText('Grouped second')).toBeDefined();
        view.rerender(<local.Form form={{ ...grouped, fields: { second: field('second'), first: field('first') } }} />);
        expect(screen.getAllByRole('textbox')).toHaveLength(2);
        expect(screen.getAllByRole('textbox')[0]).toBe(screen.getByLabelText('Grouped second'));
    });

    it('coalesces duplicate callers and delivers the result callback once', async () => {
        expect.hasAssertions();
        const pending: { complete?: (value: string) => void } = {};
        const operation = vi.fn<() => Effect.Effect<string>>(() =>
            Effect.promise(
                async () =>
                    await new Promise<string>((resolve) => {
                        pending.complete = resolve;
                    }),
            ),
        );
        const result = vi.fn<(value: SubmissionResult<string>) => void>();
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        function Harness() {
            const instance = local.useForm(definition, { operation, onResult: result });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return <local.Form form={instance}>{() => null}</local.Form>;
        }
        render(<Harness />);
        // oxlint-disable-next-line eslint/init-declarations -- Assigned inside act before the assertion.
        let first: Promise<SubmissionResult<string, never>> | undefined;
        // oxlint-disable-next-line eslint/init-declarations -- Assigned inside act before the assertion.
        let second: Promise<SubmissionResult<string, never>> | undefined;
        act(() => {
            first = holder.submit?.();
            second = holder.submit?.();
        });
        expect(first).toBe(second);
        await waitFor(() => {
            expect(pending.complete).toBeDefined();
        });
        await act(async () => {
            pending.complete?.('saved');
            await first;
        });
        expect(operation).toHaveBeenCalledTimes(1);
        expect(result).toHaveBeenCalledTimes(1);
    });

    it('cancels an unmounted operation and suppresses late results', async () => {
        expect.hasAssertions();
        const active: { context?: SubmissionContext; finish?: (value: SubmissionResult) => void } = {};
        const result = vi.fn<(value: SubmissionResult) => void>();
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { submit?: () => Promise<SubmissionResult> } = {};
        function Harness() {
            const instance = local.useForm(bindForm(definition, { driver: 'test', binding: null }), {
                submission: {
                    submit: (context) =>
                        Effect.promise(async () => {
                            active.context = context;
                            return await new Promise<SubmissionResult>((resolve) => {
                                active.finish = resolve;
                            });
                        }),
                },
                onResult: result,
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return <local.Form form={instance}>{() => null}</local.Form>;
        }
        const view = render(<Harness />);
        act(() => {
            void holder.submit?.();
        });
        await waitFor(() => {
            expect(active.context).toBeDefined();
        });
        view.unmount();
        expect(active.context?.signal.aborted).toBe(true);
        active.finish?.({ status: 'success' });
        await act(async () => {
            await Promise.resolve();
        });
        expect(result).not.toHaveBeenCalled();
    });

    it('projects group values, baseline, metadata and errors without parent contamination', async () => {
        expect.hasAssertions();
        const snapshots: Array<unknown> = [];
        const group = withFieldGroup({
            defaultValues: { local: '' },
            props: {},
            render: ({ group: current }) => (
                <current.Subscribe selector={(state) => state}>
                    {(state) => {
                        snapshots.push(state);
                        return (
                            <current.Field name="local">
                                {(input) => (
                                    <label>
                                        Grouped
                                        <input
                                            value={input.value}
                                            onChange={(event) => {
                                                input.setValue(event.target.value);
                                            }}
                                            onBlur={() => {
                                                input.touch();
                                            }}
                                        />
                                    </label>
                                )}
                            </current.Field>
                        );
                    }}
                </current.Subscribe>
            ),
        });
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { edit?: () => void; submit?: () => Promise<SubmissionResult> } = {};
        // A reusable group is also usable directly with an owned form instance.
        const Group = group;
        function View() {
            const instance = local.useForm(bindForm(definition, { driver: 'test', binding: null }), {
                submission: {
                    submit: () =>
                        Effect.succeed({
                            status: 'invalid',
                            errors: {
                                first: 'Local error',
                                second: 'Outside the group',
                                '': 'Form error',
                            },
                        }),
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
                holder.edit = () => {
                    instance.form.setFieldValue('second', 'Other');
                    instance.form.touchField('second');
                };
            }, [instance.form]);
            return <Group form={instance.form} fields={{ local: 'first' }} />;
        }
        const view = render(<View />);
        act(() => {
            holder.edit?.();
        });
        expect(snapshots.at(-1)).toMatchObject({
            values: { local: '' },
            baseline: { local: '' },
            fields: {},
            errors: {},
            isDirty: false,
        });
        const input = screen.getByLabelText('Grouped');
        await userEvent.setup().type(input, 'Local edit');
        view.rerender(<View />);
        expect(screen.getByLabelText('Grouped')).toBe(input);
        expect(snapshots.at(-1)).toMatchObject({ values: { local: 'Local edit' }, isDirty: true });
        await userEvent.setup().tab();
        await act(async () => {
            await holder.submit?.();
        });
        expect(snapshots.at(-1)).toMatchObject({
            errors: { local: ['Local error'] },
            fields: { local: { touched: true } },
        });
    });

    it('reports callback exceptions while completing the owning session', async () => {
        expect.hasAssertions();
        const reported = vi.fn<(error: unknown) => void>();
        vi.stubGlobal('reportError', reported);
        const callbackError = new Error('Application callback failed');
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        function Harness() {
            const instance = local.useForm(definition, {
                operation: (_data, context) => {
                    context.onProgress({ loaded: 1, total: 1 });
                    return Effect.succeed('saved');
                },
                onProgress: () => {
                    throw callbackError;
                },
                onResult: () => {
                    throw callbackError;
                },
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return <local.Form form={instance}>{() => null}</local.Form>;
        }
        render(<Harness />);
        await act(async () => {
            await expect(holder.submit?.()).resolves.toStrictEqual({ status: 'success', value: 'saved' });
        });
        expect(reported).toHaveBeenCalledTimes(2);
        expect(reported).toHaveBeenCalledWith(callbackError);
    });

    it('provides native decoder services and interrupts pending validation on unmount', async () => {
        expect.hasAssertions();
        const Decode = Context.Service<{ decode: (value: string) => Effect.Effect<string> }>('react/AsyncDecode');
        const started = vi.fn<() => void>();
        const finalized = vi.fn<() => void>();
        const operation = vi.fn<() => Effect.Effect<string>>(() => Effect.succeed('saved'));
        const result = vi.fn<(value: SubmissionResult<string>) => void>();
        const decodeValue = SchemaGetter.transformEffect((value: string) =>
            Effect.gen(function* decode() {
                const service = yield* Decode;
                return yield* service.decode(value);
            }),
        );
        const encodeValue = SchemaGetter.passthrough<string>();
        const schema = Schema.Struct({
            value: Schema.String.pipe(Schema.decode({ decode: decodeValue, encode: encodeValue })),
        });
        const nativeDefinition = defineForm<{ value: string }>()({
            id: 'async-native-decoder',
            defaultValues: { value: 'draft' },
            fields: {},
            groups: {},
            schema,
        });
        const context = Context.make(Decode, {
            decode: () =>
                Effect.callback<string>(() => {
                    started();
                    return Effect.sync(finalized);
                }),
        });
        const local = createFormbraid({ fieldComponents: {}, formComponents: {} });
        const holder: { submit?: () => Promise<SubmissionResult<string, never>> } = {};
        function Harness() {
            const instance = local.useForm(nativeDefinition, {
                operation,
                run: Effect.runPromiseWith(context),
                onResult: result,
            });
            useLayoutEffect(() => {
                holder.submit = instance.form.handleSubmit;
            }, [instance.form]);
            return <local.Form form={instance}>{() => null}</local.Form>;
        }
        const view = render(<Harness />);
        const pending = holder.submit?.();
        await waitFor(() => {
            expect(started).toHaveBeenCalledTimes(1);
        });
        view.unmount();
        await expect(pending).resolves.toStrictEqual({ status: 'cancelled' });
        await waitFor(() => {
            expect(finalized).toHaveBeenCalledTimes(1);
        });
        expect(operation).not.toHaveBeenCalled();
        expect(result).not.toHaveBeenCalled();
    });

    it('renders valid paths that share prototype names and rejects inherited registry entries', () => {
        expect.hasAssertions();
        const nested = defineForm<{ toString: { value: string } }>()({
            id: 'prototype-names',
            defaultValues: { toString: { value: 'draft' } },
            fields: { 'toString.value': field('toString.value') },
            groups: {},
        });
        const local = createFormbraid({ fieldComponents: { Input: SimpleInput }, formComponents: {} });
        render(<local.Form form={nested}>{({ fields }) => <fields.toString.value />}</local.Form>);
        expect(screen.getByLabelText('toString.value').getAttribute('value')).toBe('draft');
        const missing = {
            ...nested,
            fields: { 'toString.value': { ...field('toString.value'), component: 'toString' } },
        };
        expect(() => render(<local.Form form={missing} />)).toThrow('not registered with Formbraid');
    });
});
