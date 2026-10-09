import { createFormSession } from '@fieldwork/core';
import type {
    BoundForm,
    FieldDefinition,
    FormDefinition,
    GroupDefinition,
    SessionOptions,
    SubmissionDriver,
    UploadProgress,
} from '@fieldwork/core';
import { createElement, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createBindings, eraseInstance, typedBindings, InstanceContext } from './render.js';
import type { BindingIdentityCache, RuntimeBindings } from './render.js';
import { createFormApi } from './form-api.js';
import { FormContext } from './hooks.js';
import type { ComponentRegistry, FormInstance, FormOptions, FormProps, UseForm } from './types.js';

function notify<T>(callback: (value: T) => void, value: T): void {
    try {
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Lifecycle notifications are synchronous callbacks.
        callback(value);
    } catch (error) {
        globalThis.reportError(error);
    }
}

export interface FieldworkOptions<
    TFields extends ComponentRegistry,
    TComponents extends ComponentRegistry,
    TGroups extends ComponentRegistry,
> {
    readonly fieldComponents: TFields;
    readonly formComponents: TComponents;
    readonly fieldGroups?: TGroups;
    readonly submissions?: Readonly<Record<string, SubmissionDriver>>;
    readonly submitComponent?: keyof TComponents & string;
}

export function createFieldwork<
    const TFieldComponents extends ComponentRegistry,
    const TComponents extends ComponentRegistry,
    const TGroupComponents extends ComponentRegistry = Record<string, never>,
>(config: FieldworkOptions<TFieldComponents, TComponents, TGroupComponents>) {
    const cache = new WeakMap<object, WeakMap<object, RuntimeBindings>>();
    const identities: BindingIdentityCache = {
        fields: new Map(),
        containers: new Map(),
        groups: new Map(),
        components: new Map(),
    };
    const groupRegistry = config.fieldGroups ?? {};

    function useFormImplementation<
        TValues extends object,
        const TFields extends Readonly<Record<string, FieldDefinition>>,
        const TGroups extends Readonly<Record<string, GroupDefinition>>,
        TOutput = TValues,
        TSuccess = void,
        TError = unknown,
        TServices = never,
        TSchemaServices = never,
    >(
        input:
            | FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>
            | BoundForm<FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>>,
        options: Partial<FormOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>> = {},
    ): FormInstance<TValues, TFields, TGroups, TOutput, TSuccess, TError, TServices, TSchemaServices> {
        const bound = 'definition' in input ? input : undefined;
        const definition = 'definition' in input ? input.definition : input;
        const registeredDriver =
            bound === undefined ||
            config.submissions === undefined ||
            !Object.hasOwn(config.submissions, bound.submission.driver)
                ? undefined
                : config.submissions[bound.submission.driver];
        const driver = options.submission ?? registeredDriver;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- FormOptions retains the conditional runner requirement; rebuilding its optional keys preserves it.
        const sessionOptions = {
            definition,
            ...(options.defaultValues === undefined ? {} : { defaultValues: options.defaultValues }),
            ...(options.operation === undefined ? {} : { operation: options.operation }),
            ...(options.run === undefined ? {} : { run: options.run }),
            ...(bound === undefined ? {} : { binding: bound.submission.binding }),
            ...(driver === undefined ? {} : { driver }),
        } as SessionOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>;
        // oxlint-disable-next-line react/hook-use-state -- Sessions are constructed once; their own subscriptions publish state.
        const [session] = useState(() => createFormSession(sessionOptions));
        const lifetime = useRef({ mounted: false, options });
        // oxlint-disable-next-line react/hook-use-state -- The form API and its component identities are mount-only.
        const [form] = useState(() => createFormApi(session));
        // Install only committed options, before descendants can submit from layout effects.
        useInsertionEffect(() => {
            lifetime.current.options = options;
            session.updateOptions({
                ...sessionOptions,
                onResult: (result) => {
                    const { current } = lifetime;
                    if (current.mounted && current.options.onResult !== undefined) {
                        notify(current.options.onResult, result);
                    } else if (!current.mounted && result.status !== 'cancelled') {
                        const { execution } = session.getSnapshot();
                        if (execution.status === result.status) {
                            // A supplied runner may fail synchronously in a child's layout effect.
                            // Deliver after activation only while that terminal execution remains current.
                            queueMicrotask(() => {
                                const observer = current.options.onResult;
                                if (
                                    current.mounted &&
                                    observer !== undefined &&
                                    session.getSnapshot().execution === execution
                                ) {
                                    notify(observer, result);
                                }
                            });
                        }
                    }
                },
            });
        });
        useInsertionEffect(() => {
            const { current } = lifetime;
            // oxlint-disable-next-line eslint/init-declarations -- No progress is available before a submission.
            let progress: UploadProgress | undefined;
            const unsubscribe = session.subscribe(() => {
                const next = session.getSnapshot().progress;
                if (next === progress) {
                    return;
                }
                // Observers can publish synchronously; retain their newer or cleared progress.
                progress = next;
                if (next !== undefined && lifetime.current.options.onProgress !== undefined) {
                    const deliver = () => {
                        const observer = lifetime.current.options.onProgress;
                        if (current.mounted && observer !== undefined && session.getSnapshot().progress === next) {
                            notify(observer, next);
                        }
                    };
                    if (current.mounted) {
                        deliver();
                    } else {
                        // Child layout effects precede the owner's setup. Initially hidden Activity
                        // owners never run that setup; canceled/replaced progress must not replay.
                        queueMicrotask(deliver);
                    }
                }
            });
            return () => {
                current.mounted = false;
                unsubscribe();
            };
        }, [session, lifetime]);
        useLayoutEffect(() => {
            // StrictMode replays layout effects without replaying insertion effects.
            const { current } = lifetime;
            current.mounted = true;
            return () => {
                current.mounted = false;
                session.cancel();
            };
        }, [session, lifetime]);
        return useMemo(() => ({ definition, form, cancel: session.cancel }), [definition, form, session]);
    }

    // The public overloads restrict omitted options to service-free definitions.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript erases service defaults while comparing generic overload returns; the input overload keeps serviceful definitions paired with a runner.
    const useForm = useFormImplementation as UseForm;

    function render<
        TValues extends object,
        TFields extends Readonly<Record<string, FieldDefinition>>,
        TGroups extends Readonly<Record<string, GroupDefinition>>,
        TOutput,
        TSuccess,
        TError,
        TServices,
        TSchemaServices,
    >(
        instance: FormInstance<TValues, TFields, TGroups, TOutput, TSuccess, TError, TServices, TSchemaServices>,
        props: Omit<
            FormProps<
                TValues,
                TFields,
                TGroups,
                TFieldComponents,
                TComponents,
                TGroupComponents,
                TOutput,
                TSuccess,
                TError,
                TServices,
                TSchemaServices
            >,
            'form'
        > & { readonly form?: unknown },
    ): ReactNode {
        const {
            form: _source,
            children,
            defaultValues: _defaults,
            submission: _submission,
            onResult: _result,
            onProgress: _progress,
            operation: _operation,
            run: _run,
            ...html
        } = props;
        const runtime = eraseInstance({
            ...instance,
            fieldComponents: config.fieldComponents,
            formComponents: config.formComponents,
        });
        let byGroups = cache.get(instance.definition.fields);
        if (byGroups === undefined) {
            byGroups = new WeakMap();
            cache.set(instance.definition.fields, byGroups);
        }
        let bindings = byGroups.get(instance.definition.groups);
        if (bindings === undefined) {
            bindings = createBindings(runtime.definition, {
                components: Object.keys(config.formComponents),
                registry: groupRegistry,
                identities,
                submitComponent: config.submitComponent ?? 'SubmitButton',
            });
            byGroups.set(instance.definition.groups, bindings);
        }
        const content =
            children === undefined
                ? bindings.automatic.map(({ component, key }) => createElement(component, { key }))
                : children(typedBindings<TFields, TGroups, TFieldComponents, TComponents, TGroupComponents>(bindings));
        return (
            <InstanceContext value={runtime}>
                <FormContext value={runtime.form}>
                    <form
                        {...html}
                        noValidate
                        onSubmit={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void instance.form.handleSubmit();
                        }}
                    >
                        {content}
                    </form>
                </FormContext>
            </InstanceContext>
        );
    }

    function DefinitionForm<
        TValues extends object,
        const TFields extends Readonly<Record<string, FieldDefinition>>,
        const TGroups extends Readonly<Record<string, GroupDefinition>>,
        TOutput,
        TSuccess,
        TError,
        TServices,
        TSchemaServices,
    >(
        props: FormProps<
            TValues,
            TFields,
            TGroups,
            TFieldComponents,
            TComponents,
            TGroupComponents,
            TOutput,
            TSuccess,
            TError,
            TServices,
            TSchemaServices
        > & {
            readonly form:
                | FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>
                | BoundForm<FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>>;
        },
    ): ReactNode {
        const instance = useForm(props.form, props);
        return render(instance, props);
    }

    function Form<
        TValues extends object,
        const TFields extends Readonly<Record<string, FieldDefinition>>,
        const TGroups extends Readonly<Record<string, GroupDefinition>>,
        TOutput = TValues,
        TSuccess = void,
        TError = unknown,
        TServices = never,
        TSchemaServices = never,
    >(
        props: FormProps<
            TValues,
            TFields,
            TGroups,
            TFieldComponents,
            TComponents,
            TGroupComponents,
            TOutput,
            TSuccess,
            TError,
            TServices,
            TSchemaServices
        >,
    ): ReactNode {
        if ('form' in props.form) {
            return render(props.form, props);
        }
        return <DefinitionForm {...props} form={props.form} />;
    }

    return { Form, useForm };
}
