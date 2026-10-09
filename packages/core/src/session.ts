/* oxlint-disable typescript/no-unsafe-type-assertion -- Immutable path updates preserve the public generic types after runtime container/path checks. */
import {
    Cause,
    Deferred,
    Effect,
    Equal,
    Exit,
    Fiber,
    Ref,
    Scope,
    Schema as EffectSchema,
    SchemaAST,
    SchemaIssue,
    Result,
} from 'effect';
import { AtomRef } from 'effect/reactivity';
import type {
    FieldDefinition,
    FormDefinition,
    GroupDefinition,
    JsonValue,
    Schema,
    SubmissionDriver,
    SubmissionResult,
    UploadProgress,
} from './contracts.js';
import { definitionArrayAt, getValue, isPathSegment, normalizePath, pathSegments } from './paths.js';
import { definitionSchema } from './validation.js';

type Atomic =
    | string
    | number
    | boolean
    | bigint
    | symbol
    | null
    | undefined
    | Date
    | Blob
    | ReadonlyMap<unknown, unknown>
    | ReadonlySet<unknown>;
type JoinPath<A extends string, B extends string> = B extends `[${string}` ? `${A}${B}` : `${A}.${B}`;
type NestedPaths<A extends string, T, D extends ReadonlyArray<unknown>> = T extends unknown
    ? JoinPath<A, Paths<T, D>>
    : never;
type KeyPath<K extends string | number> = K extends number ? `${K}` | `[${K}]` : K;
type Paths<T, D extends ReadonlyArray<unknown> = []> = D['length'] extends 8
    ? never
    : T extends Atomic
      ? never
      : T extends ReadonlyArray<infer I>
        ?
              | `${number}`
              | `[${number}]`
              | NestedPaths<`${number}`, I, [...D, 0]>
              | NestedPaths<`[${number}]`, I, [...D, 0]>
        : {
              [K in keyof T & (string | number)]: KeyPath<K> | NestedPaths<KeyPath<K>, NonNullable<T[K]>, [...D, 0]>;
          }[keyof T & (string | number)];
export type FieldPath<T> = Paths<T>;
type IndexKey<K extends string> = K extends `0${infer Rest}` ? (Rest extends '' ? '0' : IndexKey<Rest>) : K;
type ObjectKey<T, K extends string> = K extends keyof T
    ? K
    : K extends `${infer N extends number}`
      ? `${N}` extends K
          ? N extends keyof T
              ? N
              : never
          : never
      : never;
type SegmentValue<T, K extends string> = T extends null | undefined
    ? never
    : T extends ReadonlyArray<infer I>
      ? K extends `${number}`
          ? IndexKey<K> extends keyof T
              ? T[IndexKey<K>]
              : IndexKey<K> extends `${infer Index extends number}`
                ? T[Index]
                : I
          : K extends keyof T
            ? T[K]
            : never
      : T[ObjectKey<T, K> & keyof T];
type ExplicitKeys<T> = keyof {
    [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: unknown;
};
type SegmentRead<T, K extends string> = T extends unknown
    ? [SegmentValue<T, K>] extends [never]
        ? undefined
        : T extends ReadonlyArray<unknown>
          ? IndexKey<K> extends keyof T
              ? SegmentValue<T, K>
              : SegmentValue<T, K> | undefined
          : ObjectKey<T, K> extends ExplicitKeys<T>
            ? SegmentValue<T, K>
            : SegmentValue<T, K> | undefined
    : never;
type DotPath<P extends string> = P extends `${infer A}[${infer I}]${infer Rest}`
    ? DotPath<`${A extends '' ? '' : `${A}.`}${I}${Rest}`>
    : P;
type PathValue<T, P extends string> = P extends `${infer A}.${infer Rest}`
    ? PathValue<SegmentRead<T, A>, Rest>
    : SegmentRead<T, P>;
export type FieldPathValue<T, P extends string> = PathValue<T, DotPath<P>>;
type PathInput<T, P extends string> = P extends `${infer A}.${infer Rest}`
    ? PathInput<SegmentValue<T, A>, Rest>
    : SegmentValue<T, P>;
export type FieldPathInput<T, P extends string> = PathInput<T, DotPath<P>>;
type ArrayItem<T> = T extends ReadonlyArray<infer I> ? I : never;
type IsTuple<T> =
    T extends ReadonlyArray<unknown>
        ? number extends T['length']
            ? Extract<keyof T, `${number}`> extends never
                ? T extends readonly [...ReadonlyArray<unknown>, unknown]
                    ? true
                    : false
                : true
            : true
        : false;
/** Structural helpers operate on dynamic arrays; tuple slots and lengths are fixed by their type. */
type ArrayEditPath<T, P extends string> = [Extract<FieldPathInput<T, P>, ReadonlyArray<unknown>>] extends [never]
    ? never
    : true extends IsTuple<FieldPathInput<T, P>>
      ? never
      : P;

export interface FieldState<TValue = unknown> {
    readonly value: TValue;
    readonly touched: boolean;
    readonly dirty: boolean;
    readonly errors: ReadonlyArray<string>;
}
export type ExecutionState<TSuccess = void, TError = unknown> =
    | { readonly status: 'idle' | 'validating' | 'submitting' }
    | SubmissionResult<TSuccess, TError>;
export interface FormState<TValues extends object, TSuccess = void, TError = unknown> {
    readonly values: TValues;
    readonly baseline: TValues;
    readonly fields: Readonly<Record<string, { readonly touched: boolean }>>;
    readonly errors: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly execution: ExecutionState<TSuccess, TError>;
    readonly progress: UploadProgress | undefined;
    readonly isDirty: boolean;
    readonly submitCount: number;
}
export interface OperationContext {
    readonly signal: AbortSignal;
    readonly onProgress: (progress: UploadProgress) => void;
}
export type FormOperation<TOutput, TSuccess = void, TError = never, TServices = never> = (
    output: TOutput,
    context: OperationContext,
) => Effect.Effect<TSuccess, TError, TServices>;
export type EffectRunner<TServices = never> = <A, E>(
    effect: Effect.Effect<A, E, TServices>,
    options: { readonly signal: AbortSignal },
) => Promise<A>;
interface SessionOptionsBase<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> {
    readonly definition: FormDefinition<
        TValues,
        Readonly<Record<string, FieldDefinition>>,
        Readonly<Record<string, GroupDefinition>>,
        TOutput,
        TSchemaServices
    >;
    readonly defaultValues?: TValues;
    readonly schema?: Schema<TValues, TOutput, TSchemaServices>;
    readonly operation?: FormOperation<TOutput, TSuccess, TError, TServices>;
    readonly driver?: SubmissionDriver;
    readonly binding?: JsonValue;
    readonly onResult?: (result: SubmissionResult<NoInfer<TSuccess>, NoInfer<TError>>) => void;
}
export type SessionOptions<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> = SessionOptionsBase<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> &
    ([TSuccess] extends [ReturnType<() => void>]
        ? [unknown] extends [TError]
            ? { readonly operation?: FormOperation<TOutput, TSuccess, TError, TServices> }
            : { readonly operation: FormOperation<TOutput, TSuccess, TError, TServices> }
        : { readonly operation: FormOperation<TOutput, TSuccess, TError, TServices> }) &
    ([Exclude<TServices | TSchemaServices, Scope.Scope>] extends [never]
        ? { readonly run?: EffectRunner<Exclude<TServices | TSchemaServices, Scope.Scope>> }
        : { readonly run: EffectRunner<Exclude<TServices | TSchemaServices, Scope.Scope>> });
export interface FormSession<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
> {
    readonly getSnapshot: () => FormState<TValues, TSuccess, TError>;
    /** Resolve aliases using this session's draft and encoded container shapes. */
    readonly resolvePath: (path: string) => string;
    readonly subscribe: (listener: () => void) => () => void;
    readonly getField: <P extends FieldPath<TValues>>(path: P) => FieldState<FieldPathValue<TValues, P>>;
    readonly setValue: <P extends FieldPath<TValues>>(path: P, value: FieldPathInput<TValues, P>) => void;
    readonly touch: (path: FieldPath<TValues>) => void;
    readonly append: <P extends FieldPath<TValues>>(
        path: P & ArrayEditPath<TValues, P>,
        value: ArrayItem<FieldPathInput<TValues, P>>,
    ) => void;
    readonly remove: <P extends FieldPath<TValues>>(path: P & ArrayEditPath<TValues, P>, index: number) => void;
    readonly move: <P extends FieldPath<TValues>>(
        path: P & ArrayEditPath<TValues, P>,
        from: number,
        to: number,
    ) => void;
    readonly reset: (values?: TValues) => void;
    readonly submit: () => Promise<SubmissionResult<TSuccess, TError>>;
    /** A lazy waiter on the session-owned execution; interrupting it does not cancel shared work. */
    readonly submitEffect: () => Effect.Effect<SubmissionResult<TSuccess, TError>>;
    readonly cancel: () => void;
    readonly dispose: () => void;
    readonly updateOptions: (
        options: SessionOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>,
    ) => void;
}

function reportObserverError(error: unknown): void {
    if (typeof reportError === 'function') {
        reportError(error);
    }
}
function notifyResult<TSuccess, TError>(
    observer: ((result: SubmissionResult<TSuccess, TError>) => void) | undefined,
    result: SubmissionResult<TSuccess, TError>,
): void {
    try {
        observer?.(result);
    } catch (error) {
        reportObserverError(error);
    }
}
const emptyErrors: ReadonlyArray<string> = Object.freeze([]);

function plain(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    );
}
/** Clone and freeze owned containers; files and other platform objects stay atomic. */
function own<T>(value: T): T {
    if (Array.isArray(value)) {
        return Object.freeze(value.map((item: unknown) => own(item))) as T;
    }
    if (plain(value)) {
        return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, own(item)]))) as T;
    }
    return value;
}
function ownValidationErrors(
    errors: Readonly<Record<string, string | ReadonlyArray<string>>>,
): Readonly<Record<string, string | ReadonlyArray<string>>> {
    return Object.freeze(
        Object.fromEntries(
            Object.entries(errors).map(([path, messages]) => [
                path,
                typeof messages === 'string' ? messages : Object.freeze([...messages]),
            ]),
        ),
    );
}
/** Own the execution envelope and validation messages; domain payloads remain opaque. */
function ownExecution<TSuccess, TError>(execution: ExecutionState<TSuccess, TError>): ExecutionState<TSuccess, TError> {
    const { status } = execution;
    switch (status) {
        case 'success': {
            return Object.freeze('value' in execution ? { status, value: execution.value } : { status });
        }
        case 'invalid': {
            return Object.freeze({ status, errors: ownValidationErrors(execution.errors) });
        }
        case 'failure': {
            return Object.freeze({ status, error: execution.error });
        }
        case 'defect': {
            return Object.freeze({ status, error: execution.error });
        }
        case 'idle':
        case 'validating':
        case 'submitting':
        case 'cancelled': {
            return Object.freeze({ status });
        }
        default: {
            throw new TypeError('Invalid form execution status.');
        }
    }
}
function equal(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i += 1) {
            if (Object.hasOwn(a, i) !== Object.hasOwn(b, i) || !equal(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    if (plain(a) && plain(b)) {
        const keys = Object.keys(a);
        return (
            keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
        );
    }
    return false;
}
// oxlint-disable-next-line eslint/max-params -- Recursive replacement carries the container resolver and its current prefix separately from the value path.
function replace(
    values: unknown,
    segments: ReadonlyArray<string>,
    value: unknown,
    isArray: (prefix: ReadonlyArray<string>) => boolean,
    prefix: ReadonlyArray<string> = [],
): unknown {
    const [head, ...tail] = segments;
    if (head === undefined) {
        // edit owns the replacement before traversing or committing this tree.
        return value;
    }
    if (values === null || values === undefined) {
        // Optional and nullable containers have no existing data to preserve.
        if (isArray(prefix)) {
            if (head !== '0') {
                throw new Error(`Invalid array index: ${head}`);
            }
            return Object.freeze([replace(undefined, tail, value, isArray, [...prefix, head])]);
        }
        return Object.freeze({ [head]: replace(undefined, tail, value, isArray, [...prefix, head]) });
    }
    if (Array.isArray(values)) {
        if (!/^\d+$/u.test(head) || Number(head) >= values.length) {
            throw new Error(`Invalid array index: ${head}`);
        }
        // oxlint-disable-next-line unicorn/prefer-spread -- slice preserves untouched sparse slots; spread fills them with undefined.
        const copy = (values as Array<unknown>).slice();
        copy[Number(head)] = replace(values[Number(head)], tail, value, isArray, [...prefix, head]);
        return Object.freeze(copy);
    }
    if (!plain(values)) {
        throw new Error(`Cannot edit atomic field: ${segments.join('.')}`);
    }
    return Object.freeze({
        ...values,
        [head]: replace(Object.hasOwn(values, head) ? values[head] : undefined, tail, value, isArray, [
            ...prefix,
            head,
        ]),
    });
}
function assertIndex(items: ReadonlyArray<unknown>, index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        throw new Error(`Invalid array index: ${index}`);
    }
}
function overlaps(a: string, b: string): boolean {
    return a === '' || b === '' || a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
const formatIssue = SchemaIssue.makeFormatterDefault();
function issueErrors(issue: SchemaIssue.Issue): Record<string, ReadonlyArray<string>> {
    const errors: Record<string, Array<string>> = {};
    const add = (path: ReadonlyArray<PropertyKey>, message: string) => {
        const key =
            path.length === 0 || path.some((part) => typeof part === 'symbol' || !isPathSegment(String(part)))
                ? ''
                : path.join('.');
        const messages = Object.hasOwn(errors, key) ? errors[key] : undefined;
        errors[key] = [...(messages ?? []), message];
    };
    const visit = (node: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): void => {
        // oxlint-disable-next-line eslint/no-underscore-dangle -- Effect native issues use this discriminator.
        switch (node._tag) {
            case 'Pointer': {
                visit(node.issue, [...path, ...node.path]);
                break;
            }
            case 'Composite': {
                for (const child of node.issues) {
                    visit(child, path);
                }
                break;
            }
            case 'Encoding': {
                visit(node.issue, path);
                break;
            }
            case 'Filter': {
                const message = SchemaIssue.defaultCheckHook(node);
                if (message === undefined) {
                    visit(node.issue, path);
                } else {
                    add(path, message);
                }
                break;
            }
            case 'AnyOf': {
                if (node.issues.length === 0) {
                    add(path, formatIssue(node));
                } else {
                    for (const child of node.issues) {
                        visit(child, path);
                    }
                }
                break;
            }
            case 'Forbidden':
            case 'InvalidType':
            case 'InvalidValue':
            case 'MissingKey':
            case 'OneOf':
            case 'UnexpectedKey': {
                add(path, formatIssue(node));
                break;
            }
            default: {
                throw new TypeError('Unsupported native validation issue.');
            }
        }
    };
    visit(issue, []);
    return errors;
}

interface ActiveSubmission<TSuccess, TError> {
    readonly controller: AbortController;
    readonly scope: Scope.Closeable;
    readonly result: Deferred.Deferred<SubmissionResult<TSuccess, TError>>;
    readonly promise: Promise<SubmissionResult<TSuccess, TError>>;
    readonly onResult: Ref.Ref<((result: SubmissionResult<TSuccess, TError>) => void) | undefined>;
}
function settleSubmission<TSuccess, TError>(
    submission: ActiveSubmission<TSuccess, TError>,
    result: SubmissionResult<TSuccess, TError>,
): void {
    Deferred.doneUnsafe(submission.result, Effect.succeed(result));
}
/** Synchronous owner boundaries close native scopes immediately and run every finalizer. */
function closeScope(scope: Scope.Closeable): void {
    const close = Scope.closeUnsafe(scope, Exit.void);
    if (close !== undefined) {
        Effect.runFork(Effect.uninterruptible(close));
    }
}
const generatedSchemas = new WeakMap<object, EffectSchema.Codec<object>>();
function generatedSchema<TValues extends object>(definition: {
    readonly fields: Readonly<Record<string, FieldDefinition>>;
    readonly defaultValues: TValues;
}): EffectSchema.Codec<TValues> {
    const cached = generatedSchemas.get(definition);
    if (cached !== undefined) {
        return cached as EffectSchema.Codec<TValues>;
    }
    const schema = definitionSchema(definition);
    generatedSchemas.set(definition, schema);
    return schema;
}

function expandSchemaContainers(node: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): ReadonlyArray<SchemaAST.AST> {
    if (seen.has(node)) {
        return [];
    }
    seen.add(node);
    if (SchemaAST.isUnion(node)) {
        return node.types.flatMap((type) => expandSchemaContainers(type, new Set(seen)));
    }
    if (SchemaAST.isSuspend(node)) {
        return expandSchemaContainers(node.thunk(), seen);
    }
    return [node];
}
const indexSignatureMatchers = new WeakMap<SchemaAST.IndexSignature, (key: string) => boolean>();
function matchesIndexSignature(entry: SchemaAST.IndexSignature, key: string): boolean {
    let matches = indexSignatureMatchers.get(entry);
    if (matches === undefined) {
        // A one-key record probe delegates numeric, template and refined key matching to Effect's parser.
        const ast = new SchemaAST.Objects([], [new SchemaAST.IndexSignature(entry.parameter, SchemaAST.unknown)]);
        const schema = EffectSchema.make<EffectSchema.Codec<unknown>>(ast);
        const decode = EffectSchema.decodeUnknownResult(schema, { onExcessProperty: 'error' });
        matches = (segment) => Result.isSuccess(decode({ [segment]: undefined }));
        indexSignatureMatchers.set(entry, matches);
    }
    return matches(key);
}
function schemaContainer(
    ast: SchemaAST.AST,
    path: ReadonlyArray<string>,
    values: unknown,
): 'array' | 'object' | undefined {
    let nodes = expandSchemaContainers(SchemaAST.toEncoded(ast));
    let value = values;
    for (const segment of path) {
        const containerValue = value;
        nodes = nodes.flatMap((node) => {
            if (SchemaAST.isArrays(node) && /^\d+$/u.test(segment)) {
                const index = Number(segment);
                const element = node.elements[index];
                if (element !== undefined) {
                    return expandSchemaContainers(element);
                }
                if (!Array.isArray(containerValue)) {
                    // Missing tuples have no tail position yet; preserve every applicable rest alternative.
                    return node.rest.flatMap((child) => expandSchemaContainers(child));
                }
                const tailLength = Math.max(0, node.rest.length - 1);
                const tailStart = Math.max(node.elements.length, containerValue.length - tailLength);
                const child =
                    tailLength > 0 && index >= tailStart && index < containerValue.length
                        ? node.rest[index - tailStart + 1]
                        : node.rest[0];
                return child === undefined ? [] : expandSchemaContainers(child);
            }
            if (SchemaAST.isObjects(node)) {
                const property = node.propertySignatures.find((entry) => String(entry.name) === segment);
                return property === undefined
                    ? node.indexSignatures.flatMap((entry) =>
                          matchesIndexSignature(entry, segment) ? expandSchemaContainers(entry.type) : [],
                      )
                    : expandSchemaContainers(property.type);
            }
            return [];
        });
        value = getValue(value, segment);
    }
    const arrays = nodes.some((node) => SchemaAST.isArrays(node));
    const objects = nodes.some((node) => SchemaAST.isObjects(node));
    if (arrays === objects) {
        return undefined;
    }
    return arrays ? 'array' : 'object';
}

export function createFormSession<
    TValues extends object,
    TOutput = TValues,
    TSuccess = void,
    TError = unknown,
    TServices = never,
    TSchemaServices = never,
>(
    initialOptions: SessionOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>,
): FormSession<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> {
    const defaults = own(initialOptions.defaultValues ?? initialOptions.definition.defaultValues);
    const initialState: FormState<TValues, TSuccess, TError> = Object.freeze({
        values: defaults,
        baseline: defaults,
        fields: Object.freeze({}),
        errors: Object.freeze({}),
        execution: Object.freeze({ status: 'idle' as const }),
        progress: undefined,
        isDirty: false,
        submitCount: 0,
    });
    const state = AtomRef.make(Equal.byReferenceUnsafe(initialState));
    const scope = Scope.makeUnsafe('parallel');
    const control = Ref.makeUnsafe<{
        readonly options: SessionOptions<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices>;
        readonly disposed: boolean;
        readonly active: ActiveSubmission<TSuccess, TError> | undefined;
        readonly revision: number;
        readonly revisions: ReadonlyMap<string, number>;
    }>({ options: initialOptions, disposed: false, active: undefined, revision: 0, revisions: new Map() });
    const owner = () => Ref.getUnsafe(control);
    const updateOwner = (patch: Partial<ReturnType<typeof owner>>) => {
        Effect.runSync(Ref.update(control, (previous) => ({ ...previous, ...patch })));
    };
    const publish = (patch: Partial<FormState<TValues, TSuccess, TError>>) => {
        const previous = state.value;
        // State snapshots compare by identity; domain payloads and platform objects are opaque to reactivity.
        const snapshot = Object.freeze({
            ...previous,
            ...patch,
            fields: patch.fields === undefined ? previous.fields : own(patch.fields),
            errors: patch.errors === undefined ? previous.errors : own(patch.errors),
            execution: patch.execution === undefined ? previous.execution : ownExecution(patch.execution),
        });
        state.set(Equal.byReferenceUnsafe(snapshot));
    };
    const assertLive = () => {
        if (owner().disposed) {
            throw new Error('Form session is disposed.');
        }
    };
    const isAbsentArray = (prefix: ReadonlyArray<string>): boolean => {
        const { options } = owner();
        const schema = options.schema ?? options.definition.schema;
        if (schema !== undefined) {
            const kind = schemaContainer(schema.ast, prefix, state.value.values);
            if (kind !== undefined) {
                return kind === 'array';
            }
        }
        if (prefix.length > 0 && Array.isArray(getValue(state.value.baseline, prefix.join('.')))) {
            return true;
        }
        return definitionArrayAt(options.definition, prefix);
    };
    const canonicalPath = (path: string) => normalizePath(path, state.value.values, isAbsentArray);
    const edit = (path: string, value: unknown, fields?: FormState<TValues>['fields']) => {
        assertLive();
        pathSegments(path);
        const before = state.value;
        const prepared = own(value);
        if (owner().disposed || state.value !== before) {
            return;
        }
        const key = canonicalPath(path);
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Schema/metadata accessors can dispose or replace state during path preparation.
        if (owner().disposed || state.value !== before) {
            return;
        }
        const values = replace(before.values, pathSegments(key), prepared, isAbsentArray) as TValues;
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Absent-container inference can invoke application schema/metadata accessors while traversing.
        if (owner().disposed || state.value !== before) {
            return;
        }
        if (fields === undefined && equal(values, state.value.values)) {
            return;
        }
        const revision = owner().revision + 1;
        const revisions = new Map([...owner().revisions, [key, revision]]);
        updateOwner({ revision, revisions });
        const errors = Object.fromEntries(Object.entries(state.value.errors).filter(([name]) => !overlaps(key, name)));
        const patch = { values, errors, isDirty: !equal(values, state.value.baseline) };
        if (fields !== undefined) {
            Object.assign(patch, { fields });
        }
        publish(patch);
    };
    const array = (path: string): Array<unknown> => {
        assertLive();
        const values = getValue(state.value.values, canonicalPath(path));
        if (values === null || values === undefined) {
            return [];
        }
        if (!Array.isArray(values)) {
            throw new TypeError(`Field is not an array: ${path}`);
        }
        // oxlint-disable-next-line unicorn/prefer-spread -- Structural edits must preserve sparse slots before remapping indexes.
        return (values as Array<unknown>).slice();
    };
    const structuralEdit = (path: string, items: Array<unknown>, order: ReadonlyArray<number>) => {
        const key = canonicalPath(path);
        const fields: Record<string, { readonly touched: boolean }> = {};
        for (const [name, meta] of Object.entries(state.value.fields)) {
            if (name.startsWith(`${key}.`)) {
                const [row, ...rest] = name.slice(key.length + 1).split('.');
                const next = order.indexOf(Number(row));
                if (next !== -1) {
                    fields[`${key}.${next}${rest.length === 0 ? '' : `.${rest.join('.')}`}`] = meta;
                }
            } else {
                fields[name] = meta;
            }
        }
        edit(path, items, fields);
    };
    const detach = () =>
        Effect.runSync(Ref.modify(control, (previous) => [previous.active, { ...previous, active: undefined }]));
    const interrupt = (current: ActiveSubmission<TSuccess, TError>) => {
        settleSubmission(current, { status: 'cancelled' });
        current.controller.abort();
        closeScope(current.scope);
        if (!owner().disposed) {
            notifyResult(Ref.getUnsafe(current.onResult), { status: 'cancelled' });
        }
    };
    const cancel = () => {
        const current = detach();
        if (current !== undefined) {
            if (!owner().disposed) {
                publish({ execution: { status: 'cancelled' }, progress: undefined });
            }
            interrupt(current);
        }
    };
    const startSubmission = (): ActiveSubmission<TSuccess, TError> => {
        assertLive();
        const existing = owner().active;
        if (existing !== undefined) {
            return existing;
        }
        const submitted = state.value.values;
        const submittedRevision = owner().revision;
        const capturedOptions = owner().options;
        const controller = new AbortController();
        const deferredResult = Deferred.makeUnsafe<SubmissionResult<TSuccess, TError>>();
        const executionScope = Scope.forkUnsafe(scope);
        const current: ActiveSubmission<TSuccess, TError> = {
            controller,
            scope: executionScope,
            result: deferredResult,
            promise: Effect.runPromise(Deferred.await(deferredResult)),
            // oxlint-disable-next-line unicorn/no-useless-undefined -- Native Ref requires its initial callback value.
            onResult: Ref.makeUnsafe<((result: SubmissionResult<TSuccess, TError>) => void) | undefined>(undefined),
        };
        updateOwner({ active: current });
        Effect.runSync(
            Scope.addFinalizer(
                executionScope,
                Effect.sync(() => controller.abort()),
            ),
        );
        const live = () => !owner().disposed && owner().active === current && !controller.signal.aborted;
        const unchanged = (path: string) =>
            ![...owner().revisions].some(([changed, at]) => at > submittedRevision && overlaps(changed, path));
        const filterErrors = (errors: Readonly<Record<string, string | ReadonlyArray<string>>>) => {
            const filtered: Record<string, ReadonlyArray<string>> = {};
            for (const [path, messages] of Object.entries(errors)) {
                const key = path === '' ? '' : canonicalPath(path);
                if (unchanged(key)) {
                    filtered[key] = typeof messages === 'string' ? [messages] : [...messages];
                }
            }
            return filtered;
        };
        const complete = (incoming: SubmissionResult<TSuccess, TError>) => {
            if (!live()) {
                return;
            }
            // oxlint-disable-next-line eslint/init-declarations -- Both preparation branches install a complete result before publication.
            let result: SubmissionResult<TSuccess, TError>;
            let errors: Readonly<Record<string, ReadonlyArray<string>>> = {};
            try {
                // Prepare owned messages before detaching so malformed driver results cannot strand waiters.
                result = ownExecution(incoming) as SubmissionResult<TSuccess, TError>;
                if (result.status === 'invalid') {
                    errors = filterErrors(result.errors);
                }
            } catch (error) {
                result = { status: 'defect', error };
            }
            // Result accessors can synchronously cancel/reset and start a successor while being normalized.
            if (!live()) {
                return;
            }
            const patch: Partial<FormState<TValues, TSuccess, TError>> = { execution: result, progress: undefined };
            if (result.status === 'success') {
                Object.assign(patch, {
                    baseline: submitted,
                    errors: {},
                    isDirty: !equal(state.value.values, submitted),
                });
            }
            if (result.status === 'invalid') {
                Object.assign(patch, { errors });
            }
            if (result.status === 'failure' || result.status === 'defect') {
                Object.assign(patch, { errors: { '': ['Unable to submit the form. Please try again.'] } });
            }
            updateOwner({ active: undefined });
            // Resolve even if a callback or observer fails; application code cannot strand the task.
            publish(patch);
            settleSubmission(current, result);
            notifyResult(Ref.getUnsafe(current.onResult), result);
            closeScope(current.scope);
        };
        // Install the shared task before reading application callbacks so acquisition can safely reenter.
        try {
            const observer = capturedOptions.onResult;
            if (live()) {
                Effect.runSync(Ref.set(current.onResult, observer));
            }
        } catch (error) {
            complete({ status: 'defect', error });
            return current;
        }
        if (!live()) {
            return current;
        }
        publish({
            execution: { status: 'validating' },
            errors: {},
            progress: undefined,
            submitCount: state.value.submitCount + 1,
        });
        const program = Effect.gen(function* program() {
            if (!live()) {
                return { status: 'cancelled' } as const;
            }
            const schema = yield* Effect.sync(
                () =>
                    capturedOptions.schema ??
                    capturedOptions.definition.schema ??
                    generatedSchema(capturedOptions.definition),
            );
            if (!live()) {
                return { status: 'cancelled' } as const;
            }
            const validated = yield* Effect.result(
                EffectSchema.decodeUnknownEffect(schema, { errors: 'all' })(submitted),
            );
            if (!live()) {
                return { status: 'cancelled' } as const;
            }
            if (Result.isFailure(validated)) {
                return { status: 'invalid', errors: issueErrors(validated.failure.issue) } as const;
            }
            yield* Effect.sync(() => publish({ execution: { status: 'submitting' } }));
            if (!live()) {
                return { status: 'cancelled' } as const;
            }
            const context: OperationContext = {
                signal: controller.signal,
                onProgress: (progress) => {
                    if (live()) {
                        const { percentage } = progress;
                        const normalized = Object.freeze({
                            loaded: progress.loaded,
                            total: progress.total,
                            ...(percentage === undefined ? {} : { percentage }),
                        });
                        if (live()) {
                            publish({ progress: normalized });
                        }
                    }
                },
            };
            const execute = capturedOptions.operation;
            if (execute !== undefined) {
                const operation = Effect.suspend(() => execute(validated.success as TOutput, context));
                return yield* Effect.match(operation, {
                    onSuccess: (value) => ({ status: 'success', value }) as SubmissionResult<TSuccess, TError>,
                    onFailure: (error): SubmissionResult<TSuccess, TError> => ({ status: 'failure', error }),
                });
            }
            const { driver } = capturedOptions;
            if (driver !== undefined) {
                const data = validated.success;
                if (typeof data !== 'object' || data === null) {
                    return yield* Effect.die(new Error('Submission drivers require an object schema output.'));
                }
                return yield* Effect.suspend(() =>
                    driver.submit({
                        data,
                        binding: capturedOptions.binding ?? null,
                        ...context,
                    }),
                ) as Effect.Effect<SubmissionResult<TSuccess, TError>>;
            }
            return yield* Effect.die(new Error('No form operation or submission driver configured.'));
        });
        // The session scope owns one native execution fiber. Service runners are boundary adapters only.
        try {
            // A service-requiring SessionOptions must provide run; only service-free calls use the fallback.
            const providedRun = capturedOptions.run as
                | EffectRunner<Exclude<TServices | TSchemaServices, Scope.Scope>>
                | undefined;
            if (live()) {
                let workflow = Effect.scoped(program) as Effect.Effect<SubmissionResult<TSuccess, TError>>;
                if (providedRun !== undefined) {
                    // Runner acquisition is synchronous: a thrown boundary failure is already terminal on return.
                    const running = providedRun(Effect.scoped(program), { signal: controller.signal });
                    workflow = Effect.promise(async () => await running);
                }
                // Yield completion to let all synchronous callers acquire this execution's Deferred.
                const fiber = Fiber.runIn(Effect.runFork(Effect.tap(workflow, () => Effect.yieldNow)), executionScope);
                fiber.addObserver((exit) => {
                    complete(Exit.isSuccess(exit) ? exit.value : { status: 'defect', error: Cause.squash(exit.cause) });
                });
            }
        } catch (error) {
            complete({ status: 'defect', error });
        }
        return current;
    };
    const session: FormSession<TValues, TOutput, TSuccess, TError, TServices, TSchemaServices> = {
        getSnapshot: () => state.value,
        resolvePath: canonicalPath,
        subscribe: (listener) => {
            assertLive();
            const subscriptionScope = Scope.forkUnsafe(scope);
            const unsubscribe = state.subscribe(() => {
                if (!owner().disposed) {
                    try {
                        listener();
                    } catch (error) {
                        reportObserverError(error);
                    }
                }
            });
            Effect.runSync(Scope.addFinalizer(subscriptionScope, Effect.sync(unsubscribe)));
            return () => closeScope(subscriptionScope);
        },
        getField: (path) => {
            const key = canonicalPath(path);
            return {
                value: getValue(state.value.values, key) as FieldPathValue<TValues, typeof path>,
                touched: state.value.fields[key]?.touched ?? false,
                dirty: !equal(getValue(state.value.values, path), getValue(state.value.baseline, path)),
                errors: Object.hasOwn(state.value.errors, key) ? (state.value.errors[key] ?? emptyErrors) : emptyErrors,
            };
        },
        setValue: (path, value) => edit(path, value),
        touch: (path) => {
            assertLive();
            const key = canonicalPath(path);
            if (state.value.fields[key]?.touched !== true) {
                publish({ fields: Object.freeze({ ...state.value.fields, [key]: Object.freeze({ touched: true }) }) });
            }
        },
        append: (path, value) => {
            const items = array(path);
            const order = Array.from({ length: items.length }, (_, i) => i);
            items.push(value);
            order.push(-1);
            structuralEdit(path, items, order);
        },
        remove: (path, i) => {
            const items = array(path);
            assertIndex(items, i);
            const order = Array.from({ length: items.length }, (_, at) => at);
            items.splice(i, 1);
            order.splice(i, 1);
            structuralEdit(path, items, order);
        },
        move: (path, from, to) => {
            const items = array(path);
            assertIndex(items, from);
            assertIndex(items, to);
            if (from === to) {
                return;
            }
            const order = Array.from({ length: items.length }, (_, at) => at);
            const [at] = order.splice(from, 1);
            if (at === undefined) {
                throw new Error(`Invalid array index: ${from}`);
            }
            order.splice(to, 0, at);
            const present = Object.hasOwn(items, from);
            const [item] = items.splice(from, 1);
            items.splice(to, 0, item);
            if (!present) {
                Reflect.deleteProperty(items, to);
            }
            structuralEdit(path, items, order);
        },
        reset: (values) => {
            assertLive();
            const before = state.value;
            const baseline = own(values ?? state.value.baseline);
            if (owner().disposed || state.value !== before) {
                return;
            }
            const interrupted = detach();
            updateOwner({ revisions: new Map() });
            publish({
                values: baseline,
                baseline,
                fields: {},
                errors: {},
                execution: { status: 'idle' },
                progress: undefined,
                isDirty: false,
                submitCount: 0,
            });
            if (interrupted !== undefined) {
                interrupt(interrupted);
            }
        },
        cancel,
        dispose: () => {
            if (owner().disposed) {
                return;
            }
            updateOwner({ disposed: true });
            const interrupted = detach();
            if (interrupted !== undefined) {
                interrupt(interrupted);
            }
            closeScope(scope);
        },
        updateOptions: (next) => {
            assertLive();
            updateOwner({ options: next });
        },
        // Promise identity is part of duplicate-submit coalescing.
        // oxlint-disable-next-line typescript/promise-function-async
        submit: () => startSubmission().promise,
        submitEffect: () =>
            Effect.flatMap(Effect.sync(startSubmission), (submission) => Deferred.await(submission.result)),
    };
    return session;
}
