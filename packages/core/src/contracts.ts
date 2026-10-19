import type { Effect, Schema as EffectSchema } from 'effect';

export type JsonValue = EffectSchema.Json;

export type ValueType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'enum' | 'file' | 'array' | 'object';

export interface RequiredCondition {
    readonly field: string;
    readonly values: ReadonlyArray<JsonValue>;
    readonly operator: 'equals' | 'notEquals' | 'present' | 'absent';
}

export interface Constraints {
    readonly required?: boolean;
    readonly requiredWhen?: ReadonlyArray<RequiredCondition>;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly min?: number;
    readonly max?: number;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly options?: ReadonlyArray<string | number>;
    readonly format?: 'email' | 'url' | 'date';
}

export interface FieldDefinition {
    readonly name: string;
    readonly type: ValueType;
    readonly component: string;
    readonly label: string;
    readonly helpText?: string;
    readonly props: Readonly<Record<string, JsonValue>>;
    readonly constraints: Constraints;
    readonly nullable: boolean;
    readonly serverRules: ReadonlyArray<string>;
}

export interface GroupDefinition {
    readonly component: string;
    readonly label?: string;
    readonly helpText?: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly props: Readonly<Record<string, JsonValue>>;
}

export interface SubmissionTarget {
    readonly url: string;
    readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
}

/** A native Effect codec whose encoded representation is the editable draft. */
export type Schema<TInput, TOutput = TInput, TDecodingServices = never> = EffectSchema.Codec<
    TOutput,
    TInput,
    TDecodingServices,
    unknown
>;

export type FormDefinition<
    TValues extends object = object,
    TFields extends Readonly<Record<string, FieldDefinition>> = Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>> = Readonly<Record<string, GroupDefinition>>,
    TOutput = TValues,
    TSchemaServices = never,
> = {
    readonly id: string;
    readonly defaultValues: TValues;
    readonly fields: TFields;
    readonly groups: TGroups;
} & ([TValues] extends [TOutput]
    ? { readonly schema?: Schema<TValues, TOutput, TSchemaServices> }
    : { readonly schema: Schema<TValues, TOutput, TSchemaServices> });

export interface UploadProgress {
    readonly loaded: number;
    readonly total: number;
    readonly percentage?: number;
}

// Conditional void success retains the portable driver's no-payload contract.
/* oxlint-disable typescript/no-invalid-void-type -- void is used to distinguish no-payload driver success from typed operation success. */
export type SubmissionResult<TSuccess = void, TError = unknown> =
    | ({ readonly status: 'success' } & ([TSuccess] extends [void]
          ? { readonly value?: TSuccess }
          : { readonly value: TSuccess }))
    | { readonly status: 'invalid'; readonly errors: Readonly<Record<string, string | ReadonlyArray<string>>> }
    | { readonly status: 'cancelled' }
    | { readonly status: 'failure'; readonly error: TError }
    | { readonly status: 'defect'; readonly error: unknown };

/* oxlint-enable typescript/no-invalid-void-type */

export interface SubmissionContext {
    readonly data: object;
    readonly binding: JsonValue;
    readonly signal: AbortSignal;
    readonly onProgress?: (progress: UploadProgress) => void;
}

export interface SubmissionDriver {
    readonly submit: (context: SubmissionContext) => Effect.Effect<SubmissionResult>;
}

/** Runtime context supplied to per-form callbacks after validation. */
export interface SubmissionCallbackContext {
    readonly signal: AbortSignal;
    readonly onProgress: (progress: UploadProgress) => void;
}

/** Producers return an explicit outcome; Promise resolution alone is not success. */
export type SubmissionCallback<TOutput, TSuccess = void, TError = unknown> = (
    values: TOutput,
    context: SubmissionCallbackContext,
) => SubmissionResult<TSuccess, TError> | PromiseLike<SubmissionResult<TSuccess, TError>>;

export interface CallbackSubmission<TOutput, TSuccess = void, TError = unknown> {
    readonly submit: SubmissionCallback<TOutput, TSuccess, TError>;
    readonly driver?: never;
    readonly binding?: never;
}

export type FormSubmission<TOutput, TSuccess = void, TError = unknown> =
    | SubmissionBinding
    | CallbackSubmission<TOutput, TSuccess, TError>;

/** Public producer contract. React owns the session; producers supply data and execution. */
export interface FormDescriptor<
    TValues extends object = object,
    TFields extends Readonly<Record<string, FieldDefinition>> = Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>> = Readonly<Record<string, GroupDefinition>>,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TSchemaServices = never,
> {
    readonly version: 1;
    readonly definition: FormDefinition<TValues, TFields, TGroups, TOutput, TSchemaServices>;
    readonly defaultValues?: TValues;
    readonly submission: FormSubmission<TOutput, TSuccess, TError>;
}

/** JSON-only form descriptor for generators and external data boundaries. */
export interface FormDescriptorData {
    readonly version: 1;
    readonly definition: Omit<FormDefinition<Record<string, JsonValue>>, 'schema'>;
    readonly defaultValues?: Record<string, JsonValue>;
    readonly submission: SubmissionBinding;
}

/** Legacy driver binding shape; new producers should use FormDescriptor. */
export interface BoundForm<
    TDefinition extends FormDefinition<
        object,
        Readonly<Record<string, FieldDefinition>>,
        Readonly<Record<string, GroupDefinition>>,
        unknown,
        unknown
    > = FormDefinition,
> {
    readonly definition: TDefinition;
    readonly submission: SubmissionBinding;
}

export interface SubmissionBinding {
    readonly submit?: never;
    readonly driver: string;
    readonly binding: JsonValue;
}

export interface HttpOperation {
    readonly uri: string;
    readonly method: SubmissionTarget['method'];
}

export interface OperationParameter {
    readonly name: string;
    readonly optional?: boolean;
}

export interface Operation<TBinding = JsonValue> {
    readonly name: string;
    readonly schema: string;
    readonly parameters: ReadonlyArray<OperationParameter>;
    readonly binding: TBinding;
}

export interface Extraction {
    readonly version: 1;
    readonly forms: ReadonlyArray<FormDefinition<Record<string, JsonValue>>>;
    readonly diagnostics: ReadonlyArray<string>;
}
