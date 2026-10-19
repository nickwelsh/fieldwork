import type {
    BoundForm,
    Constraints,
    FieldDefinition,
    FormDefinition,
    FormDescriptor,
    FormOperation,
    GroupDefinition,
    SubmissionDriver,
    SubmissionResult,
    UploadProgress,
    SessionOptions,
} from '@fieldwork/core';
import type { ComponentType, FormHTMLAttributes, FunctionComponent, ReactNode } from 'react';
import type { FormApi } from './form-api.js';

export interface FieldProps<TValue = unknown> {
    readonly label: string;
    readonly helpText?: string;
    readonly constraints: ConstraintsFor<TValue>;
}

export type ConstraintsFor<TValue> = Omit<
    Constraints,
    'min' | 'max' | 'minLength' | 'maxLength' | 'minItems' | 'maxItems'
> &
    (NonNullable<TValue> extends string
        ? Pick<Constraints, 'minLength' | 'maxLength'>
        : NonNullable<TValue> extends number
          ? Pick<Constraints, 'min' | 'max'>
          : NonNullable<TValue> extends ReadonlyArray<unknown>
            ? Pick<Constraints, 'minItems' | 'maxItems'>
            : unknown extends TValue
              ? Constraints
              : object);

/** A bivariant registry accepts application component props without exposing `any`. */
export type ComponentRegistry = Record<
    string,
    // oxlint-disable-next-line typescript/method-signature-style -- React registries intentionally use bivariant props.
    { bivarianceHack(props: object): ReturnType<FunctionComponent<object>> }['bivarianceHack']
>;
export type PropsOf<TComponent> = TComponent extends (...args: infer TArgs) => unknown
    ? TArgs extends []
        ? object
        : TArgs[0]
    : never;
export type FormOptions<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> = Pick<SessionOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>, 'run'> & {
    readonly operation?: FormOperation<TOutput, TSuccess, TError, TServices>;
    readonly defaultValues?: TValues;
    readonly submission?: SubmissionDriver;
    readonly onResult?: (result: SubmissionResult<NoInfer<TSuccess>, NoInfer<TError>>) => void;
    readonly onProgress?: (progress: UploadProgress) => void;
};

export interface FormInstance<
    TValues extends object,
    TFields extends Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>>,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> {
    readonly definition: FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>;
    readonly form: FormApi<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>;
    readonly cancel: () => void;
}

export interface UseForm {
    <
        TValues extends object,
        const TFields extends Readonly<Record<string, FieldDefinition>>,
        const TGroups extends Readonly<Record<string, GroupDefinition>>,
        TOutput = TValues,
        TSuccess = void,
        TError = unknown,
    >(
        input:
            | FormDefinition<TValues, TFields, TGroups, TOutput>
            | BoundForm<FormDefinition<TValues, TFields, TGroups, TOutput>>
            | FormDescriptor<TValues, TFields, TGroups, TOutput, TSuccess, TError>,
    ): FormInstance<TValues, TFields, TGroups, TOutput, TSuccess, TError>;
    <
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
            | BoundForm<FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>>
            | FormDescriptor<TValues, TFields, TGroups, TOutput, TSuccess, TError, TSchemaServices>,
        options: FormOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>,
    ): FormInstance<TValues, TFields, TGroups, TOutput, TSuccess, TError, TServices, TSchemaServices>;
}

type ComponentOverrides<TComponent> = Partial<PropsOf<TComponent>>;
// Bound fields are callable wrappers. React component statics such as displayName
// must not intersect a named child binding with an unrelated string type.
type BoundFieldComponent<TComponent> = (props: ComponentOverrides<TComponent>) => ReactNode;
type DotPath<TPath extends string> = TPath extends `${infer THead}[${infer TIndex}]${infer TTail}`
    ? DotPath<`${THead extends '' ? '' : `${THead}.`}${TIndex}${TTail}`>
    : TPath;
type PathTree<TPath extends string, TValue> = TPath extends `${infer THead}.${infer TTail}`
    ? Readonly<Record<THead, PathTree<TTail, TValue>>>
    : Readonly<Record<TPath, TValue>>;
type Intersection<TUnion> = (TUnion extends unknown ? (value: TUnion) => void : never) extends (
    value: infer TValue,
) => void
    ? TValue
    : never;
export type BoundFields<
    TFields extends Readonly<Record<string, FieldDefinition>>,
    TRegistry extends ComponentRegistry,
> = Intersection<
    {
        [K in keyof TFields & string]: K extends `${string}*${string}`
            ? never
            : PathTree<DotPath<K>, BoundFieldComponent<TRegistry[TFields[K]['component']]>>;
    }[keyof TFields & string]
>;

export type BoundComponents<TRegistry extends ComponentRegistry> = {
    readonly [K in keyof TRegistry]: ComponentType<PropsOf<TRegistry[K]>>;
};
export type BoundGroups<
    TGroups extends Readonly<Record<string, GroupDefinition>>,
    TRegistry extends ComponentRegistry,
> = {
    readonly [K in keyof TGroups]: ComponentType<
        Partial<Omit<PropsOf<TRegistry[TGroups[K]['component']]>, 'form' | 'fields'>>
    >;
};

export interface LayoutBindings<
    TFields extends Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>>,
    TFieldComponents extends ComponentRegistry,
    TComponents extends ComponentRegistry,
    TGroupComponents extends ComponentRegistry,
> {
    readonly fields: BoundFields<TFields, TFieldComponents>;
    readonly components: BoundComponents<TComponents>;
    readonly groups: BoundGroups<TGroups, TGroupComponents>;
}

export type FormProps<
    TValues extends object,
    TFields extends Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>>,
    TFieldComponents extends ComponentRegistry,
    TComponents extends ComponentRegistry,
    TGroupComponents extends ComponentRegistry,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> = Omit<FormHTMLAttributes<HTMLFormElement>, 'children' | 'onSubmit' | 'onProgress' | 'defaultValue'> & {
    readonly children?: (
        bindings: LayoutBindings<TFields, TGroups, TFieldComponents, TComponents, TGroupComponents>,
    ) => ReactNode;
} & (
        | (FormOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> & {
              readonly form:
                  | BoundForm<FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>>
                  | FormDescriptor<TValues, TFields, TGroups, TOutput, TSuccess, TError, TSchemaServices>
                  | FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>;
          })
        | ({
              readonly [K in keyof FormOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>]?: never;
          } & {
              readonly form: FormInstance<
                  TValues,
                  TFields,
                  TGroups,
                  TOutput,
                  TSuccess,
                  TError,
                  TServices,
                  TSchemaServices
              >;
          })
    );
