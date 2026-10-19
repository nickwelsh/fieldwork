import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
    FormDefinition,
    FormDescriptor,
    SubmissionCallback,
    SubmissionDriver,
    SubmissionResult,
    UploadProgress,
} from '@formbraid/core';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import { createFormbraid } from './create-formbraid.js';
import { useFieldContext } from './hooks.js';
import type { FieldProps } from './types.js';

vi.setConfig({ testTimeout: 10_000 });

interface Values {
    readonly title: string;
}
const defaults: Values = { title: '' };
// A producer needs only public types and plain data, with no generator or defineForm call.
const definition = {
    id: 'Todo.update',
    defaultValues: defaults,
    fields: {
        title: {
            name: 'title',
            type: 'string',
            component: 'TextField',
            label: 'Title',
            props: {},
            constraints: { required: true },
            nullable: false,
            serverRules: [],
        },
    },
    groups: {},
} as const satisfies FormDefinition<Values>;
type Descriptor = FormDescriptor<Values, typeof definition.fields, typeof definition.groups>;

function TextField({ label }: FieldProps<string>) {
    const field = useFieldContext<string>();
    return (
        <label>
            {label}
            <input value={field.value} onChange={(event) => field.setValue(event.target.value)} />
            {field.errors.map((error) => (
                <span role="alert" key={error}>
                    {error}
                </span>
            ))}
        </label>
    );
}
function SubmitButton() {
    return <button type="submit">Save</button>;
}
const formbraid = createFormbraid({
    fieldComponents: { TextField },
    formComponents: { SubmitButton },
});
function submitForm() {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema constructors. */
describe('producer form descriptors', () => {
    afterEach(cleanup);

    it('renders plain third-party metadata, uses descriptor defaults, validates, and maps callback errors', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionCallback<Values>>(() => ({
            status: 'invalid',
            errors: { title: ['Already taken.'] },
        }));
        const descriptor: Descriptor = { version: 1, definition, submission: { submit } };
        render(<formbraid.Form form={descriptor} />);
        submitForm();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('required'));
        expect(submit).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New title' } });
        submitForm();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Already taken.'));
        expect(submit.mock.calls[0]?.[0]).toStrictEqual({ title: 'New title' });
    });

    it('initializes defaults once, preserves field identity and edits, and installs the latest callback', async () => {
        expect.hasAssertions();
        const first = vi.fn<SubmissionCallback<Values>>(() => ({ status: 'success' }));
        const latest = vi.fn<SubmissionCallback<Values>>(async () => await Promise.resolve({ status: 'success' }));
        const descriptor: Descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Original' },
            submission: { submit: first },
        };
        const view = render(<formbraid.Form form={descriptor} />);
        const input = screen.getByRole('textbox');
        expect(input.getAttribute('value')).toBe('Original');
        fireEvent.change(input, { target: { value: 'Edited' } });
        view.rerender(
            <formbraid.Form
                form={{ ...descriptor, defaultValues: { title: 'Replacement' }, submission: { submit: latest } }}
            />,
        );
        expect(screen.getByRole('textbox')).toBe(input);
        expect(input.getAttribute('value')).toBe('Edited');
        submitForm();
        await waitFor(() => expect(latest).toHaveBeenCalledTimes(1));
        expect(first).not.toHaveBeenCalled();
        expect(latest.mock.calls[0]?.[0]).toStrictEqual({ title: 'Edited' });
    });

    it('shares duplicate submits, preserves typed outcomes, and commits only the submitted baseline', async () => {
        expect.hasAssertions();
        const gate: { complete?: (result: SubmissionResult<number, 'offline'>) => void } = {};
        const submit = vi.fn<SubmissionCallback<Values, number, 'offline'>>(
            async () =>
                await new Promise((resolve) => {
                    gate.complete = resolve;
                }),
        );
        const descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Original' },
            submission: { submit },
        } as const;
        const { result } = renderHook(() => formbraid.useForm(descriptor));
        const { current } = result;
        render(<formbraid.Form form={current} />);
        const execution: { pending?: Promise<SubmissionResult<number, 'offline'>> } = {};
        act(() => {
            execution.pending = current.form.handleSubmit();
            expect(current.form.handleSubmit()).toBe(execution.pending);
        });
        await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
        act(() => current.form.setFieldValue('title', 'During submission'));
        await act(async () => {
            gate.complete?.({ status: 'success', value: 42 });
            await execution.pending;
        });
        await expect(execution.pending).resolves.toStrictEqual({ status: 'success', value: 42 });
        expect(current.form.getState().isDirty).toBe(true);
        expect(current.form.getState().baseline).toStrictEqual({ title: 'Original' });
    });

    it('cancels observation and aborts the callback signal without accepting late results', async () => {
        expect.hasAssertions();
        const gate: { finish?: (result: SubmissionResult) => void; signal?: AbortSignal } = {};
        const onResult = vi.fn<(result: SubmissionResult) => void>();
        const descriptor: Descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Original' },
            submission: {
                submit: async (_values, { signal }) => {
                    gate.signal = signal;
                    return await new Promise((resolve) => {
                        gate.finish = resolve;
                    });
                },
            },
        };
        const { result } = renderHook(() => formbraid.useForm(descriptor, { onResult }));
        render(<formbraid.Form form={result.current} />);
        submitForm();
        await waitFor(() => expect(gate.signal).toBeDefined());
        act(() => result.current.cancel());
        expect(gate.signal?.aborted).toBe(true);
        expect(onResult).toHaveBeenCalledWith({ status: 'cancelled' });
        await act(async () => {
            gate.finish?.({ status: 'invalid', errors: { title: 'Late error' } });
            await Promise.resolve();
        });
        expect(onResult).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('routes driver descriptors through the registry and lets explicit defaults override descriptor defaults', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionDriver['submit']>(() => Effect.succeed({ status: 'success' as const }));
        const configured = createFormbraid({
            fieldComponents: { TextField },
            formComponents: { SubmitButton },
            submissions: { http: { submit } },
        });
        const descriptor: Descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Descriptor' },
            submission: { driver: 'http', binding: { url: '/todos/42', method: 'patch' } },
        };
        render(<configured.Form form={descriptor} defaultValues={{ title: 'Explicit' }} />);
        expect(screen.getByRole('textbox').getAttribute('value')).toBe('Explicit');
        submitForm();
        await waitFor(() =>
            expect(submit).toHaveBeenCalledWith(
                expect.objectContaining({ data: { title: 'Explicit' }, binding: descriptor.submission.binding }),
            ),
        );
    });

    it('passes decoded values to callbacks and publishes their explicit failure and progress', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionCallback<{ title: number }, number, 'offline'>>((_values, context) => {
            context.onProgress({ loaded: 1, total: 2, percentage: 50 });
            return { status: 'failure', error: 'offline' };
        });
        const onResult = vi.fn<(result: SubmissionResult<number, 'offline'>) => void>();
        const onProgress = vi.fn<(progress: UploadProgress) => void>();
        const descriptor = {
            version: 1 as const,
            definition: { ...definition, schema: Schema.Struct({ title: Schema.NumberFromString }) },
            defaultValues: { title: '42' },
            submission: { submit },
        };
        render(<formbraid.Form form={descriptor} onResult={onResult} onProgress={onProgress} />);
        submitForm();
        await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'failure', error: 'offline' }));
        expect(submit.mock.calls[0]?.[0]).toStrictEqual({ title: 42 });
        expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 2, percentage: 50 });
    });

    it('lets an explicit executor replace the descriptor callback', async () => {
        expect.hasAssertions();
        const callback = vi.fn<SubmissionCallback<Values>>(() => ({ status: 'success' }));
        const submit = vi.fn<SubmissionDriver['submit']>(() => Effect.succeed({ status: 'success' as const }));
        const descriptor: Descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Valid' },
            submission: { submit: callback },
        };
        render(<formbraid.Form form={descriptor} submission={{ submit }} />);
        submitForm();
        await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
        expect(callback).not.toHaveBeenCalled();
    });

    it('settles rejected callbacks as defects instead of leaving submissions pending', async () => {
        expect.hasAssertions();
        const error = new Error('Unexpected callback rejection');
        const onResult = vi.fn<(result: SubmissionResult) => void>();
        const descriptor: Descriptor = {
            version: 1,
            definition,
            defaultValues: { title: 'Valid' },
            submission: {
                submit: async () => {
                    await Promise.resolve();
                    throw error;
                },
            },
        };
        render(<formbraid.Form form={descriptor} onResult={onResult} />);
        submitForm();
        await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'defect', error }));
    });
});
