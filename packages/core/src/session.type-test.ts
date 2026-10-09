import { Context, Effect, Schema } from 'effect';
import { createFormSession, defineForm } from './index.js';
import type { FieldPath, FieldPathValue, FieldPathInput, SubmissionResult } from './index.js';

const definition = defineForm<{ name: string; age: number; rows: Array<{ active: boolean }> }>()({
    id: 'types',
    defaultValues: { name: '', age: 0, rows: [] },
    fields: {},
    groups: {},
});
const session = createFormSession({ definition, operation: () => Effect.succeed({ id: 42 }) });
session.setValue('age', 1);
session.setValue('rows[0].active', true);
// @ts-expect-error Field paths must exist.
session.setValue('absent', 'bad');
// @ts-expect-error Field values retain their types.
session.setValue('age', 'bad');
// @ts-expect-error Array elements retain their types.
session.append('rows', { active: 'bad' });
const result: Promise<SubmissionResult<{ id: number }, never>> = session.submit();
const path: FieldPath<typeof definition.defaultValues> = 'rows.0.active';
const active: FieldPathValue<typeof definition.defaultValues, 'rows.0.active'> = true;
// oxlint-disable-next-line eslint/new-cap -- Effect's service key is a factory.
const Service = Context.Service<{ save: (name: string) => Effect.Effect<number, 'offline'> }>('type-test/Save');
const operation = (data: typeof definition.defaultValues) =>
    Service.pipe(Effect.flatMap((service) => service.save(data.name)));
// @ts-expect-error An operation with services requires a runner providing those services.
createFormSession({ definition, operation });
const provided = createFormSession({
    definition,
    operation,
    run: Effect.runPromiseWith(Context.make(Service, { save: () => Effect.succeed(42) })),
});
const typed: Promise<SubmissionResult<number, 'offline'>> = provided.submit();
void [result, path, active, typed];

// @ts-expect-error A transformed output requires a schema to decode it.
defineForm<{ age: string }, { age: number }>()({
    id: 'missing-decoder',
    defaultValues: { age: '' },
    fields: {},
    groups: {},
});
// @ts-expect-error Operations receive the schema output, not unrelated input.
createFormSession({ definition, operation: (data: { age: string }) => Effect.succeed(data.age) });

const nestedDefinition = defineForm<{
    rows: Array<{ children: Array<{ name: string }> }>;
    matrix: Array<Array<number>>;
}>()({
    id: 'nested-arrays',
    defaultValues: { rows: [{ children: [{ name: '' }] }], matrix: [[1]] },
    fields: {},
    groups: {},
});
const nested = createFormSession({ definition: nestedDefinition, operation: () => Effect.void });
nested.setValue('rows.0.children[0].name', 'mixed');
nested.setValue('matrix[0][0]', 2);
nested.setValue('matrix.0.0', 3);
// @ts-expect-error Mixed paths retain leaf types.
nested.setValue('rows.0.children[0].name', 42);
// @ts-expect-error Nested arrays retain numeric item types.
nested.setValue('matrix[0][0]', 'bad');
// @ts-expect-error Arrays do not expose methods as editable paths.
nested.setValue('matrix.map', () => []);
const value: FieldPathValue<typeof nestedDefinition.defaultValues, 'rows.0.children[0].name'> = 'name';
const numeric: FieldPathValue<typeof nestedDefinition.defaultValues, 'matrix[0][0]'> = 1;
void [value, numeric];

const nullableDefinition = defineForm<{ rows: Array<{ name: string }> | null }>()({
    id: 'nullable-array',
    defaultValues: { rows: null },
    fields: {},
    groups: {},
});
const nullable = createFormSession({ definition: nullableDefinition, operation: () => Effect.void });
nullable.append('rows', { name: 'added' });
// @ts-expect-error Nullable array items retain leaf types.
nullable.append('rows', { name: 42 });

// @ts-expect-error Portable drivers cannot manufacture a typed operation success value.
createFormSession<typeof definition.defaultValues, typeof definition.defaultValues, { id: number }, 'domain'>({
    definition,
    driver: { submit: () => Effect.succeed({ status: 'success' }) },
});
// @ts-expect-error Portable driver failures are unknown unless a typed operation owns them.
createFormSession<typeof definition.defaultValues, typeof definition.defaultValues, ReturnType<() => void>, 'domain'>({
    definition,
    driver: { submit: () => Effect.succeed({ status: 'success' }) },
});
createFormSession({
    definition,
    driver: { submit: () => Effect.succeed({ status: 'success' }) },
    // @ts-expect-error Result callbacks cannot invent typed operation results.
    onResult: (callbackResult: SubmissionResult<{ id: number }>) => {
        void callbackResult;
    },
});

// oxlint-disable-next-line eslint/new-cap -- Effect service keys are factories.
const Validator = Context.Service<{ validation: string }>('type-test/Validator');
// oxlint-disable-next-line eslint/new-cap -- Native schema factories are called without new.
const inputSchema = Schema.Struct({ name: Schema.String });
const validationSchema = inputSchema.pipe(Schema.middlewareDecoding((decode) => Effect.andThen(Validator, decode)));
const validationDefinition = defineForm<{ name: string }>()({
    id: 'decoder-service',
    defaultValues: { name: '' },
    fields: {},
    groups: {},
    schema: validationSchema,
});
const retainedServices: NonNullable<typeof validationDefinition.schema>['DecodingServices'] = {
    validation: 'retained',
};
// @ts-expect-error A service-requiring native decoder requires a supplied runner even without an operation.
createFormSession({
    definition: validationDefinition,
    driver: { submit: () => Effect.succeed({ status: 'success' }) },
});
// @ts-expect-error A decoder service requirement also survives direct schema overrides.
createFormSession({
    definition: defineForm<{ name: string }>()({ id: 'override', defaultValues: { name: '' }, fields: {}, groups: {} }),
    schema: validationSchema,
    operation: () => Effect.void,
});
const schemaProvided = createFormSession({
    definition: validationDefinition,
    operation: () => Effect.void,
    run: Effect.runPromiseWith(Context.make(Validator, { validation: 'provided' })),
});
const combinedOperation = (data: { name: string }) =>
    Service.pipe(Effect.flatMap((service) => service.save(data.name)));
createFormSession({
    definition: validationDefinition,
    operation: combinedOperation,
    // @ts-expect-error An operation-only context cannot satisfy decoder services.
    run: Effect.runPromiseWith(Context.make(Service, { save: () => Effect.succeed(42) })),
});
createFormSession({
    definition: validationDefinition,
    operation: combinedOperation,
    // @ts-expect-error A decoder-only context cannot satisfy operation services.
    run: Effect.runPromiseWith(Context.make(Validator, { validation: 'provided' })),
});
const both = Context.make(Validator, { validation: 'provided' }).pipe(
    Context.add(Service, { save: () => Effect.succeed(42) }),
);
const combined = createFormSession({
    definition: validationDefinition,
    operation: combinedOperation,
    run: Effect.runPromiseWith(both),
});
const combinedResult: Promise<SubmissionResult<number, 'offline'>> = combined.submit();
void [retainedServices, schemaProvided, combinedResult];

const nativeTyped: Effect.Effect<SubmissionResult<number, 'offline'>> = combined.submitEffect();
// @ts-expect-error Native waiter result types cannot invent an operation payload.
const incompatibleNative: Effect.Effect<SubmissionResult<string, 'offline'>> = combined.submitEffect();
void [nativeTyped, incompatibleNative];

const absentDefinition = defineForm<{
    billing: { city: string } | null;
    shipping?: { city: string };
    optionalLeaf: { city?: string } | null;
}>()({ id: 'absent-ancestors', defaultValues: { billing: null, optionalLeaf: null }, fields: {}, groups: {} });
const absent = createFormSession({ definition: absentDefinition, operation: () => Effect.void });
const city: string | undefined = absent.getField('billing.city').value;
const shipping: string | undefined = absent.getField('shipping.city').value;
// @ts-expect-error A nullable ancestor means a nested read may be absent.
const unsafeCity: string = absent.getField('billing.city').value;
// @ts-expect-error An optional ancestor means a nested read may be absent.
const unsafeShipping: string = absent.getField('shipping.city').value;
absent.setValue('billing.city', 'Boston');
// @ts-expect-error Missing ancestors do not make a required leaf accept undefined writes.
absent.setValue('billing.city', undefined);
absent.setValue('optionalLeaf.city', undefined);
const input: FieldPathInput<typeof absentDefinition.defaultValues, 'billing.city'> = 'Boston';
const read: FieldPathValue<typeof absentDefinition.defaultValues, 'billing.city'> = undefined;
void [city, shipping, unsafeCity, unsafeShipping, input, read];

interface UnionValues {
    codes: Array<string> | Record<string, string>;
    address: { city: string; kind: 'billing' } | { city: string; kind: 'shipping'; zip: number };
}
const unionDefinition = defineForm<UnionValues>()({
    id: 'union-paths',
    defaultValues: { codes: { '01': 'literal' }, address: { city: 'Boston', kind: 'billing' } },
    fields: {},
    groups: {},
});
const union = createFormSession({ definition: unionDefinition, operation: () => Effect.void });
const unionRead: string | undefined = union.getField('codes[01]').value;
const commonRead: string = union.getField('address.city').value;
const branchRead: number | undefined = union.getField('address.zip').value;
union.setValue('codes[01]', 'edited');
union.setValue('address.zip', 42);
// @ts-expect-error Missing union branches do not permit undefined writes to required leaves.
union.setValue('address.zip', undefined);
// @ts-expect-error Some union branches lack the leaf, so the read may be absent.
const unsafeBranch: number = union.getField('address.zip').value;
// @ts-expect-error Every supported numeric key branch requires a string input.
union.setValue('codes[01]', 42);
void [unionRead, commonRead, branchRead, unsafeBranch];

const indexedDefinition = defineForm<{
    rows: Array<{ name: string }>;
    codes: Record<string, { name: string }>;
    finite: Record<'first' | 'second', string>;
    explicit: { fixed: string; [key: string]: string };
    tuple: readonly [{ name: string }, number?];
}>()({
    id: 'indexed-reads',
    defaultValues: {
        rows: [],
        codes: {},
        finite: { first: '', second: '' },
        explicit: { fixed: '' },
        tuple: [{ name: '' }],
    },
    fields: {},
    groups: {},
});
const indexed = createFormSession({ definition: indexedDefinition, operation: () => Effect.void });
const arrayName: string | undefined = indexed.getField('rows.0.name').value;
const recordName: string | undefined = indexed.getField('codes.missing.name').value;
// @ts-expect-error A dynamic array index may be absent even below a required array container.
const unsafeArrayName: string = indexed.getField('rows.0.name').value;
// @ts-expect-error A broad record key may be absent even below a required record container.
const unsafeRecordName: string = indexed.getField('codes.missing.name').value;
const finite: string = indexed.getField('finite.first').value;
const explicit: string = indexed.getField('explicit.fixed').value;
const tupleName: string = indexed.getField('tuple[00].name').value;
const optionalTuple: number | undefined = indexed.getField('tuple[01]').value;
indexed.setValue('rows.0.name', 'required input');
indexed.setValue('codes.missing.name', 'required input');
// @ts-expect-error Possibly missing array reads do not relax required writes.
indexed.setValue('rows.0.name', undefined);
// @ts-expect-error Padded concrete tuple indexes retain their exact input types.
indexed.setValue('tuple[00]', 42);
const rootDefinition = defineForm<readonly [string, number]>()({
    id: 'root-tuple',
    defaultValues: ['', 0],
    fields: {},
    groups: {},
    // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
    schema: Schema.Tuple([Schema.String, Schema.Number]),
});
const root = createFormSession({ definition: rootDefinition, operation: () => Effect.void });
const rootRead: string = root.getField('[00]').value;
root.setValue('[00]', 'edited');
root.setValue('[01]', 42);
// @ts-expect-error Root bracket paths retain the concrete tuple slot type.
root.setValue('[00]', 42);
const scalarArrayDefinition = defineForm<ReadonlyArray<string>>()({
    id: 'root-scalar-array',
    defaultValues: [''],
    fields: {},
    groups: {},
    // oxlint-disable-next-line eslint/new-cap -- Effect schemas are native factory functions.
    schema: Schema.Array(Schema.String),
});
const scalarArray = createFormSession({ definition: scalarArrayDefinition, operation: () => Effect.void });
const scalarRead: string | undefined = scalarArray.getField('[0]').value;
scalarArray.setValue('[0]', 'edited');
// @ts-expect-error A possibly missing dynamic root index does not accept non-string writes.
scalarArray.setValue('[0]', 42);
union.append('codes', 'array item');
// @ts-expect-error A non-array union branch does not manufacture additional item types.
union.append('codes', 42);
void [
    arrayName,
    recordName,
    unsafeArrayName,
    unsafeRecordName,
    finite,
    explicit,
    tupleName,
    optionalTuple,
    rootRead,
    scalarRead,
];

const variadicDefinition = defineForm<{ tuple: readonly [string, ...Array<number>] }>()({
    id: 'variadic-tuple',
    defaultValues: { tuple: ['Head', 42] },
    fields: {},
    groups: {},
});
const variadic = createFormSession({ definition: variadicDefinition, operation: () => Effect.void });
const head: string = variadic.getField('tuple[00]').value;
const rest: number | undefined = variadic.getField('tuple[01]').value;
variadic.setValue('tuple[01]', 43);
// @ts-expect-error A variadic tuple rest slot retains its number input, independently of the string head.
variadic.setValue('tuple[01]', 'bad');
// @ts-expect-error A variadic rest read can be absent.
const unsafeRest: number = variadic.getField('tuple[01]').value;
// @ts-expect-error Read absence does not permit undefined writes to required rest elements.
variadic.setValue('tuple[01]', undefined);
void [head, rest, unsafeRest];

const numericDefinition = defineForm<{
    codes: { 0: { name: string }; '01': string };
    dynamic: Record<number, string>;
}>()({
    id: 'numeric-object-types',
    defaultValues: { codes: { 0: { name: 'zero' }, '01': 'literal' }, dynamic: {} },
    fields: {},
    groups: {},
});
const numericObjects = createFormSession({ definition: numericDefinition, operation: () => Effect.void });
const numericName: string = numericObjects.getField('codes.0.name').value;
const numericBracketName: string = numericObjects.getField('codes[0].name').value;
const dynamicNumber: string | undefined = numericObjects.getField('dynamic[0]').value;
numericObjects.setValue('codes.0.name', 'edited');
numericObjects.setValue('dynamic.0', 'added');
numericObjects.setValue('codes.01', 'literal edit');
// @ts-expect-error Numeric object keys retain their leaf types.
numericObjects.setValue('codes[0].name', 42);
// @ts-expect-error Numeric records retain required string writes.
numericObjects.setValue('dynamic[0]', undefined);
// @ts-expect-error A dynamic numeric record read may be absent.
const unsafeDynamicNumber: string = numericObjects.getField('dynamic.0').value;
void [numericName, numericBracketName, dynamicNumber, unsafeDynamicNumber];

const structuralDefinition = defineForm<{
    fixed: readonly [string, number];
    optional: readonly [string, number?];
    leading: readonly [string, ...Array<number>];
    trailing: readonly [...Array<number>, string];
    ambiguous: Array<string> | readonly [string, number];
    dynamic: Array<string>;
    empty: Array<never>;
}>()({
    id: 'structural-tuple-types',
    defaultValues: {
        fixed: ['head', 42],
        optional: ['head'],
        leading: ['head'],
        trailing: ['tail'],
        ambiguous: [],
        dynamic: [],
        empty: [],
    },
    fields: {},
    groups: {},
});
const structural = createFormSession({ definition: structuralDefinition, operation: () => Effect.void });
// @ts-expect-error Reordering a fixed tuple would invalidate its slot types.
structural.move('fixed', 0, 1);
// @ts-expect-error Removing optional tuple elements can shift required slot types.
structural.remove('optional', 0);
// @ts-expect-error Appending to a fixed tuple invalidates its declared length.
structural.append('fixed', 'extra');
// @ts-expect-error Variadic tuples still have fixed prefix slots.
structural.move('leading', 0, 1);
// @ts-expect-error Removing variadic tuple elements can remove a required suffix.
structural.remove('trailing', 0);
// @ts-expect-error Appending after a variadic tuple suffix invalidates its type.
structural.append('trailing', 42);
// @ts-expect-error A union that may contain a tuple cannot be structurally edited.
structural.move('ambiguous', 0, 1);
// @ts-expect-error Non-array containers have no structural array API.
numericObjects.remove('codes', 0);
structural.append('dynamic', 'valid');
structural.move('dynamic', 0, 1);
structural.remove('dynamic', 0);
structural.remove('empty', 0);
structural.setValue('fixed[0]', 'safe slot edit');

const collectionDefinition = defineForm<{
    tags: ReadonlySet<string>;
    counts: ReadonlyMap<string, number>;
    mutableTags: Set<string>;
    mutableCounts: Map<string, number>;
    rows: Array<{ tags: ReadonlySet<string> }>;
}>()({
    id: 'atomic-collection-types',
    defaultValues: {
        tags: new Set(['one']),
        counts: new Map([['one', 1]]),
        mutableTags: new Set(['one']),
        mutableCounts: new Map([['one', 1]]),
        rows: [{ tags: new Set(['one']) }],
    },
    fields: {},
    groups: {},
});
const collections = createFormSession({ definition: collectionDefinition, operation: () => Effect.void });
const collectionTags: ReadonlySet<string> = collections.getField('tags').value;
const collectionCounts: ReadonlyMap<string, number> = collections.getField('counts').value;
collections.setValue('tags', new Set(['two']));
collections.setValue('counts', new Map([['two', 2]]));
collections.setValue('mutableTags', new Set(['two']));
collections.setValue('mutableCounts', new Map([['two', 2]]));
collections.setValue('rows[0].tags', new Set(['two']));
// @ts-expect-error Readonly Set members are not editable draft paths.
collections.getField('tags.size');
// @ts-expect-error Readonly Map members are not editable draft paths.
collections.getField('counts.size');
// @ts-expect-error Mutable Set members remain atomic draft values.
collections.getField('mutableTags.size');
// @ts-expect-error Mutable Map members remain atomic draft values.
collections.setValue('mutableCounts.size', 2);
// @ts-expect-error Atomic collection members are excluded below array elements too.
collections.getField('rows[0].tags.size');
// @ts-expect-error A collection does not expose structural array helpers.
collections.append('tags', 'three');
// @ts-expect-error Whole collection replacements retain their element type.
collections.setValue('counts', new Map([['two', 'bad']]));
void [collectionTags, collectionCounts];

const scopedOperation = () => Effect.acquireRelease(Effect.succeed(42), () => Effect.void);
const scopedSession = createFormSession({ definition, operation: scopedOperation });
const scopedResult: Promise<SubmissionResult<number, never>> = scopedSession.submit();
const scopedServiceOperation = () =>
    Effect.andThen(scopedOperation(), Service.pipe(Effect.flatMap((save) => save.save('scoped'))));
// @ts-expect-error Session-owned Scope does not supply application operation services.
createFormSession({ definition, operation: scopedServiceOperation });
const scopedProvided = createFormSession({
    definition,
    operation: scopedServiceOperation,
    run: Effect.runPromiseWith(Context.make(Service, { save: () => Effect.succeed(42) })),
});
const scopedTyped: Promise<SubmissionResult<number, 'offline'>> = scopedProvided.submit();
void [scopedResult, scopedTyped];
