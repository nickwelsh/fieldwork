/* oxlint-disable typescript/no-unsafe-type-assertion -- Slot projection is a checked mapping from statically typed parent paths to local group values. */
import { getValue, normalizePath } from '@fieldwork/core';
import type { FieldPath, FieldPathInput, FieldPathValue, FormState } from '@fieldwork/core';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { FieldApi, FormApi } from './form-api.js';
import { useSelection } from './hooks.js';

type CompatiblePath<TParent extends object, TValue> = {
    [P in FieldPath<TParent>]: [FieldPathValue<TParent, P>] extends [TValue]
        ? [TValue] extends [FieldPathValue<TParent, P>]
            ? [FieldPathInput<TParent, P>] extends [TValue]
                ? [TValue] extends [FieldPathInput<TParent, P>]
                    ? P
                    : never
                : never
            : never
        : never;
}[FieldPath<TParent>];

export type GroupFields<TValues extends object, TParent extends object> = {
    readonly [K in keyof TValues & (string | number) as `${K}`]: CompatiblePath<TParent, TValues[K]>;
};

export interface GroupState<TValues extends object> {
    readonly values: TValues;
    readonly baseline: TValues;
    readonly fields: Readonly<Record<string, { readonly touched: boolean }>>;
    readonly errors: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly isDirty: boolean;
}

export interface GroupApi<TValues extends object> {
    readonly getState: () => GroupState<TValues>;
    readonly getFieldValue: FormApi<TValues>['getFieldValue'];
    readonly setFieldValue: FormApi<TValues>['setFieldValue'];
    readonly touchField: FormApi<TValues>['touchField'];
    readonly Field: FormApi<TValues>['Field'];
    readonly Subscribe: <T>(props: {
        readonly selector: (state: GroupState<TValues>) => T;
        readonly children: (value: T) => ReactNode;
    }) => ReactNode;
}

/** Map reusable local slots onto the owning form's paths without another state store. */
export function withFieldGroup<TValues extends object, TProps extends object>(options: {
    readonly defaultValues: TValues;
    readonly props: TProps;
    readonly render: (props: Partial<TProps> & { readonly group: GroupApi<TValues> }) => ReactNode;
}): <TParent extends object, TOutput, TSuccess, TError, TServices, TSchemaServices>(
    props: Partial<TProps> & {
        readonly form: FormApi<TParent, TOutput, TSuccess, TError, TServices, TSchemaServices>;
        readonly fields: GroupFields<TValues, TParent>;
    },
) => ReactNode {
    return function FieldGroup<TParent extends object, TOutput, TSuccess, TError, TServices, TSchemaServices>(
        props: Partial<TProps> & {
            readonly form: FormApi<TParent, TOutput, TSuccess, TError, TServices, TSchemaServices>;
            readonly fields: GroupFields<TValues, TParent>;
        },
    ): ReactNode {
        const { form, fields, ...presentation } = props;
        // oxlint-disable-next-line unicorn/no-array-sort -- Object.entries owns this new array; ES2022 is the package target.
        const mappingKey = JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)));
        const group = useMemo(
            () =>
                createGroupApi<TValues>(
                    form as unknown as FormApi<Record<string, unknown>>,
                    Object.fromEntries(JSON.parse(mappingKey) as Array<[string, string]>),
                ),
            [form, mappingKey],
        );
        return options.render({ ...options.props, ...presentation, group });
    };
}

function stableRecord<T>(
    previous: Readonly<Record<string, T>>,
    next: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
    const keys = Object.keys(next);
    return keys.length === Object.keys(previous).length && keys.every((key) => Object.is(previous[key], next[key]))
        ? previous
        : Object.freeze(next);
}

function createGroupApi<TValues extends object>(
    form: FormApi<Record<string, unknown>>,
    fields: Readonly<Record<string, string>>,
): GroupApi<TValues> {
    const setRuntimeValue: (name: string, next: unknown) => void = form.setFieldValue;
    const mapping = fields;
    const path = (name: string): string => {
        const [slot, ...tail] = normalizePath(name).split('.');
        const target = slot === undefined ? undefined : mapping[slot];
        if (target === undefined) {
            throw new Error(`Unknown field group slot: ${name}`);
        }
        // Session methods resolve aliases against current values. A mounted Field must
        // retain the raw path when an array later becomes a record with distinct keys.
        return [target, ...tail].join('.');
    };
    let previous: FormState<Record<string, unknown>> | undefined = undefined;
    let projected: GroupState<TValues> | undefined = undefined;
    const project = (state: FormState<Record<string, unknown>>): GroupState<TValues> => {
        if (previous !== state || projected === undefined) {
            const values = Object.fromEntries(
                Object.entries(mapping).map(([slot, target]) => [slot, getValue(state.values, target)]),
            );
            const baseline = Object.fromEntries(
                Object.entries(mapping).map(([slot, target]) => [slot, getValue(state.baseline, target)]),
            );
            const errors: Record<string, ReadonlyArray<string>> = {};
            const metadata: Record<string, { readonly touched: boolean }> = {};
            for (const [slot, rawTarget] of Object.entries(mapping)) {
                const target = form.session.resolvePath(rawTarget);
                for (const [name, messages] of Object.entries(state.errors)) {
                    if (name === target || name.startsWith(`${target}.`)) {
                        errors[`${slot}${name.slice(target.length)}`] = messages;
                    }
                }
                for (const [name, meta] of Object.entries(state.fields)) {
                    if (name === target || name.startsWith(`${target}.`)) {
                        metadata[`${slot}${name.slice(target.length)}`] = meta;
                    }
                }
            }
            projected = Object.freeze({
                values: stableRecord((projected?.values ?? {}) as Record<string, unknown>, values) as TValues,
                baseline: stableRecord((projected?.baseline ?? {}) as Record<string, unknown>, baseline) as TValues,
                errors: stableRecord(projected?.errors ?? {}, errors),
                fields: stableRecord(projected?.fields ?? {}, metadata),
                isDirty: Object.values(mapping).some((target) => form.session.getField(target).dirty),
            });
            previous = state;
        }
        return projected;
    };
    function Subscribe<T>({
        selector,
        children,
    }: {
        readonly selector: (state: GroupState<TValues>) => T;
        readonly children: (value: T) => ReactNode;
    }): ReactNode {
        const select = useMemo(
            () => (state: FormState<Record<string, unknown>>) => selector(project(state)),
            [selector],
        );
        return children(useSelection(form.session, select));
    }
    function Field<P extends FieldPath<TValues>>({
        name,
        children,
    }: {
        readonly name: P;
        readonly children: (field: FieldApi<FieldPathValue<TValues, P>, FieldPathInput<TValues, P>>) => ReactNode;
    }): ReactNode {
        return <form.Field name={path(name)}>{children as (field: FieldApi<unknown>) => ReactNode}</form.Field>;
    }
    return {
        getState: () => project(form.session.getSnapshot()),
        getFieldValue: (name) => form.getFieldValue(path(name)) as never,
        setFieldValue: (name, value) => {
            setRuntimeValue(path(name), value);
        },
        touchField: (name) => {
            form.touchField(path(name));
        },
        Subscribe,
        Field,
    };
}
