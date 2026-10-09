/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema and Context constructors. */
/* oxlint-disable unicorn/no-array-method-this-argument -- The reusable group render property is a React renderer. */
import { Form } from '@fieldwork/example/forms.js';
import { update } from '@fieldwork/example/generated/actions/profile.js';
import { Context, Effect, Schema as EffectSchema, SchemaGetter } from 'effect';
import { bindForm, defineForm } from '@fieldwork/core';
import type { SubmissionResult } from '@fieldwork/core';
import { createFieldwork } from './create-fieldwork.js';
import { withFieldGroup } from './group.js';
import type { FieldProps } from './types.js';

const runtime = createFieldwork({ fieldComponents: {}, formComponents: {} });
const typedDefinition = defineForm<{ count: string }, { count: number }>()({
    id: 'typed-react',
    defaultValues: { count: '0' },
    fields: {},
    groups: {},
    schema: EffectSchema.Struct({ count: EffectSchema.NumberFromString }),
});
const repeatedDefinition = defineForm<{ rows: Array<{ active: boolean }> | null }>()({
    id: 'rows',
    defaultValues: { rows: null },
    fields: {},
    groups: {},
});
const dynamicArrayDefinition = defineForm<{ rows: Array<{ active: boolean }> }>()({
    id: 'dynamic-array',
    defaultValues: { rows: [] },
    fields: {},
    groups: {},
});
const unionArrayDefinition = defineForm<{ rows: Array<string> | Array<number> | null }>()({
    id: 'union-array',
    defaultValues: { rows: [] },
    fields: {},
    groups: {},
});
const dynamicRecordDefinition = defineForm<{ codes: Record<string, string> }>()({
    id: 'dynamic-record',
    defaultValues: { codes: {} },
    fields: {},
    groups: {},
});
const Save = Context.Service<{ save: (count: number) => Effect.Effect<string, 'offline'> }>('react/Save');
const Decode = Context.Service<{ prefix: string }>('react/Decode');
const decodeValue = SchemaGetter.transformEffect((value: string) =>
    Effect.map(Decode, (service) => `${service.prefix}${value}`),
);
const encodeValue = SchemaGetter.passthrough<string>();
const serviceSchema = EffectSchema.Struct({
    count: EffectSchema.String.pipe(EffectSchema.decode({ decode: decodeValue, encode: encodeValue })),
});
const serviceDefinition = defineForm<{ count: string }, { count: string }>()({
    id: 'decoder-service',
    defaultValues: { count: '' },
    fields: {},
    groups: {},
    schema: serviceSchema,
});
const boundServiceDefinition = bindForm(serviceDefinition, { driver: 'native', binding: null });
const group = withFieldGroup({ defaultValues: { local: '' }, props: {}, render: () => null });
const numericGroup = withFieldGroup({
    defaultValues: { 0: '' },
    props: {},
    render: ({ group: current }) => {
        const value: string = current.getFieldValue('0');
        current.setFieldValue('0', 'numeric slot');
        // @ts-expect-error Numeric local slots preserve their declared value type.
        current.setFieldValue('0', 42);
        return <current.Field name="0">{(slot) => slot.value || value}</current.Field>;
    },
});
const optionalGroup = withFieldGroup<{ local: string | undefined }, object>({
    defaultValues: { local: undefined },
    props: {},
    render: () => null,
});
const nullableParent = defineForm<{ billing: { city: string; optional?: string } | null }>()({
    id: 'nullable-parent',
    defaultValues: { billing: null },
    fields: {},
    groups: {},
});
const nestedField = (name: string) => ({
    name,
    type: 'string' as const,
    component: 'Input' as const,
    label: name,
    props: {},
    constraints: {},
    nullable: false,
    serverRules: [],
});
function NestedInput(_props: FieldProps<string> & { readonly placeholder?: string }) {
    return null;
}
function NestedParent(_props: FieldProps<object>) {
    return null;
}
const nestedRuntime = createFieldwork({
    fieldComponents: { Input: NestedInput, Parent: NestedParent },
    formComponents: {},
});
const nestedDefinition = defineForm<{
    value: { name: string; length: string; displayName: string };
    rows: Array<{ active: string }>;
}>()({
    id: 'nested-bindings',
    defaultValues: { value: { name: '', length: '', displayName: '' }, rows: [{ active: '' }] },
    fields: {
        value: { ...nestedField('value'), type: 'object', component: 'Parent' },
        'value.name': nestedField('value.name'),
        'value.length': nestedField('value.length'),
        'value.displayName': nestedField('value.displayName'),
        'rows[0].active': nestedField('rows[0].active'),
    },
    groups: {},
});
const rootArrayDefinition = defineForm<ReadonlyArray<{ readonly name: string }>>()({
    id: 'root-array',
    defaultValues: [{ name: '' }],
    fields: { '[0].name': nestedField('[0].name') },
    groups: {},
    schema: EffectSchema.Array(EffectSchema.Struct({ name: EffectSchema.String })),
});

/** Compile-only proofs for typed paths, decoded operations and supplied Effect services. */
export function SessionTypeProof() {
    const tuple = runtime.useForm(
        defineForm<{ tuple: readonly [string, number]; codes: { 0: string } }>()({
            id: 'react-tuple-types',
            defaultValues: { tuple: ['head', 42], codes: { 0: 'zero' } },
            fields: {},
            groups: {},
        }),
    );
    tuple.form.setFieldValue('tuple[0]', 'slot edit');
    tuple.form.setFieldValue('codes[0]', 'numeric edit');
    const numericValue: string = tuple.form.getFieldValue('codes.0');
    const NumericGroup = numericGroup;
    const mappedNumericGroup = <NumericGroup form={tuple.form} fields={{ 0: 'codes[0]' }} />;
    // @ts-expect-error Required numeric group slots cannot omit their parent mapping.
    const missingNumericSlot = <NumericGroup form={tuple.form} fields={{}} />;
    // @ts-expect-error Numeric group slots retain compatible parent read and write types.
    const incompatibleNumericSlot = <NumericGroup form={tuple.form} fields={{ 0: 'tuple[1]' }} />;
    void [mappedNumericGroup, missingNumericSlot, incompatibleNumericSlot];
    // @ts-expect-error React structural helpers cannot reorder fixed tuple slots.
    tuple.form.move('tuple', 0, 1);
    // @ts-expect-error React structural helpers cannot remove required tuple slots.
    tuple.form.remove('tuple', 0);
    // @ts-expect-error React structural helpers cannot append beyond a fixed tuple's length.
    tuple.form.append('tuple', 'extra');
    void numericValue;
    const operation = (data: { count: number }) => Effect.flatMap(Save, (service) => service.save(data.count));
    // @ts-expect-error Operations that require services must receive a runner supplying them.
    runtime.useForm(typedDefinition, { operation });
    const instance = runtime.useForm(typedDefinition, {
        operation,
        run: Effect.runPromiseWith(Context.make(Save, { save: () => Effect.succeed('saved') })),
    });
    instance.form.setFieldValue('count', '42');
    const repeated = runtime.useForm(repeatedDefinition);
    repeated.form.setFieldValue('rows[0].active', true);
    repeated.form.append('rows', { active: true });
    const dynamicArray = runtime.useForm(dynamicArrayDefinition);
    // @ts-expect-error Dynamic array elements may be absent, independently of parent nullability.
    const active: boolean = dynamicArray.form.getFieldValue('rows[0].active');
    dynamicArray.form.setFieldValue('rows[0].active', (previous) => !(previous ?? false));
    // @ts-expect-error Missing array elements do not permit writing undefined to a required leaf.
    dynamicArray.form.setFieldValue('rows[0].active', undefined);
    const unionArray = runtime.useForm(unionArrayDefinition);
    unionArray.form.append('rows', 'text');
    unionArray.form.append('rows', 42);
    // @ts-expect-error Union array elements preserve their actual item alternatives.
    unionArray.form.append('rows', false);
    const dynamicRecord = runtime.useForm(dynamicRecordDefinition);
    // @ts-expect-error Broad index signatures may not own an arbitrary key.
    const code: string = dynamicRecord.form.getFieldValue('codes.missing');
    dynamicRecord.form.setFieldValue('codes.missing', (previous) => previous?.toUpperCase() ?? 'Code');
    // @ts-expect-error Missing record keys do not broaden their declared write type.
    dynamicRecord.form.setFieldValue('codes.missing', undefined);
    const RequiredGroup = group;
    // @ts-expect-error A required local slot cannot claim a dynamic parent key is always present.
    const requiredDynamicGroup = <RequiredGroup form={dynamicRecord.form} fields={{ local: 'codes.missing' }} />;
    void [active, code, requiredDynamicGroup];
    const nullable = runtime.useForm(nullableParent);
    // @ts-expect-error A nullable parent can make a required child read undefined.
    const requiredRead: string = nullable.form.getFieldValue('billing.city');
    nullable.form.setFieldValue('billing.city', 'Boston');
    nullable.form.setFieldValue('billing.city', (previous) => previous?.toUpperCase() ?? 'Boston');
    // @ts-expect-error Missing ancestors do not make required children writable as undefined.
    nullable.form.setFieldValue('billing.city', undefined);
    // @ts-expect-error An updater can read undefined but must produce a valid required child.
    nullable.form.setFieldValue('billing.city', (previous) => previous);
    nullable.form.setFieldValue('billing.optional', undefined);
    const OptionalGroup = optionalGroup;
    // @ts-expect-error A broad local slot must not write undefined into a required parent child.
    const nullableGroup = <OptionalGroup form={nullable.form} fields={{ local: 'billing.city' }} />;
    const optionalLeafGroup = <OptionalGroup form={nullable.form} fields={{ local: 'billing.optional' }} />;
    const nullableField = (
        <nullable.form.Field name="billing.city">
            {(current) => {
                // @ts-expect-error Field values preserve absent ancestors in their read type.
                const text: string = current.value;
                current.setValue((previous) => previous?.toUpperCase() ?? 'Boston');
                // @ts-expect-error A Field's input type preserves the required leaf.
                current.setValue(undefined);
                void text;
                return null;
            }}
        </nullable.form.Field>
    );
    void [requiredRead, nullableGroup, optionalLeafGroup, nullableField];
    // @ts-expect-error Draft fields retain their input type independently of decoded output.
    instance.form.setFieldValue('count', 42);
    // @ts-expect-error Unknown paths cannot be edited.
    instance.form.setFieldValue('absent', true);
    // @ts-expect-error Repeated rows retain their element types.
    repeated.form.append('rows', { active: 'bad' });
    const result: Promise<SubmissionResult<string, 'offline'>> = instance.form.handleSubmit();
    // @ts-expect-error Operations consume the decoded schema output.
    runtime.useForm(typedDefinition, { operation: (data: { count: string }) => Effect.succeed(data.count) });
    // @ts-expect-error Native decoder services require a supplying runner even without an operation.
    runtime.useForm(serviceDefinition);
    // @ts-expect-error Native decoder services cannot use empty options without a runner.
    runtime.useForm(serviceDefinition, {});
    const decoderInstance = runtime.useForm(serviceDefinition, {
        run: Effect.runPromiseWith(Context.make(Decode, { prefix: 'decoded:' })),
    });
    // @ts-expect-error A Form definition requires the native decoder's services too.
    const missingDecoderRunner = <runtime.Form form={serviceDefinition}>{() => null}</runtime.Form>;
    runtime.useForm(serviceDefinition, {
        operation: (data) => Effect.flatMap(Save, (service) => service.save(Number(data.count))),
        // @ts-expect-error Supplying operation services alone does not supply the native decoder's services.
        run: Effect.runPromiseWith(Context.make(Save, { save: () => Effect.succeed('saved') })),
    });
    // @ts-expect-error Binding a definition preserves its decoder service requirement.
    runtime.useForm(boundServiceDefinition);
    // @ts-expect-error Bound forms cannot omit the decoder's runner.
    const missingBoundRunner = <runtime.Form form={boundServiceDefinition}>{() => null}</runtime.Form>;
    const boundDecoder = runtime.useForm(boundServiceDefinition, {
        run: Effect.runPromiseWith(Context.make(Decode, { prefix: 'decoded:' })),
    });
    void [decoderInstance, missingDecoderRunner, missingBoundRunner, boundDecoder];
    const Group = group;
    // @ts-expect-error Group slots must map to paths with compatible read and write types.
    const incompatibleGroup = <Group form={repeated.form} fields={{ local: 'rows.0.active' }} />;
    void [result, incompatibleGroup];
    return (
        <runtime.Form form={instance}>{() => <Group form={instance.form} fields={{ local: 'count' }} />}</runtime.Form>
    );
}

/** Bound bracket paths and parent/child intersections match their runtime tree. */
export function NestedBindingTypeProof() {
    return (
        <nestedRuntime.Form form={nestedDefinition}>
            {({ fields }) => {
                const Active = fields.rows[0].active;
                // @ts-expect-error Brackets normalize into nested numeric keys, not a literal root key.
                void fields['rows[0]'];
                // @ts-expect-error Nested component overrides retain their registered prop types.
                const invalid = <fields.value.name placeholder={1} />;
                // @ts-expect-error Only registered numeric elements have a bound component.
                void fields.rows[1];
                // @ts-expect-error A named displayName child is a component, not React's string static.
                void fields.value.displayName.toUpperCase;
                // @ts-expect-error A child binding must not also be assignable to React's string static.
                const displayName: string = fields.value.displayName;
                // @ts-expect-error Named displayName children retain registered component props.
                const invalidDisplayName = <fields.value.displayName placeholder={1} />;
                void invalid;
                void [displayName, invalidDisplayName];
                return (
                    <>
                        <fields.value />
                        <fields.value.name placeholder="Name" />
                        <fields.value.length />
                        <fields.value.displayName placeholder="Display name" />
                        <Active />
                    </>
                );
            }}
        </nestedRuntime.Form>
    );
}

/** Native root-array schemas expose bracket fields under numeric root keys. */
export function RootArrayBindingTypeProof() {
    return (
        <nestedRuntime.Form form={rootArrayDefinition}>
            {({ fields }) => {
                const Name = fields[0].name;
                // @ts-expect-error Root brackets do not create an empty-string tree namespace.
                void fields[''];
                // @ts-expect-error Root bracket fields normalize their keys rather than preserving raw syntax.
                void fields['[0]'];
                return <Name placeholder="Root name" />;
            }}
        </nestedRuntime.Form>
    );
}

/** Compiled by the strict root project; never executed as a runtime test. */
export function BindingTypeProof() {
    // @ts-expect-error Laravel route parameters retain their exact names.
    const wrongRoute = update.form({ usr: 1 });
    // @ts-expect-error Required route parameters cannot be omitted.
    const missingRoute = update.form({});
    void wrongRoute;
    void missingRoute;
    return (
        <Form form={update.form({ user: 1 })}>
            {({ fields, components, groups }) => {
                // @ts-expect-error Unknown fields cannot be rendered.
                const unknownField = <fields.emali />;
                // @ts-expect-error Field props retain the registered component's types.
                const invalidField = <fields.email type="mystery" />;
                // @ts-expect-error Form components retain their own prop types.
                const invalidComponent = <components.SubmitButton label={123} />;
                // @ts-expect-error Bound groups omit the native form and slot bindings.
                const invalidGroup = <groups.address fields={{}} />;
                // @ts-expect-error Group presentation props retain their original types.
                const invalidGroupLabel = <groups.address label={123} />;
                void unknownField;
                void invalidField;
                void invalidComponent;
                void invalidGroup;
                void invalidGroupLabel;
                return (
                    <>
                        <fields.email type="email" />
                        <groups.address label="Address" />
                        <components.SubmitButton label="Save" />
                    </>
                );
            }}
        </Form>
    );
}
