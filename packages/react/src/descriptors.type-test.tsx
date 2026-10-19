/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema and Context constructors. */
import type {
    FormDefinition,
    FormDescriptor,
    SubmissionCallback,
    SubmissionResult,
    FormDescriptorData,
} from '@formbraid/core';
import { Context, Effect, Schema, SchemaGetter } from 'effect';
import { createFormbraid } from './create-formbraid.js';
import type { FieldProps } from './types.js';

interface Values {
    readonly title: string;
}
const defaults: Values = { title: '' };
function TextField(_props: FieldProps<string> & { readonly placeholder?: string }) {
    return null;
}
const definition = {
    id: 'Todo.update',
    defaultValues: defaults,
    fields: {
        title: {
            name: 'title',
            type: 'string',
            component: 'TextField',
            label: 'Title',
            props: {},
            constraints: {},
            nullable: false,
            serverRules: [],
        },
    },
    groups: {},
} as const satisfies FormDefinition<Values>;
const runtime = createFormbraid({ fieldComponents: { TextField }, formComponents: {} });
const callback: SubmissionCallback<Values, number, 'offline'> = (values) => ({
    status: 'success',
    value: values.title.length,
});
const descriptor = {
    version: 1,
    definition,
    defaultValues: { title: 'Todo' },
    submission: { submit: callback },
} satisfies FormDescriptor<Values, typeof definition.fields, typeof definition.groups, Values, number, 'offline'>;

export function DescriptorTypeProof() {
    const instance = runtime.useForm(descriptor);
    const result: Promise<SubmissionResult<number, 'offline'>> = instance.form.handleSubmit();
    // @ts-expect-error Producer success payloads must survive React inference.
    const lostSuccess: Promise<SubmissionResult<string, 'offline'>> = instance.form.handleSubmit();
    // @ts-expect-error Descriptor fields retain the writable value type.
    instance.form.setFieldValue('title', 42);
    const rendered = (
        <runtime.Form
            form={descriptor}
            onResult={(outcome) => {
                if (outcome.status === 'success') {
                    const saved: number = outcome.value;
                    // @ts-expect-error Form callbacks retain the producer's success type.
                    const wrong: string = outcome.value;
                    void [saved, wrong];
                }
                if (outcome.status === 'failure') {
                    const failure: 'offline' = outcome.error;
                    void failure;
                }
            }}
        >
            {({ fields }) => {
                // @ts-expect-error Bound components retain their application prop types.
                const invalid = <fields.title placeholder={42} />;
                // @ts-expect-error Descriptor field keys remain literal.
                void fields.absent;
                void invalid;
                return <fields.title placeholder="Title" />;
            }}
        </runtime.Form>
    );
    void [result, lostSuccess, rendered];
    return <runtime.Form form={instance} />;
}

const invalidDefaults: FormDescriptor<Values> = {
    version: 1,
    definition,
    // @ts-expect-error Defaults match the editable draft.
    defaultValues: { title: 42 },
    submission: { driver: 'http', binding: {} },
};
const ambiguous: FormDescriptor<Values> = {
    version: 1,
    definition,
    // @ts-expect-error Driver and callback submissions are mutually exclusive, including structural objects.
    submission: { driver: 'http', binding: {}, submit: () => ({ status: 'success' }) },
};
const invalidCallback: FormDescriptor<Values> = {
    version: 1,
    definition,
    // @ts-expect-error Callbacks receive the definition's output.
    submission: { submit: (_values: { title: number }) => ({ status: 'success' }) },
};
const noOutcome: FormDescriptor<Values> = {
    version: 1,
    definition,
    submission: {
        // @ts-expect-error A resolved Promise<void> cannot report server acceptance or validation errors.
        submit: async () => {
            await Promise.resolve();
        },
    },
};
const portableDefinition = { ...definition, defaultValues: { title: '' } };
const portable: FormDescriptorData = {
    version: 1,
    definition: portableDefinition,
    submission: { driver: 'http', binding: {} },
};
const notPortable: FormDescriptorData = {
    version: 1,
    definition: portableDefinition,
    // @ts-expect-error Runtime callbacks cannot be serialized as descriptor data.
    submission: { submit: () => ({ status: 'success' }) },
};
void [invalidDefaults, ambiguous, invalidCallback, noOutcome, portable, notPortable];

class Decode extends Context.Service<Decode, { readonly prefix: string }>()('descriptor/Decode') {}
const decodeTitle = SchemaGetter.transformEffect((value: string) =>
    Decode.pipe(Effect.map((service) => service.prefix + value)),
);
const encodeTitle = SchemaGetter.passthrough<string>();
const titleSchema = Schema.String.pipe(Schema.decode({ decode: decodeTitle, encode: encodeTitle }));
const serviceDefinition = { ...definition, schema: Schema.Struct({ title: titleSchema }) };

const serviceDescriptor = { version: 1 as const, definition: serviceDefinition, submission: { submit: callback } };
export function DescriptorServicesTypeProof() {
    // @ts-expect-error Descriptors retain decoder service requirements.
    runtime.useForm(serviceDescriptor);
    // @ts-expect-error Form rendering cannot omit a required decoder runner.
    const invalid = <runtime.Form form={serviceDescriptor} />;
    const instance = runtime.useForm(serviceDescriptor, {
        run: Effect.runPromiseWith(Context.make(Decode, { prefix: 'decoded:' })),
    });
    void invalid;
    return <runtime.Form form={instance} />;
}
