/* oxlint-disable vitest/no-conditional-in-test -- Test fixture components deliberately render candidate and committed trees. */
/* oxlint-disable unicorn/no-array-method-this-argument -- The reusable group render property is a React renderer. */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { defineForm, getValue } from '@fieldwork/core';
import type { FieldDefinition } from '@fieldwork/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense, startTransition, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { createFieldwork } from './create-fieldwork.js';
import { useFieldContext } from './hooks.js';
import { withFieldGroup } from './group.js';
import type { BoundFields, FieldProps } from './types.js';

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
function Input({ label, constraints }: FieldProps<string>) {
    const current = useFieldContext<string>();
    const id = useId();
    return (
        <label htmlFor={id}>
            {label}
            <input
                id={id}
                maxLength={constraints.maxLength}
                value={current.value}
                onChange={(event) => {
                    current.setValue(event.target.value);
                }}
            />
        </label>
    );
}
function Parent({ label }: FieldProps<object>) {
    const current = useFieldContext<object>();
    return <output aria-label={label}>{JSON.stringify(current.value)}</output>;
}
const NameGroup = withFieldGroup({
    defaultValues: { current: '' },
    props: {},
    render: ({ group }) => (
        <group.Field name="current">
            {(current) => (
                <label>
                    Grouped name
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
const fields = {
    value: { ...field('value'), type: 'object', component: 'Parent' },
    'value.name': field('value.name'),
    'value.length': field('value.length'),
    'value.displayName': field('value.displayName'),
    'value.type': field('value.type'),
    'value.$$typeof': field('value.$$typeof'),
} as const;
const defaults = { value: { name: 'Boston', length: 'Long', displayName: 'Display', type: 'Type', $$typeof: 'Token' } };
const definition = defineForm<typeof defaults>()({ id: 'nested-parent', defaultValues: defaults, fields, groups: {} });
const runtime = createFieldwork({ fieldComponents: { Input, Parent }, formComponents: {}, fieldGroups: { NameGroup } });
function ordered(reverse: boolean) {
    const reversed = {
        'value.$$typeof': fields['value.$$typeof'],
        'value.type': fields['value.type'],
        'value.displayName': fields['value.displayName'],
        'value.length': fields['value.length'],
        'value.name': fields['value.name'],
        value: fields.value,
    };
    return { ...definition, fields: reverse ? reversed : fields };
}

describe('nested bound field trees', () => {
    afterEach(cleanup);

    it.each([false, true])('renders parent and children automatically in either order (reverse: %s)', (reverse) => {
        expect.hasAssertions();
        render(<runtime.Form form={ordered(reverse)} />);
        expect(screen.getByLabelText('value').textContent).toBe(JSON.stringify(defaults.value));
        for (const name of ['name', 'length', 'displayName', 'type', '$$typeof'] as const) {
            expect(screen.getByLabelText(`value.${name}`).getAttribute('value')).toBe(defaults.value[name]);
        }
    });

    it.each([false, true])(
        'renders callable parents and named child properties in custom layouts (reverse: %s)',
        async (reverse) => {
            expect.hasAssertions();
            render(
                <runtime.Form form={ordered(reverse)}>
                    {({ fields: bound }) => (
                        <>
                            <bound.value />
                            <bound.value.name />
                            <bound.value.length />
                            <bound.value.displayName />
                            <bound.value.type />
                            <bound.value.$$typeof />
                        </>
                    )}
                </runtime.Form>,
            );
            const input = screen.getByLabelText('value.name');
            await userEvent.setup().clear(input);
            await userEvent.setup().type(input, 'Edited');
            expect(screen.getByLabelText('value').textContent).toContain('Edited');
            expect(screen.getByLabelText('value.name')).toBe(input);
        },
    );

    it.each([false, true])('supports grouped child paths while retaining the parent (reverse: %s)', async (reverse) => {
        expect.hasAssertions();
        const grouped = {
            ...ordered(reverse),
            groups: { name: { component: 'NameGroup', fields: { current: 'value.name' }, props: {} } },
        } as const;
        render(<runtime.Form form={grouped} />);
        expect(screen.queryByLabelText('value.name')).toBeNull();
        await userEvent.setup().type(screen.getByLabelText('Grouped name'), ' edited');
        expect(screen.getByLabelText('value').textContent).toContain('Boston edited');
    });

    it.each([false, true])(
        'keeps defaultProps child namespaces from injecting parent props (bound namespace: %s)',
        (boundNamespace) => {
            expect.hasAssertions();
            const nestedDefaults = { value: { defaultProps: { label: 'Child' } } };
            const common = {
                value: fields.value,
                'value.defaultProps.label': field('value.defaultProps.label'),
            } as const;
            const withNamespace = {
                ...common,
                'value.defaultProps': { ...field('value.defaultProps'), type: 'object', component: 'Parent' },
            } as const;
            const nested = defineForm<typeof nestedDefaults>()({
                id: 'default-props',
                defaultValues: nestedDefaults,
                fields: boundNamespace ? withNamespace : common,
                groups: {},
            });
            render(
                <runtime.Form form={nested}>
                    {({ fields: bound }) => (
                        <>
                            <bound.value />
                            <bound.value.defaultProps.label />
                        </>
                    )}
                </runtime.Form>,
            );
            expect(screen.getByLabelText('value').textContent).toBe(JSON.stringify(nestedDefaults.value));
            expect(screen.getByLabelText('value.defaultProps.label').getAttribute('value')).toBe('Child');
        },
    );

    it.each([false, true])(
        'resolves reusable group paths through shape resets (initial array: %s)',
        async (initialArray) => {
            expect.hasAssertions();
            const CodeGroup = withFieldGroup<{ local: Record<string, string> | Array<string> }, object>({
                defaultValues: { local: [] },
                props: {},
                render: ({ group }) => (
                    <>
                        <group.Field name="local[01]">
                            {(current) => (
                                <label>
                                    Code
                                    <input
                                        value={current.value ?? ''}
                                        onChange={(event) => {
                                            current.setValue(event.target.value);
                                        }}
                                    />
                                </label>
                            )}
                        </group.Field>
                        <button
                            type="button"
                            onClick={() => {
                                group.touchField('local[01]');
                            }}
                        >
                            Touch
                        </button>
                        <group.Subscribe
                            selector={(state) => ({
                                value: getValue(state.values.local, '01'),
                                touched: Object.values(state.fields).some((current) => current.touched),
                                errors: Object.values(state.errors).flat(),
                            })}
                        >
                            {(state) => <output aria-label="Group state">{JSON.stringify(state)}</output>}
                        </group.Subscribe>
                    </>
                ),
            });
            const codes = defineForm<{ codes: Record<string, string> | Array<string> }>()({
                id: 'codes',
                defaultValues: { codes: initialArray ? ['Array zero', ''] : { '01': '', '1': 'Record one' } },
                fields: { 'codes.01': { ...field('codes.01'), constraints: { required: true } } },
                groups: {},
            });
            function Owner() {
                const instance = runtime.useForm(codes);
                return (
                    <runtime.Form form={instance}>
                        {() => (
                            <>
                                <CodeGroup form={instance.form} fields={{ local: 'codes' }} />
                                <button type="submit">Save</button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        instance.form.reset({ codes: ['Array zero', 'Array one'] });
                                    }}
                                >
                                    Reset array
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        instance.form.reset({ codes: { '01': 'Record padded', '1': 'Record one' } });
                                    }}
                                >
                                    Reset record
                                </button>
                            </>
                        )}
                    </runtime.Form>
                );
            }
            render(<Owner />);
            await userEvent.setup().click(screen.getByRole('button', { name: 'Touch' }));
            await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
            await waitFor(() => {
                expect(screen.getByLabelText('Group state').textContent).toMatch(
                    /^\{"value":"","touched":true,"errors":\["[^"]+/u,
                );
            });
            await userEvent.setup().click(screen.getByRole('button', { name: 'Reset array' }));
            await userEvent.setup().click(screen.getByRole('button', { name: 'Touch' }));
            await userEvent.setup().type(screen.getByLabelText('Code'), ' edited');
            expect(screen.getByLabelText('Group state').textContent).toBe(
                JSON.stringify({ value: 'Array one edited', touched: true, errors: [] }),
            );
            await userEvent.setup().click(screen.getByRole('button', { name: 'Reset record' }));
            await userEvent.setup().click(screen.getByRole('button', { name: 'Touch' }));
            expect(screen.getByLabelText('Code').getAttribute('value')).toBe('Record padded');
            await userEvent.setup().type(screen.getByLabelText('Code'), ' edited');
            expect(screen.getByLabelText('Group state').textContent).toBe(
                JSON.stringify({ value: 'Record padded edited', touched: true, errors: [] }),
            );
        },
    );

    it('renders, edits and touches a mapped numeric group slot', async () => {
        expect.hasAssertions();
        const NumericGroup = withFieldGroup({
            defaultValues: { 0: '' },
            props: {},
            render: ({ group }) => (
                <>
                    <group.Field name="0">
                        {(current) => (
                            <label>
                                Numeric slot
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
                        )}
                    </group.Field>
                    <group.Subscribe
                        selector={(state) => ({ value: state.values[0], touched: state.fields['0']?.touched ?? false })}
                    >
                        {(state) => <output aria-label="Numeric group state">{JSON.stringify(state)}</output>}
                    </group.Subscribe>
                </>
            ),
        });
        const numericDefinition = defineForm<{ codes: { 0: string } }>()({
            id: 'numeric-group',
            defaultValues: { codes: { 0: 'Zero' } },
            fields: {},
            groups: {},
        });
        function Owner() {
            const instance = runtime.useForm(numericDefinition);
            return (
                <runtime.Form form={instance}>
                    {() => <NumericGroup form={instance.form} fields={{ 0: 'codes[0]' }} />}
                </runtime.Form>
            );
        }
        render(<Owner />);
        const user = userEvent.setup();
        await user.type(screen.getByLabelText('Numeric slot'), ' edited');
        await user.tab();
        expect(screen.getByLabelText('Numeric group state').textContent).toBe(
            JSON.stringify({ value: 'Zero edited', touched: true }),
        );
    });

    it('hydrates bracket paths, callable parents, and intrinsic function-name child properties', async () => {
        expect.hasAssertions();
        const bracket = defineForm<{ rows: Array<{ active: string }> }>()({
            id: 'bracket',
            defaultValues: { rows: [{ active: 'Draft' }] },
            fields: { 'rows[0].active': field('rows[0].active') },
            groups: {},
        });
        const rootArray = defineForm<Array<{ name: string }>>()({
            id: 'root-array',
            defaultValues: [{ name: 'Root' }],
            fields: { '[0].name': field('[0].name') },
            groups: {},
        });
        const element = (
            <>
                <runtime.Form form={definition}>
                    {({ fields: bound }) => (
                        <>
                            <bound.value />
                            <bound.value.name />
                            <bound.value.length />
                            <bound.value.displayName />
                        </>
                    )}
                </runtime.Form>
                <runtime.Form form={bracket}>
                    {({ fields: bound }) => {
                        const Active = bound.rows[0].active;
                        return <Active />;
                    }}
                </runtime.Form>
                <runtime.Form form={rootArray}>
                    {({ fields: bound }) => {
                        const Name = bound[0].name;
                        return <Name />;
                    }}
                </runtime.Form>
            </>
        );
        const container = document.createElement('div');
        document.body.append(container);
        container.innerHTML = renderToString(element);
        const inputs = [...container.querySelectorAll('input')];
        const errors = vi.fn<(error: unknown) => void>();
        const root = hydrateRoot(container, element, {
            onRecoverableError: (error) => {
                errors(error);
            },
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(errors).not.toHaveBeenCalled();
        expect([...container.querySelectorAll('input')]).toStrictEqual(inputs);
        expect(inputs.map((input) => input.value)).toStrictEqual(['Boston', 'Long', 'Display', 'Draft', 'Root']);
        act(() => {
            root.unmount();
        });
        container.remove();
    });

    it('reads absent dynamic fields safely and edits added rows and required record values', async () => {
        expect.hasAssertions();
        const dynamic = defineForm<{ rows: Array<{ active: boolean }>; codes: Record<string, string> }>()({
            id: 'dynamic-fields',
            defaultValues: { rows: [], codes: {} },
            fields: {},
            groups: {},
        });
        function Owner() {
            const instance = runtime.useForm(dynamic);
            const { form } = instance;
            return (
                <runtime.Form form={instance}>
                    {() => (
                        <>
                            <form.Field name="rows[0].active">
                                {(current) => (
                                    <input
                                        aria-label="Active"
                                        type="checkbox"
                                        checked={current.value ?? false}
                                        disabled={current.value === undefined}
                                        onChange={() => {
                                            current.setValue((previous) => !(previous ?? false));
                                        }}
                                    />
                                )}
                            </form.Field>
                            <button
                                type="button"
                                onClick={() => {
                                    form.append('rows', { active: false });
                                }}
                            >
                                Add row
                            </button>
                            <form.Field name="codes.missing">
                                {(current) => (
                                    <input
                                        aria-label="Dynamic code"
                                        value={current.value ?? ''}
                                        onChange={(event) => {
                                            current.setValue(event.target.value);
                                        }}
                                    />
                                )}
                            </form.Field>
                            <form.Subscribe selector={(state) => state.values}>
                                {(values) => <output aria-label="Dynamic values">{JSON.stringify(values)}</output>}
                            </form.Subscribe>
                        </>
                    )}
                </runtime.Form>
            );
        }
        render(<Owner />);
        expect(screen.getByLabelText('Dynamic values').textContent).toBe(JSON.stringify({ rows: [], codes: {} }));
        await userEvent.setup().click(screen.getByRole('button', { name: 'Add row' }));
        await userEvent.setup().click(screen.getByLabelText('Active'));
        await userEvent.setup().type(screen.getByLabelText('Dynamic code'), 'Code');
        expect(screen.getByLabelText('Dynamic values').textContent).toBe(
            JSON.stringify({ rows: [{ active: true }], codes: { missing: 'Code' } }),
        );
    });

    it('preserves parent/child identities, focus, and drafts across metadata and order changes', async () => {
        expect.hasAssertions();
        const parents: Array<unknown> = [];
        const children: Array<unknown> = [];
        const layout = ({
            fields: bound,
        }: {
            readonly fields: BoundFields<typeof fields, { Input: typeof Input; Parent: typeof Parent }>;
        }) => {
            parents.push(bound.value);
            children.push(bound.value.name);
            return (
                <>
                    <bound.value />
                    <bound.value.name />
                </>
            );
        };
        const view = render(<runtime.Form form={definition}>{layout}</runtime.Form>);
        const input = screen.getByLabelText('value.name');
        await userEvent.setup().clear(input);
        await userEvent.setup().type(input, 'Draft');
        view.rerender(
            <runtime.Form
                form={{
                    ...ordered(true),
                    fields: {
                        ...ordered(true).fields,
                        'value.name': { ...fields['value.name'], constraints: { maxLength: 20 } },
                    },
                }}
            >
                {layout}
            </runtime.Form>,
        );
        expect({
            parent: parents[1] === parents[0],
            child: children[1] === children[0],
            input: screen.getByLabelText('value.name') === input,
            focused: document.activeElement === input,
            value: input.getAttribute('value'),
            maxLength: input.getAttribute('maxlength'),
        }).toStrictEqual({ parent: true, child: true, input: true, focused: true, value: 'Draft', maxLength: '20' });
    });

    it('keeps committed child properties immutable while a different topology suspends', async () => {
        expect.hasAssertions();
        const baseFields = { value: fields.value, 'value.name': fields['value.name'] } as const;
        const base = { ...definition, fields: baseFields };
        const candidate = { ...definition, fields: { ...baseFields, 'value.length': fields['value.length'] } };
        const blocker = new Promise<void>(() => {
            /* Deliberately leave the candidate suspended. */
        });
        const seen = vi.fn<(pending: boolean, parent: object) => void>();
        function Blocker(): ReactNode {
            // oxlint-disable-next-line typescript/only-throw-error -- React Suspense requires throwing the pending promise.
            throw blocker;
        }
        function Owner() {
            const [pending, setPending] = useState(false);
            return (
                <>
                    <button
                        type="button"
                        onClick={() => {
                            startTransition(() => {
                                setPending(true);
                            });
                        }}
                    >
                        Replace
                    </button>
                    <Suspense fallback={<span>Pending</span>}>
                        <runtime.Form form={pending ? candidate : base}>
                            {({ fields: bound }) => {
                                seen(pending, bound.value);
                                return (
                                    <>
                                        <bound.value />
                                        <bound.value.name />
                                        {pending ? <Blocker /> : null}
                                    </>
                                );
                            }}
                        </runtime.Form>
                    </Suspense>
                </>
            );
        }
        render(<Owner />);
        const input = screen.getByLabelText('value.name');
        await userEvent.setup().type(input, ' edit');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Replace' }));
        const committedParent = seen.mock.calls[0]?.[1] ?? {};
        const candidateParent = seen.mock.calls.find(([pending]) => pending)?.[1] ?? {};
        expect(candidateParent).not.toBe(committedParent);
        expect(Reflect.get(committedParent, 'length')).toBe(1);
        expect(Reflect.get(candidateParent, 'length')).toBeTypeOf('function');
        expect(Reflect.get(candidateParent, 'name')).toBe(Reflect.get(committedParent, 'name'));
        expect({
            sameInput: screen.getByLabelText('value.name') === input,
            value: input.getAttribute('value'),
            fallback: screen.queryByText('Pending'),
        }).toStrictEqual({ sameInput: true, value: 'Boston edit', fallback: null });
    });
});
