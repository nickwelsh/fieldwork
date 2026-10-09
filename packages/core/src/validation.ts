import { Effect, Result, Schema, SchemaIssue } from 'effect';
import type { Constraints, FieldDefinition, JsonValue } from './contracts.js';
import { isRecord } from './parse.js';
import { definitionArrayAt, getValue, normalizeSegment, pathSegments } from './paths.js';

function isEmpty(value: unknown): boolean {
    return (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '') ||
        (Array.isArray(value) && value.length === 0) ||
        isEmptyRecord(value)
    );
}

function isEmptyRecord(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    // JSON object records arrive in Laravel as associative arrays; platform objects remain atomic.
    return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

function numericValue(value: string | number): number | bigint | undefined {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? BigInt(value) : value;
    }
    // PHP numeric strings support decimal/scientific notation and ASCII whitespace, but not empty or hexadecimal values.
    if (!/^[\t\n\r\f\v ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\r\f\v ]*$/iu.test(value)) {
        return undefined;
    }
    const text = value.trim();
    if (/^[+-]?\d+$/u.test(text)) {
        return BigInt(text);
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function equivalent(candidate: JsonValue, value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value ? candidate === true || candidate === 'true' : candidate === false || candidate === 'false';
    }
    if (value === null || value === undefined) {
        return candidate === null || (typeof candidate === 'string' && candidate.toLowerCase() === 'null');
    }
    if (
        (typeof candidate === 'string' || typeof candidate === 'number') &&
        (typeof value === 'string' || typeof value === 'number')
    ) {
        const candidateNumber = numericValue(candidate);
        const valueNumber = numericValue(value);
        if (candidateNumber !== undefined && valueNumber !== undefined) {
            return typeof candidateNumber === 'bigint' && typeof valueNumber === 'bigint'
                ? candidateNumber === valueNumber
                : Number(candidateNumber) === Number(valueNumber);
        }
        return String(candidate) === String(value);
    }
    return candidate === value;
}

export function resolveConstraints(constraints: Constraints, values: unknown): Constraints {
    const conditional =
        constraints.requiredWhen?.some((condition) => {
            const value = getValue(values, condition.field);
            switch (condition.operator) {
                case 'present': {
                    return !isEmpty(value);
                }
                case 'absent': {
                    return isEmpty(value);
                }
                case 'equals': {
                    // Laravel required_if ignores absent dependencies; required_unless still compares them with null.
                    return value !== undefined && condition.values.some((candidate) => equivalent(candidate, value));
                }
                case 'notEquals': {
                    return !condition.values.some((candidate) => equivalent(candidate, value));
                }
                default: {
                    return false;
                }
            }
        }) ?? false;
    return { ...constraints, required: constraints.required === true || conditional };
}

function resolveRowConstraints(
    constraints: Constraints,
    values: unknown,
    row: { readonly template: ReadonlyArray<string>; readonly concrete: ReadonlyArray<string | number> },
): Constraints {
    const { template, concrete } = row;
    if (constraints.requiredWhen === undefined || !template.includes('*')) {
        return resolveConstraints(constraints, values);
    }
    // Laravel substitutes dependent-rule asterisks with the current attribute's wildcard keys, in order.
    const keys = template.flatMap((segment, index) => (segment === '*' ? [concrete[index]] : []));
    return resolveConstraints(
        {
            ...constraints,
            requiredWhen: constraints.requiredWhen.map((condition) => {
                let index = 0;
                const field = pathSegments(condition.field)
                    .map((segment) => {
                        if (segment !== '*') {
                            return segment;
                        }
                        const key = keys[index];
                        index += 1;
                        return String(key ?? '*');
                    })
                    .join('.');
                return { ...condition, field };
            }),
        },
        values,
    );
}

type FieldSchema = Schema.Codec<unknown, unknown>;

function codePoints(value: string): number {
    // Laravel string sizes count Unicode code points, rather than UTF-16 code units.
    // oxlint-disable-next-line typescript/no-misused-spread -- Match Laravel code point lengths.
    return [...value].length;
}

function stringSchema(field: FieldDefinition): FieldSchema {
    const { constraints, label } = field;
    let schema = Schema.String.annotate({ message: field.type === 'enum' ? undefined : `${label} must be a string.` });
    if (constraints.minLength !== undefined) {
        const minimum = constraints.minLength;
        schema = schema.check(
            Schema.makeFilter((value) => codePoints(value) >= minimum, {
                message: `${label} must have at least ${minimum} characters.`,
            }),
        );
    }
    if (constraints.maxLength !== undefined) {
        const maximum = constraints.maxLength;
        schema = schema.check(
            Schema.makeFilter((value) => codePoints(value) <= maximum, {
                message: `${label} must have at most ${maximum} characters.`,
            }),
        );
    }
    if (constraints.format === 'email') {
        schema = schema.check(
            Schema.isPattern(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u, {
                message: `${label} must be a valid email address.`,
            }),
        );
    }
    if (constraints.format === 'url') {
        schema = schema.check(
            Schema.makeFilter((value) => URL.canParse(value), {
                message: `${label} must be a valid URL.`,
            }),
        );
    }
    return schema;
}

function numberSchema(field: FieldDefinition): FieldSchema {
    const { constraints, label } = field;
    const message = `${label} must be ${field.type === 'integer' ? 'an integer' : 'a number'}.`;
    let schema = Schema.Number.annotate({ message: field.type === 'enum' ? undefined : message });
    if (field.type === 'integer') {
        schema = schema.check(Schema.isInt({ message }));
    }
    if (field.type === 'number') {
        schema = schema.check(Schema.isFinite({ message }));
    }
    if (constraints.min !== undefined) {
        schema = schema.check(
            Schema.isGreaterThanOrEqualTo(constraints.min, {
                message: `${label} must be at least ${constraints.min}.`,
            }),
        );
    }
    if (constraints.max !== undefined) {
        schema = schema.check(
            Schema.isLessThanOrEqualTo(constraints.max, {
                message: `${label} must be at most ${constraints.max}.`,
            }),
        );
    }
    return schema;
}

function enumSchema(field: FieldDefinition): FieldSchema {
    const strings = Schema.decodeUnknownResult(stringSchema(field), { errors: 'all' });
    const numbers = Schema.decodeUnknownResult(numberSchema(field), { errors: 'all' });
    const arrays = Schema.decodeUnknownResult(arraySchema(field), { errors: 'all' });
    return Schema.Unknown.check(
        Schema.makeFilter((value) => {
            let result: Result.Result<unknown, Schema.SchemaError> | null = null;
            if (typeof value === 'string') {
                result = strings(value);
            } else if (typeof value === 'number') {
                result = numbers(value);
            } else if (Array.isArray(value)) {
                result = arrays(value);
            }
            return result !== null && Result.isFailure(result) ? result.failure.issue : undefined;
        }),
    );
}

function arraySchema(field: FieldDefinition): FieldSchema {
    const { constraints, label } = field;
    let schema = Schema.Array(Schema.Unknown).annotate({
        message: field.type === 'enum' ? undefined : `${label} must be an array.`,
    });
    if (constraints.minItems !== undefined) {
        schema = schema.check(
            Schema.isMinLength(constraints.minItems, {
                message: `${label} must have at least ${constraints.minItems} items.`,
            }),
        );
    }
    if (constraints.maxItems !== undefined) {
        schema = schema.check(
            Schema.isMaxLength(constraints.maxItems, {
                message: `${label} must have at most ${constraints.maxItems} items.`,
            }),
        );
    }
    return schema;
}

function objectSchema(field: FieldDefinition): FieldSchema {
    const { constraints, label } = field;
    let schema = Schema.declare(isRecord, { message: `${label} must be an object.` });
    if (constraints.minItems !== undefined) {
        const minimum = constraints.minItems;
        schema = schema.check(
            Schema.makeFilter((value) => Object.keys(value).length >= minimum, {
                message: `${label} must have at least ${minimum} items.`,
            }),
        );
    }
    if (constraints.maxItems !== undefined) {
        const maximum = constraints.maxItems;
        schema = schema.check(
            Schema.makeFilter((value) => Object.keys(value).length <= maximum, {
                message: `${label} must have at most ${maximum} items.`,
            }),
        );
    }
    return schema;
}

function collectionOption(options: ReadonlyArray<string | number>, value: unknown): boolean {
    return (
        (typeof value === 'string' || typeof value === 'number') &&
        options.some((option) => String(option) === String(value))
    );
}

function matchesOptions(field: FieldDefinition, options: ReadonlyArray<string | number>, value: unknown): boolean {
    if (field.type === 'array' && Array.isArray(value)) {
        return value.every((item: unknown) => collectionOption(options, item));
    }
    if (field.type === 'object' && isRecord(value)) {
        return Object.values(value).every((item: unknown) => collectionOption(options, item));
    }
    return options.some((option) => option === value);
}

function baseSchema(field: FieldDefinition): FieldSchema {
    switch (field.type) {
        case 'string':
        case 'date': {
            return stringSchema(field);
        }
        case 'integer':
        case 'number': {
            return numberSchema(field);
        }
        case 'boolean': {
            return Schema.Boolean.annotate({ message: `${field.label} must be a boolean.` });
        }
        case 'array': {
            return arraySchema(field);
        }
        case 'object': {
            return objectSchema(field);
        }
        case 'file': {
            return Schema.declare<File>(
                (value): value is File => typeof File !== 'undefined' && value instanceof File,
                { message: `${field.label} must be a file.` },
            );
        }
        case 'enum': {
            return enumSchema(field);
        }
        default: {
            throw new Error('Unsupported field type.');
        }
    }
}

function fieldSchema(field: FieldDefinition): FieldSchema {
    const schema = baseSchema(field);
    const { options } = field.constraints;
    return options === undefined
        ? schema
        : schema.check(
              Schema.makeFilter((value) => matchesOptions(field, options, value), {
                  message: `${field.label} must be one of the allowed values.`,
              }),
          );
}

interface ConcreteValue {
    readonly path: ReadonlyArray<string | number>;
    readonly value: unknown;
}

interface ExpansionContext {
    readonly path: ReadonlyArray<string | number>;
    readonly isAbsentArray: (prefix: ReadonlyArray<string>) => boolean;
}

/** Native issue pointers identify each existing wildcard row, including nested arrays. */
function expandValues(
    segments: ReadonlyArray<string>,
    value: unknown,
    context: ExpansionContext,
): ReadonlyArray<ConcreteValue> {
    const { path, isAbsentArray } = context;
    const [head, ...tail] = segments;
    if (head === undefined) {
        return [{ path, value }];
    }
    if (head === '*') {
        return Array.isArray(value)
            ? Array.from({ length: value.length }, (_, index) =>
                  expandValues(tail, Object.hasOwn(value, index) ? value[index] : undefined, {
                      path: [...path, index],
                      isAbsentArray,
                  }),
              ).flat()
            : [];
    }
    const array = Array.isArray(value) || ((value === null || value === undefined) && isAbsentArray(path.map(String)));
    const segment = normalizeSegment(head, array);
    const child =
        typeof value === 'object' && value !== null && Object.hasOwn(value, segment)
            ? (Reflect.get(value, segment) as unknown)
            : undefined;
    const pointer = array && /^\d+$/u.test(segment) ? Number(segment) : segment;
    return expandValues(tail, child, { path: [...path, pointer], isAbsentArray });
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- This guard links the native declaration to the application's draft type.
function isDraft<TValues extends object>(value: unknown): value is TValues {
    return isRecord(value);
}

function checkValue(
    field: FieldDefinition,
    decode: (value: unknown) => Result.Result<unknown, Schema.SchemaError>,
    concrete: ConcreteValue & { readonly required: boolean },
): Schema.FilterIssue | undefined {
    const { value, path, required } = concrete;
    if (required && isEmpty(value)) {
        return { path, issue: `${field.label} is required.` };
    }
    if (
        value === undefined ||
        ((field.nullable || field.type === 'file') && value === null) ||
        (value === '' && !required)
    ) {
        return undefined;
    }
    const result = decode(value);
    return Result.isFailure(result) ? { path, issue: result.failure.issue } : undefined;
}

/** Compile Laravel metadata into native Effect schemas; cross-field rules own the root refinement. */
export function definitionSchema<TValues extends object>(definition: {
    readonly fields: Readonly<Record<string, FieldDefinition>>;
    readonly defaultValues: TValues;
}): Schema.Codec<TValues, TValues> {
    const fields = Object.values(definition.fields).map((field) => ({
        field,
        segments: pathSegments(field.name),
        decode: Schema.decodeUnknownResult(fieldSchema(field), { errors: 'all' }),
    }));
    const isAbsentArray = (prefix: ReadonlyArray<string>): boolean => definitionArrayAt(definition, prefix);
    const draft = Schema.declareConstructor<TValues>()(
        [],
        () => (value, _ast, options) =>
            isDraft<TValues>(value)
                ? Effect.succeed(value)
                : Effect.fail(
                      new SchemaIssue.InvalidValue({ message: 'Form values must be an object.' }, value, options),
                  ),
    );
    return draft.check(
        Schema.makeFilter((values) => {
            const issues: Array<Schema.FilterIssue> = [];
            for (const { field, segments, decode } of fields) {
                for (const concrete of expandValues(segments, values, { path: [], isAbsentArray })) {
                    const required =
                        resolveRowConstraints(field.constraints, values, {
                            template: segments,
                            concrete: concrete.path,
                        }).required === true;
                    const issue = checkValue(field, decode, { ...concrete, required });
                    if (issue !== undefined) {
                        issues.push(issue);
                    }
                }
            }
            return issues;
        }),
    );
}
