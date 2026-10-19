/* oxlint-disable eslint/new-cap -- Effect Schema uses capitalized functional schema constructors. */
import { vi, afterEach, describe, expect, it } from 'vite-plus/test';

import { bindForm, defineSubmissionDriver, definitionSchema, isRecord } from '@formbraid/core';
import type { EffectRunner, SubmissionContext, SubmissionDriver, SubmissionResult } from '@formbraid/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createFormbraid } from './create-formbraid.js';
import { fieldComponents } from '@formbraid/example/field-components.js';
import { Effect, Schema, SchemaGetter } from 'effect';
import { formComponents } from '@formbraid/example/form-components.js';
import { fieldGroups } from '@formbraid/example/address-group.js';
import { Form } from '@formbraid/example/forms.js';
import { update } from '@formbraid/example/generated/actions/profile.js';
import { UpdateProfileRequest } from '@formbraid/example/generated/forms/UpdateProfileRequest.js';
import type { UpdateProfileRequestValues } from '@formbraid/example/generated/forms/UpdateProfileRequest.js';

vi.setConfig({ testTimeout: 10_000 });

const validValues: UpdateProfileRequestValues = {
    name: 'Nick',
    email: 'nick@example.com',
    newsletter: false,
    company: null,
    address_line_1: '123 Main Street',
    address_line_2: null,
    city: 'Boston',
    state: 'MA',
    zip: '02110',
};

interface MutationBinding {
    readonly kind: 'mutation';
    readonly name: string;
}
function isMutation(binding: unknown): binding is MutationBinding {
    return isRecord(binding) && binding['kind'] === 'mutation' && typeof binding['name'] === 'string';
}

describe('bound React forms', () => {
    afterEach(() => {
        cleanup();
    });

    it('renders grouped fields once and updates every mapped address value on selection', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionDriver['submit']>().mockReturnValue(Effect.succeed({ status: 'success' }));
        render(
            <Form
                form={update.form({ user: 42 })}
                submission={{ submit }}
                defaultValues={{ ...validValues, address_line_1: '', city: '', state: '', zip: '' }}
            />,
        );
        expect(screen.queryByLabelText('City')).toBeNull();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText('Find Address'), 'Main');
        await user.click(screen.getByRole('button', { name: '123 Main Street, Boston, MA 02110' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(submit).toHaveBeenCalledTimes(1);
        });
        expect(submit.mock.calls[0]?.[0].data).toStrictEqual(validValues);
        expect(submit.mock.calls[0]?.[0].binding).toStrictEqual({ kind: 'http', url: '/users/42', method: 'patch' });
    });

    it('validates only on submit, including edits after a failed submission', async () => {
        expect.hasAssertions();
        const validate = vi.fn<() => void>();
        const run: EffectRunner = async (effect, options) => {
            validate();
            return await Effect.runPromise(effect, options);
        };
        const definition = { ...UpdateProfileRequest, schema: definitionSchema(UpdateProfileRequest) };
        const submit = vi.fn<SubmissionDriver['submit']>().mockReturnValue(Effect.succeed({ status: 'success' }));
        render(
            <Form
                form={bindForm(definition, update.form({ user: 42 }).submission)}
                submission={{ submit }}
                defaultValues={validValues}
                run={run}
            />,
        );
        const user = userEvent.setup();
        const email = screen.getByLabelText('Email *');
        await user.clear(email);
        await user.type(email, 'invalid');
        await user.tab();

        expect(validate).not.toHaveBeenCalled();
        expect(screen.queryByRole('alert')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(screen.getByRole('alert').textContent).toContain('Email must be a valid email address.');
        });
        const callsAfterSubmit = validate.mock.calls.length;
        await user.type(email, '-still-invalid');
        await user.tab();
        expect(validate).toHaveBeenCalledTimes(callsAfterSubmit);

        await user.clear(email);
        await user.type(email, 'nick@example.com');
        await user.tab();
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(submit).toHaveBeenCalledTimes(1);
        });
    });

    it('reactively changes required metadata and blocks an incomplete conditional field', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionDriver['submit']>().mockReturnValue(Effect.succeed({ status: 'success' }));
        render(<Form form={update.form({ user: 42 })} submission={{ submit }} defaultValues={validValues} />);
        const user = userEvent.setup();
        const company = screen.getByLabelText('Company');
        expect(company.getAttribute('aria-required')).toBe('false');
        await user.click(screen.getByRole('checkbox'));
        expect(company.getAttribute('aria-required')).toBe('true');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(submit).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toContain('Company is required');
    });

    it('preserves edits and focus when definitions and default props are recreated', async () => {
        expect.hasAssertions();
        const view = render(<Form form={update.form({ user: 42 })} defaultValues={validValues} />);
        const user = userEvent.setup();
        const input = screen.getByLabelText('Name *');
        await user.clear(input);
        await user.type(input, 'Edited');
        view.rerender(
            <Form form={update.form({ user: 42 })} defaultValues={{ ...validValues, name: 'Replacement' }} />,
        );
        expect(screen.getByLabelText('Name *')).toBe(input);
        expect(input).toBe(document.activeElement);
        expect(input.getAttribute('value')).toBe('Edited');
    });

    it('custom layouts render only explicitly placed fields and expose registered form components', () => {
        expect.hasAssertions();
        render(
            <Form form={update.form({ user: 42 })}>
                {({ fields, components }) => (
                    <>
                        <fields.email label="Contact Email" />
                        <components.SubmitButton label="Update" />
                    </>
                )}
            </Form>,
        );
        expect(screen.getByLabelText('Contact Email *')).toBeDefined();
        expect(screen.queryByLabelText('Name *')).toBeNull();
        expect(screen.queryByLabelText('Find Address')).toBeNull();
        expect(screen.getByRole('button', { name: 'Update' })).toBeDefined();
    });

    it('keeps separate mounted instances isolated and maps server errors into group fields', async () => {
        expect.hasAssertions();
        const submit = vi
            .fn<SubmissionDriver['submit']>()
            .mockReturnValue(Effect.succeed({ status: 'invalid', errors: { city: 'Choose a supported city.' } }));
        const view = render(
            <>
                <Form
                    aria-label="First"
                    form={update.form({ user: 1 })}
                    submission={{ submit }}
                    defaultValues={validValues}
                />
                <Form
                    aria-label="Second"
                    form={update.form({ user: 2 })}
                    defaultValues={{ ...validValues, name: 'Other' }}
                />
            </>,
        );
        const first = within(view.getByRole('form', { name: 'First' }));
        const second = within(view.getByRole('form', { name: 'Second' }));
        const user = userEvent.setup();
        await user.type(first.getByLabelText('Name *'), ' Edited');
        expect(second.getByLabelText('Name *').getAttribute('value')).toBe('Other');
        await user.click(first.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(first.getByRole('alert').textContent).toBe('Choose a supported city.');
        });
        expect(second.queryByRole('alert')).toBeNull();
    });

    it('submits transformed schema output rather than the draft', async () => {
        expect.hasAssertions();
        const submit = vi.fn<SubmissionDriver['submit']>().mockReturnValue(Effect.succeed({ status: 'success' }));
        const definition = {
            ...UpdateProfileRequest,
            schema: definitionSchema(UpdateProfileRequest).pipe(
                Schema.decodeTo(Schema.Struct({ email: Schema.String }), {
                    decode: SchemaGetter.transform(() => ({ email: 'parsed@example.com' })),
                    encode: SchemaGetter.transform(() => validValues),
                }),
            ),
        };
        render(
            <Form
                form={bindForm(definition, {
                    driver: 'web',
                    binding: { kind: 'http', url: '/users/42', method: 'patch' },
                })}
                defaultValues={validValues}
                submission={{ submit }}
            />,
        );
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(submit).toHaveBeenCalledTimes(1);
        });
        expect(submit.mock.calls[0]?.[0].data).toStrictEqual({ email: 'parsed@example.com' });
    });

    it('selects named executors for the same schema and awaits non-HTTP server acceptance', async () => {
        expect.hasAssertions();
        const pending: { complete?: (result: SubmissionResult) => void } = {};
        const webSubmit = vi.fn<SubmissionDriver['submit']>().mockReturnValue(Effect.succeed({ status: 'success' }));
        const mutationSubmit = vi.fn<
            (
                context: Omit<SubmissionContext, 'binding'> & { binding: MutationBinding },
            ) => Effect.Effect<SubmissionResult>
        >((_context) =>
            Effect.promise(
                async () =>
                    await new Promise<SubmissionResult>((resolve) => {
                        pending.complete = resolve;
                    }),
            ),
        );
        const local = createFormbraid({
            fieldComponents,
            formComponents,
            fieldGroups,
            submissions: {
                web: { submit: webSubmit },
                mutations: defineSubmissionDriver({
                    accepts: isMutation,
                    submit: mutationSubmit,
                }),
            },
        });
        const onResult = vi.fn<(result: SubmissionResult) => void>();
        const bound = bindForm(UpdateProfileRequest, {
            driver: 'mutations',
            binding: { kind: 'mutation', name: 'profile.update' },
        });
        render(<local.Form form={bound} defaultValues={validValues} onResult={onResult} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(mutationSubmit).toHaveBeenCalledTimes(1);
        });
        expect(webSubmit).not.toHaveBeenCalled();
        expect(mutationSubmit.mock.calls[0]?.[0].binding).toStrictEqual({ kind: 'mutation', name: 'profile.update' });
        expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
        expect(onResult).not.toHaveBeenCalled();
        pending.complete?.({ status: 'invalid', errors: { email: 'Rejected by the server.' } });
        await waitFor(() => {
            expect(onResult).toHaveBeenCalledTimes(1);
        });
        expect(screen.getByRole('alert').textContent).toBe('Rejected by the server.');
    });

    it('reports missing named executors and rejects unsupported bindings', async () => {
        expect.hasAssertions();
        const onResult = vi.fn<(result: SubmissionResult) => void>();
        render(
            <Form
                form={bindForm(UpdateProfileRequest, { driver: 'toString', binding: { kind: 'mutation' } })}
                defaultValues={validValues}
                onResult={onResult}
            />,
        );
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(onResult).toHaveBeenCalledTimes(1);
        });
        expect(onResult.mock.calls[0]?.[0]).toMatchObject({ status: 'defect' });
        const submit = vi.fn<SubmissionDriver['submit']>();
        const driver = defineSubmissionDriver({
            accepts: (_binding): _binding is string => typeof _binding === 'string',
            submit,
        });
        const { signal } = new AbortController();
        await expect(Effect.runPromise(driver.submit({ binding: {}, data: {}, signal }))).resolves.toMatchObject({
            status: 'failure',
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it('keeps submission state active and aborts the pending driver when unmounted', async () => {
        expect.hasAssertions();
        const pending: { context?: SubmissionContext; complete?: (result: SubmissionResult) => void } = {};
        const submission: SubmissionDriver = {
            submit: (next) =>
                Effect.promise(async () => {
                    pending.context = next;
                    return await new Promise<SubmissionResult>((resolve) => {
                        pending.complete = resolve;
                    });
                }),
        };
        const view = render(
            <Form form={update.form({ user: 42 })} defaultValues={validValues} submission={submission} />,
        );
        await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
        });
        view.unmount();
        expect(pending.context?.signal.aborted).toBe(true);
        pending.complete?.({ status: 'cancelled' });
    });
});
