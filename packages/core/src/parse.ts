/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema constructors. */
import { Effect, Schema } from 'effect';
import type { HttpOperation, Extraction, JsonValue, FormDescriptorData } from './contracts.js';

export const JsonValueSchema = Schema.Json;
export const JsonObjectSchema = Schema.JsonObject;
const OptionSchema = Schema.Union([Schema.String, Schema.Finite]);
export const RequiredConditionSchema = Schema.Struct({
    field: Schema.String,
    values: Schema.Array(JsonValueSchema),
    operator: Schema.Literals(['equals', 'notEquals', 'present', 'absent']),
});
export const ConstraintsSchema = Schema.Struct({
    required: Schema.optionalKey(Schema.Boolean),
    requiredWhen: Schema.optionalKey(Schema.Array(RequiredConditionSchema)),
    minLength: Schema.optionalKey(Schema.Finite),
    maxLength: Schema.optionalKey(Schema.Finite),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
    minItems: Schema.optionalKey(Schema.Finite),
    maxItems: Schema.optionalKey(Schema.Finite),
    options: Schema.optionalKey(Schema.Array(OptionSchema)),
    format: Schema.optionalKey(Schema.Literals(['email', 'url', 'date'])),
});
export const FieldDefinitionSchema = Schema.Struct({
    name: Schema.String,
    type: Schema.Literals(['string', 'integer', 'number', 'boolean', 'date', 'enum', 'file', 'array', 'object']),
    component: Schema.String,
    label: Schema.String,
    helpText: Schema.optionalKey(Schema.String),
    props: JsonObjectSchema,
    constraints: ConstraintsSchema,
    nullable: Schema.Boolean,
    serverRules: Schema.Array(Schema.String),
});
export const GroupDefinitionSchema = Schema.Struct({
    component: Schema.String,
    label: Schema.optionalKey(Schema.String),
    helpText: Schema.optionalKey(Schema.String),
    fields: Schema.Record(Schema.String, Schema.String),
    props: JsonObjectSchema,
});
export const FormMetadataSchema = Schema.Struct({
    id: Schema.String,
    defaultValues: JsonObjectSchema,
    fields: Schema.Record(Schema.String, FieldDefinitionSchema),
    groups: Schema.Record(Schema.String, GroupDefinitionSchema),
});
export const ExtractionSchema = Schema.Struct({
    version: Schema.Literal(1),
    forms: Schema.Array(FormMetadataSchema),
    diagnostics: Schema.Array(Schema.String),
}).annotate({ message: 'Invalid or unsupported Fieldwork source export.' });

const HttpMethodSchema = Schema.Literals(['get', 'post', 'put', 'patch', 'delete']);
export const SubmissionTargetSchema = Schema.Struct({ url: Schema.String, method: HttpMethodSchema });
export const SubmissionBindingSchema = Schema.Struct({ driver: Schema.String, binding: JsonValueSchema });
/** Only the serializable named-driver branch crosses a JSON boundary. */
export const FormDescriptorSchema = Schema.Struct({
    version: Schema.Literal(1),
    definition: FormMetadataSchema,
    defaultValues: Schema.optionalKey(JsonObjectSchema),
    submission: SubmissionBindingSchema,
});
export const HttpOperationSchema: Schema.Codec<HttpOperation> = Schema.Struct({
    uri: Schema.String,
    method: HttpMethodSchema,
});
export const OperationParameterSchema = Schema.Struct({
    name: Schema.String,
    optional: Schema.optionalKey(Schema.Boolean),
});

export function operationSchema<S extends Schema.Constraint>(binding: S) {
    return Schema.Struct({
        name: Schema.String,
        schema: Schema.String,
        parameters: Schema.Array(OperationParameterSchema),
        binding,
    });
}

const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);
export const isRecord = Schema.is(RecordSchema);
export const isJsonValue = Schema.is(JsonValueSchema);
const extractionJson = Schema.fromJsonString(ExtractionSchema);
const descriptorJson = Schema.fromJsonString(FormDescriptorSchema);
const jsonValueJson = Schema.fromJsonString(JsonValueSchema);
const decodeOptions = { errors: 'all', onExcessProperty: 'error' } as const;

/** Native decoders retain structured schema failures for Effect workflows. */
export const parseExtractionEffect: (json: string) => Effect.Effect<Extraction, Schema.SchemaError> =
    Schema.decodeUnknownEffect(extractionJson, decodeOptions);
export const parseJsonValueEffect: (json: string) => Effect.Effect<JsonValue, Schema.SchemaError> =
    Schema.decodeUnknownEffect(jsonValueJson, decodeOptions);

export const parseFormDescriptorEffect: (json: string) => Effect.Effect<FormDescriptorData, Schema.SchemaError> =
    Schema.decodeUnknownEffect(descriptorJson, decodeOptions);

export function parseFormDescriptor(json: string): FormDescriptorData {
    return Effect.runSync(parseFormDescriptorEffect(json));
}

/** Synchronous compiler/API boundaries execute the same native decoder. */
export function parseExtraction(json: string): Extraction {
    return Effect.runSync(parseExtractionEffect(json));
}
export function parseJsonValue(json: string): JsonValue {
    return Effect.runSync(parseJsonValueEffect(json));
}
