/* oxlint-disable typescript/no-unsafe-type-assertion -- The public API preserves generics while render components dispatch through an erased runtime context. */
import type {
    FieldPath,
    FieldPathInput,
    FieldPathValue,
    FormSession,
    FormState,
    SubmissionResult,
} from '@formbraid/core';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { FieldContext, useFieldContext, useSelection } from './hooks.js';

export interface FieldApi<TValue, TInput = TValue> {
    readonly name: string;
    readonly value: TValue;
    readonly errors: ReadonlyArray<string>;
    readonly meta: { readonly isTouched: boolean; readonly isDirty: boolean; readonly isValid: boolean };
    readonly setValue: (value: TInput | ((previous: TValue) => TInput)) => void;
    readonly touch: () => void;
}

export type ReactFormState<TValues extends object, TSuccess = void, TError = unknown> = FormState<
    TValues,
    TSuccess,
    TError
> & {
    readonly isSubmitting: boolean;
    readonly canSubmit: boolean;
};

export interface FormApi<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> {
    readonly session: FormSession<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>;
    readonly getState: () => ReactFormState<TValues, TSuccess, TError>;
    readonly getFieldValue: <P extends FieldPath<TValues>>(name: P) => FieldPathValue<TValues, P>;
    readonly setFieldValue: <P extends FieldPath<TValues>>(
        name: P,
        value: FieldPathInput<TValues, P> | ((previous: FieldPathValue<TValues, P>) => FieldPathInput<TValues, P>),
    ) => void;
    readonly touchField: (name: FieldPath<TValues>) => void;
    readonly reset: (values?: TValues) => void;
    readonly handleSubmit: () => Promise<SubmissionResult<TSuccess, TError>>;
    readonly cancel: () => void;
    readonly append: FormSession<TValues>['append'];
    readonly remove: FormSession<TValues>['remove'];
    readonly move: FormSession<TValues>['move'];
    readonly Subscribe: <T>(props: {
        readonly selector: (state: ReactFormState<TValues, TSuccess, TError>) => T;
        readonly children: (value: T) => ReactNode;
    }) => ReactNode;
    readonly Field: <P extends FieldPath<TValues>>(props: {
        readonly name: P;
        readonly children: (field: FieldApi<FieldPathValue<TValues, P>, FieldPathInput<TValues, P>>) => ReactNode;
    }) => ReactNode;
}

export function reactState<TValues extends object, TSuccess = void, TError = unknown>(
    state: FormState<TValues, TSuccess, TError>,
): ReactFormState<TValues, TSuccess, TError> {
    const isSubmitting = state.execution.status === 'validating' || state.execution.status === 'submitting';
    return Object.freeze({ ...state, isSubmitting, canSubmit: !isSubmitting });
}

function FieldChild({ children }: { readonly children: (field: FieldApi<unknown>) => ReactNode }): ReactNode {
    return children(useFieldContext());
}

/** Constructed once per mounted session; component identities never change on edits. */
export function createFormApi<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
>(
    session: FormSession<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>,
): FormApi<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> {
    const runtime = session as unknown as FormSession<Record<string, unknown>>;
    const setRuntimeValue: (name: string, next: unknown) => void = runtime.setValue;
    function Subscribe<T>({
        selector,
        children,
    }: {
        readonly selector: (state: ReactFormState<TValues, TSuccess, TError>) => T;
        readonly children: (value: T) => ReactNode;
    }): ReactNode {
        const select = useMemo(
            () => (state: FormState<Record<string, unknown>>) =>
                selector(reactState(state as unknown as FormState<TValues, TSuccess, TError>)),
            [selector],
        );
        return children(useSelection(runtime, select));
    }
    function Field<P extends FieldPath<TValues>>({
        name,
        children,
    }: {
        readonly name: P;
        readonly children: (field: FieldApi<FieldPathValue<TValues, P>, FieldPathInput<TValues, P>>) => ReactNode;
    }): ReactNode {
        const context = useMemo(() => ({ session: runtime, name }), [name]);
        return (
            <FieldContext value={context}>
                <FieldChild>{children as (field: FieldApi<unknown>) => ReactNode}</FieldChild>
            </FieldContext>
        );
    }
    return {
        session,
        getState: () => reactState(session.getSnapshot()),
        getFieldValue: (name) => session.getField(name).value,
        setFieldValue: (name, value) => {
            setRuntimeValue(
                name,
                typeof value === 'function'
                    ? (value as (previous: unknown) => unknown)(session.getField(name).value)
                    : value,
            );
        },
        touchField: (name) => {
            session.touch(name);
        },
        reset: (values) => {
            session.reset(values);
        },
        handleSubmit: session.submit,
        cancel: session.cancel,
        append: session.append,
        remove: session.remove,
        move: session.move,
        Subscribe,
        Field,
    };
}
