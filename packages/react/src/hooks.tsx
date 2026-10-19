/* oxlint-disable typescript/no-unsafe-type-assertion -- React contexts erase form and field generics at this single provider boundary. */
import type { FormSession, FormState } from '@formbraid/core';
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { FieldApi, FormApi } from './form-api.js';

type RuntimeSession = FormSession<Record<string, unknown>>;

export const FormContext = createContext<FormApi<Record<string, unknown>> | null>(null);
export const FieldContext = createContext<{ readonly session: RuntimeSession; readonly name: string } | null>(null);

/** Cache selector output by equality so unrelated state updates do not render consumers. */
export function useSelection<T>(
    session: RuntimeSession,
    selector: (state: FormState<Record<string, unknown>>) => T,
    equal: (previous: T, next: T) => boolean = Object.is,
): T {
    const getSnapshot = useMemo(() => selectionSnapshot(session, selector, equal), [session, selector, equal]);
    return useSyncExternalStore(session.subscribe, getSnapshot, getSnapshot);
}

function selectionSnapshot<T>(
    session: RuntimeSession,
    selector: (state: FormState<Record<string, unknown>>) => T,
    equal: (previous: T, next: T) => boolean,
): () => T {
    let cache: { readonly state: FormState<Record<string, unknown>>; readonly value: T } | undefined = undefined;
    return () => {
        const state = session.getSnapshot();
        if (cache?.state === state) {
            return cache.value;
        }
        const next = selector(state);
        cache = { state, value: cache !== undefined && equal(cache.value, next) ? cache.value : next };
        return cache.value;
    };
}

export function useFormContext<
    TValues extends object = object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
>(): FormApi<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> {
    const form = useContext(FormContext);
    if (form === null) {
        throw new Error('useFormContext must be used inside a Formbraid Form.');
    }
    return form as unknown as FormApi<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>;
}

export function useFieldContext<TValue = unknown, TInput = TValue>(): FieldApi<TValue, TInput> {
    const context = useContext(FieldContext);
    if (context === null) {
        throw new Error('useFieldContext must be used inside a Formbraid field.');
    }
    const { session, name } = context;
    const selector = useMemo(() => () => session.getField(name), [session, name]);
    const field = useSelection(session, selector, sameField);
    const actions = useMemo(
        () => ({
            name,
            setValue: (value: TInput | ((previous: TValue) => TInput)): void => {
                const next =
                    typeof value === 'function'
                        ? (value as (previous: TValue) => TInput)(session.getField(name).value as TValue)
                        : value;
                session.setValue(name, next);
            },
            touch: (): void => {
                session.touch(name);
            },
        }),
        [session, name],
    );
    return {
        ...actions,
        value: field.value as TValue,
        errors: field.errors,
        meta: { isTouched: field.touched, isDirty: field.dirty, isValid: field.errors.length === 0 },
    };
}

function sameField(
    previous: ReturnType<RuntimeSession['getField']>,
    next: ReturnType<RuntimeSession['getField']>,
): boolean {
    return (
        Object.is(previous.value, next.value) &&
        previous.touched === next.touched &&
        previous.dirty === next.dirty &&
        previous.errors.length === next.errors.length &&
        previous.errors.every((error, index) => error === next.errors[index])
    );
}
