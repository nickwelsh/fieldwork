import { vi, describe, expect, it } from 'vite-plus/test';
import { Result, Schema, SchemaIssue } from 'effect';

import {
    defineForm,
    getValue,
    resolveConstraints,
    routeUrl,
    titleCase,
    normalizePath,
    definitionSchema,
} from './index.js';
import type { FieldDefinition } from './contracts.js';

vi.setConfig({ testTimeout: 10_000 });

function field(name: string, changes: Partial<FieldDefinition> = {}): FieldDefinition {
    return {
        name,
        type: 'string',
        component: 'TextField',
        label: titleCase(name),
        nullable: false,
        props: {},
        constraints: {},
        serverRules: [],
        ...changes,
    };
}

interface FieldIssue {
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
}

function flatten(issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey> = []): ReadonlyArray<FieldIssue> {
    // oxlint-disable-next-line no-underscore-dangle,typescript/switch-exhaustiveness-check -- Native wrapper issues recurse; all leaf issues use their formatter.
    switch (issue._tag) {
        case 'Pointer': {
            return flatten(issue.issue, [...path, ...issue.path]);
        }
        case 'Composite':
        case 'AnyOf': {
            return issue.issues.flatMap((child) => flatten(child, path));
        }
        case 'Filter': {
            const message = SchemaIssue.defaultCheckHook(issue);
            return message === undefined ? flatten(issue.issue, path) : [{ path, message }];
        }
        case 'Encoding': {
            return flatten(issue.issue, path);
        }
        default: {
            return [{ path, message: SchemaIssue.makeFormatterDefault()(issue) }];
        }
    }
}

function issues(
    definition: { readonly fields: Readonly<Record<string, FieldDefinition>>; readonly defaultValues: object },
    value: unknown,
): ReadonlyArray<FieldIssue> {
    const result = Schema.decodeUnknownResult(definitionSchema(definition), { errors: 'all' })(value);
    return Result.isFailure(result) ? flatten(result.failure.issue) : [];
}

describe('portable contracts', () => {
    it('uses named leaf segments for default labels and translates concrete Laravel array paths', () => {
        expect.hasAssertions();
        expect(titleCase('billing.address_line_1')).toBe('Address Line 1');
        expect(titleCase('contacts[0].postalCode')).toBe('Postal Code');
        expect(normalizePath('contacts[0].email')).toBe('contacts.0.email');
        expect(getValue({ contacts: [{ email: 'nick@example.com' }] }, 'contacts[0].email')).toBe('nick@example.com');
        expect(() => getValue({}, '__proto__.polluted')).toThrow('Invalid field path');
    });

    it('evaluates conditional requirements without treating false as missing', () => {
        expect.hasAssertions();
        const constraints = { requiredWhen: [{ field: 'newsletter', operator: 'equals', values: ['true'] }] } as const;
        expect(resolveConstraints(constraints, { newsletter: true }).required).toBe(true);
        expect(resolveConstraints(constraints, { newsletter: false }).required).toBe(false);
        const definition = defineForm<{ newsletter: boolean }>()({
            id: 'boolean',
            defaultValues: { newsletter: false },
            fields: { newsletter: field('newsletter', { type: 'boolean', constraints: { required: true } }) },
            groups: {},
        });
        expect(Schema.decodeUnknownSync(definitionSchema(definition))({ newsletter: false })).toStrictEqual({
            newsletter: false,
        });
    });

    it('distinguishes missing required_if dependencies from null while retaining required_unless semantics', () => {
        expect.hasAssertions();
        const condition = { field: 'trigger', operator: 'equals', values: ['null'] } as const;
        const definition = {
            defaultValues: {},
            fields: { details: field('details', { nullable: true, constraints: { requiredWhen: [condition] } }) },
        };
        const required = [{ path: ['details'], message: 'Details is required.' }];
        expect(
            [{}, { trigger: undefined }, { trigger: null }, { trigger: 'null' }].map((values) =>
                issues(definition, values),
            ),
        ).toStrictEqual([[], [], required, required]);
        const unless = { requiredWhen: [{ ...condition, operator: 'notEquals' }] } as const;
        expect(
            [{}, { trigger: null }, { trigger: 'other' }].map((values) => resolveConstraints(unless, values).required),
        ).toStrictEqual([false, false, true]);
        expect(
            resolveConstraints({ requiredWhen: [{ ...condition, operator: 'notEquals', values: ['yes'] }] }, {})
                .required,
        ).toBe(true);
        expect(
            [null, undefined].map(
                (trigger) =>
                    resolveConstraints({ requiredWhen: [{ ...condition, values: ['NuLl'] }] }, { trigger }).required,
            ),
        ).toStrictEqual([true, false]);
        const nested = {
            defaultValues: {},
            fields: {
                details: field('rows.*.details', {
                    nullable: true,
                    constraints: { requiredWhen: [{ ...condition, field: 'rows.*.trigger' }] },
                }),
            },
        };
        expect(issues(nested, { rows: [{}, { trigger: null }, { trigger: 'other' }] })).toStrictEqual([
            { path: ['rows', 1, 'details'], message: 'Details is required.' },
        ]);
    });

    it('converts only literal true and false conditional parameters for boolean dependencies', () => {
        expect.hasAssertions();
        const definition = (values: ReadonlyArray<string | number | boolean>) => ({
            defaultValues: {},
            fields: {
                details: field('details', {
                    nullable: true,
                    constraints: { requiredWhen: [{ field: 'trigger', operator: 'equals', values }] },
                }),
            },
        });
        const comparisons = [
            { values: ['1', 1], trigger: true },
            { values: ['0', 0], trigger: false },
            { values: ['true'], trigger: true },
            { values: ['false'], trigger: false },
            { values: [true], trigger: true },
            { values: [false], trigger: false },
        ];
        const required = [{ path: ['details'], message: 'Details is required.' }];
        expect(comparisons.map(({ values, trigger }) => issues(definition(values), { trigger }))).toStrictEqual([
            [],
            [],
            required,
            required,
            required,
            required,
        ]);
        expect(
            resolveConstraints(
                { requiredWhen: [{ field: 'trigger', operator: 'notEquals', values: ['1'] }] },
                { trigger: true },
            ).required,
        ).toBe(true);
    });

    it('compares decimal numeric conditional parameters without coercing empty, hexadecimal or arbitrary text', () => {
        expect.hasAssertions();
        const condition = { field: 'trigger', operator: 'equals' } as const;
        const requiredFor = (parameter: string, trigger: string | number) =>
            resolveConstraints({ requiredWhen: [{ ...condition, values: [parameter] }] }, { trigger }).required;
        expect(
            ['01', '1.0', '1e0', ' 1 '].map((parameter) => [requiredFor(parameter, 1), requiredFor(parameter, '1')]),
        ).toStrictEqual([
            [true, true],
            [true, true],
            [true, true],
            [true, true],
        ]);
        expect(['foo', '', '0x0', '\u00A00\u00A0'].map((parameter) => requiredFor(parameter, 0))).toStrictEqual([
            false,
            false,
            false,
            false,
        ]);
        expect(requiredFor('9007199254740993', '9007199254740992')).toBe(false);
        expect(requiredFor('09007199254740993', '9007199254740993')).toBe(true);
        expect(
            resolveConstraints(
                { requiredWhen: [{ field: 'trigger', operator: 'notEquals', values: ['1.0'] }] },
                { trigger: 1 },
            ).required,
        ).toBe(false);
    });

    it('validates numeric bounds, code point lengths, nullability, and array item paths', () => {
        expect.hasAssertions();
        const definition = defineForm<{ name: string; age: number; contacts: Array<{ email: string }> }>()({
            id: 'nested',
            defaultValues: { name: '', age: 0, contacts: [] },
            groups: {},
            fields: {
                name: field('name', { constraints: { minLength: 2 } }),
                age: field('age', { type: 'integer', constraints: { min: 18 } }),
                email: field('contacts.*.email', { constraints: { required: true, format: 'email' } }),
            },
        });
        const failures = issues(definition, { name: '😀', age: 17, contacts: [{ email: 'invalid' }] });
        expect(failures.map((issue) => issue.path)).toStrictEqual([['name'], ['age'], ['contacts', 0, 'email']]);
        expect(failures.map((issue) => issue.message)).toStrictEqual([
            'Name must have at least 2 characters.',
            'Age must be at least 18.',
            'Email must be a valid email address.',
        ]);
        expect(issues(definition, { name: '😀😀', age: 18, contacts: [{ email: 'nick@example.com' }] })).toStrictEqual(
            [],
        );
    });

    it('rejects overlapping groups and preserves safe route parameter encoding', () => {
        expect.hasAssertions();
        expect(() =>
            defineForm<{ name: string }>()({
                id: 'bad',
                defaultValues: { name: '' },
                fields: { name: field('name') },
                groups: {
                    one: { component: 'Group', fields: { name: 'name' }, props: {} },
                    two: { component: 'Group', fields: { name: 'name' }, props: {} },
                },
            }),
        ).toThrow('more than one group');
        expect(routeUrl('users/{user}', { user: 'a/b' })).toBe('/users/a%2Fb');
        expect(() => routeUrl('users/{user}', {})).toThrow('Missing route parameter');
    });

    it('keeps nullable, absent and blank optional drafts while applying conditional requirements', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                company: field('company', {
                    nullable: true,
                    constraints: { requiredWhen: [{ field: 'newsletter', operator: 'equals', values: ['true'] }] },
                }),
                nickname: field('nickname', { constraints: { minLength: 3 } }),
            },
        };
        expect(issues(definition, { newsletter: false, company: null, nickname: '' })).toStrictEqual([]);
        expect(issues(definition, {})).toStrictEqual([]);
        expect(issues(definition, { newsletter: true, company: null })).toStrictEqual([
            { path: ['company'], message: 'Company is required.' },
        ]);
        expect(issues(definition, { newsletter: true, company: '   ' })).toStrictEqual([
            { path: ['company'], message: 'Company is required.' },
        ]);
    });

    it('requires populated object records even when the field is nullable', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                details: field('details', { type: 'object', nullable: true, constraints: { required: true } }),
            },
        };
        const emptyNullPrototype: Record<string, unknown> = {};
        Object.setPrototypeOf(emptyNullPrototype, null);
        const required = [{ path: ['details'], message: 'Details is required.' }];
        expect(
            [{}, null, undefined, emptyNullPrototype].map((details) => issues(definition, { details })),
        ).toStrictEqual([required, required, required, required]);
        expect(issues(definition, { details: { enabled: false, count: 0, nested: null } })).toStrictEqual([]);
        const optional = {
            ...definition,
            fields: { details: field('details', { type: 'object', nullable: true }) },
        };
        expect([{}, null, undefined].map((details) => issues(optional, { details }))).toStrictEqual([[], [], []]);
    });

    it('applies conditional object requirements to concrete wildcard rows', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                details: field('contacts.*.details', {
                    type: 'object',
                    nullable: true,
                    constraints: {
                        requiredWhen: [{ field: 'contacts.*.enabled', operator: 'equals', values: ['true'] }],
                    },
                }),
            },
        };
        expect(
            issues(definition, {
                contacts: [
                    { enabled: true, details: {} },
                    { enabled: true, details: null },
                    { enabled: false, details: {} },
                    { enabled: false, details: null },
                    { enabled: true, details: { available: false } },
                ],
            }),
        ).toStrictEqual([
            { path: ['contacts', 0, 'details'], message: 'Details is required.' },
            { path: ['contacts', 1, 'details'], message: 'Details is required.' },
        ]);
    });

    it('treats empty records and arrays as absent conditional values while retaining platform atomics', () => {
        expect.hasAssertions();
        const triggers = [
            {},
            [],
            null,
            undefined,
            false,
            0,
            { enabled: false },
            [null],
            new File([], 'empty.txt'),
            new Date(0),
        ];
        const present = { requiredWhen: [{ field: 'trigger', operator: 'present', values: [] }] } as const;
        const absent = { requiredWhen: [{ field: 'trigger', operator: 'absent', values: [] }] } as const;
        expect(triggers.map((trigger) => resolveConstraints(present, { trigger }).required)).toStrictEqual([
            false,
            false,
            false,
            false,
            true,
            true,
            true,
            true,
            true,
            true,
        ]);
        expect(triggers.map((trigger) => resolveConstraints(absent, { trigger }).required)).toStrictEqual([
            true,
            true,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
        const definition = {
            defaultValues: {},
            fields: { details: field('details', { type: 'object', constraints: absent }) },
        };
        expect(issues(definition, { trigger: {}, details: {} })).toStrictEqual([
            { path: ['details'], message: 'Details is required.' },
        ]);
        expect(issues(definition, { trigger: { enabled: false }, details: {} })).toStrictEqual([]);
    });

    it('keeps required array and File boundaries consistent with object emptiness', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                tags: field('tags', { type: 'array', nullable: true, constraints: { required: true } }),
                attachment: field('attachment', { type: 'file', constraints: { required: true } }),
            },
        };
        const file = new File([], 'empty.txt');
        expect(issues(definition, { tags: [], attachment: file })).toStrictEqual([
            { path: ['tags'], message: 'Tags is required.' },
        ]);
        expect(issues(definition, { tags: null, attachment: file })).toStrictEqual([
            { path: ['tags'], message: 'Tags is required.' },
        ]);
        const decoded = Schema.decodeUnknownSync(definitionSchema(definition))({ tags: [null], attachment: file });
        expect(getValue(decoded, 'attachment')).toBe(file);
        expect(getValue(decoded, 'tags')).toStrictEqual([null]);
    });

    it('preserves enum options and runtime scalar constraints with full message accumulation', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                email: field('email', {
                    type: 'enum',
                    constraints: { options: ['x', 'valid@example.com'], minLength: 5, format: 'email' },
                }),
                rating: field('rating', { type: 'enum', constraints: { options: [1, 5], min: 3 } }),
            },
        };
        expect(issues(definition, { email: 'x', rating: 1 })).toStrictEqual([
            { path: ['email'], message: 'Email must have at least 5 characters.' },
            { path: ['email'], message: 'Email must be a valid email address.' },
            { path: ['rating'], message: 'Rating must be at least 3.' },
        ]);
        expect(issues(definition, { email: 'other@example.com', rating: 5 })).toStrictEqual([
            { path: ['email'], message: 'Email must be one of the allowed values.' },
        ]);
        expect(issues(definition, { email: '', rating: '' })).toStrictEqual([]);
        expect(
            issues(
                {
                    ...definition,
                    fields: {
                        email: field('email', {
                            type: 'enum',
                            constraints: { required: true, options: ['valid@example.com'] },
                        }),
                    },
                },
                { email: '' },
            ),
        ).toStrictEqual([{ path: ['email'], message: 'Email is required.' }]);
    });

    it('validates nested wildcard arrays and concrete nested object paths', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                email: field('teams.*.members.*.email', { constraints: { required: true, format: 'email' } }),
                city: field('billing.city', { constraints: { required: true } }),
            },
        };
        expect(
            issues(definition, { teams: [{ members: [{ email: 'invalid' }, {}] }], billing: { city: '' } }),
        ).toStrictEqual([
            { path: ['teams', 0, 'members', 0, 'email'], message: 'Email must be a valid email address.' },
            { path: ['teams', 0, 'members', 1, 'email'], message: 'Email is required.' },
            { path: ['billing', 'city'], message: 'City is required.' },
        ]);
        expect(issues(definition, { teams: [], billing: { city: 'Boston' } })).toStrictEqual([]);
        expect(() => definitionSchema({ defaultValues: {}, fields: { bad: field('__proto__.polluted') } })).toThrow(
            'Invalid field path',
        );
    });

    it('validates sparse wildcard positions the same as their serialized null rows', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                rows: field('rows', { type: 'array' }),
                name: field('rows.*.name', { constraints: { required: true } }),
            },
        };
        const rows: Array<{ name: string } | null> = [];
        rows.length = 3;
        rows[1] = { name: 'valid' };
        const required = [
            { path: ['rows', 0, 'name'], message: 'Name is required.' },
            { path: ['rows', 2, 'name'], message: 'Name is required.' },
        ];
        expect(issues(definition, { rows })).toStrictEqual(required);
        expect(issues(definition, { rows: [null, { name: 'valid' }, null] })).toStrictEqual(required);
        expect(issues(definition, { rows: [] })).toStrictEqual([]);
        const nested = {
            defaultValues: {},
            fields: { name: field('teams.*.members.*.name', { constraints: { required: true } }) },
        };
        expect(issues(nested, { teams: [{ members: rows.slice(0, 1) }] })).toStrictEqual([
            { path: ['teams', 0, 'members', 0, 'name'], message: 'Name is required.' },
        ]);
    });

    it('validates collection options per item while retaining scalar native types', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                colors: field('colors', { type: 'array', constraints: { options: ['red', 'blue'] } }),
                ids: field('ids', { type: 'array', constraints: { options: ['1', '2'] } }),
                flags: field('flags', { type: 'object', constraints: { options: ['red', 'blue'] } }),
            },
        };
        expect([['red'], ['red', 'blue'], []].map((colors) => issues(definition, { colors }))).toStrictEqual([
            [],
            [],
            [],
        ]);
        expect(
            issues(definition, { colors: ['green'], ids: [3], flags: { first: 'green' } }).map(({ path }) => path),
        ).toStrictEqual([['colors'], ['ids'], ['flags']]);
        expect(
            issues(definition, { colors: 'red', ids: [1, '2'], flags: { first: 'red', second: 'blue' } }),
        ).toStrictEqual([{ path: ['colors'], message: 'Colors must be an array.' }]);
        const scalar = {
            defaultValues: {},
            fields: {
                age: field('age', { type: 'integer', constraints: { options: [1] } }),
                name: field('name', { constraints: { options: ['red'] } }),
                enabled: field('enabled', { type: 'boolean', constraints: { options: [1] } }),
            },
        };
        expect(issues(scalar, { age: '1', name: ['red'], enabled: true }).map(({ path }) => path)).toStrictEqual([
            ['age'],
            ['name'],
            ['enabled'],
        ]);
        const sparse: Array<string> = [];
        sparse.length = 1;
        expect(issues(definition, { colors: sparse }).map(({ path }) => path)).toStrictEqual([['colors']]);
    });

    it('validates inferred associative rows with required children and record cardinality', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: { rows: [] },
            fields: {
                rows: field('rows', { type: 'array' }),
                row: field('rows.*', { type: 'object', label: 'Rows', constraints: { minItems: 1, maxItems: 2 } }),
                name: field('rows.*.name', { constraints: { required: true } }),
            },
        };
        expect(issues(definition, { rows: [{ name: 'Nick' }] })).toStrictEqual([]);
        expect(issues(definition, { rows: [{ name: 'Nick', extra: 1, other: 2 }] })).toStrictEqual([
            { path: ['rows', 0], message: 'Rows must have at most 2 items.' },
        ]);
        expect(issues(definition, { rows: [{}] })).toStrictEqual([
            { path: ['rows', 0], message: 'Rows must have at least 1 items.' },
            { path: ['rows', 0, 'name'], message: 'Name is required.' },
        ]);
    });

    it('canonicalizes fixed array indices without merging literal numeric object keys', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: { rows: [], codes: {} },
            fields: {
                row: field('rows[00].name', { constraints: { required: true } }),
                code: field('codes.01.name', { constraints: { required: true } }),
            },
        };
        expect(
            issues(definition, { rows: [{ name: '' }], codes: { '01': { name: '' }, '1': { name: 'valid' } } }),
        ).toStrictEqual([
            { path: ['rows', 0, 'name'], message: 'Name is required.' },
            { path: ['codes', '01', 'name'], message: 'Name is required.' },
        ]);
        expect(
            issues(definition, { rows: [{ name: 'valid' }], codes: { '01': { name: 'valid' }, '1': { name: '' } } }),
        ).toStrictEqual([]);
    });

    it('uses known nullable container types for absent fixed-index validation pointers', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: { rows: null, codes: null },
            fields: {
                rows: field('rows', { type: 'array', nullable: true }),
                codes: field('codes', { type: 'object', nullable: true }),
                row: field('rows[00].name', { constraints: { required: true } }),
                code: field('codes.01.name', { constraints: { required: true } }),
            },
        };
        const required = [
            { path: ['rows', 0, 'name'], message: 'Name is required.' },
            { path: ['codes', '01', 'name'], message: 'Name is required.' },
        ];
        expect(issues(definition, { rows: null, codes: null })).toStrictEqual(required);
        expect(issues(definition, {})).toStrictEqual(required);
    });

    it('matches nested padded array metadata when all ancestor containers are absent', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: { rows: null },
            fields: {
                rows: field('rows', { type: 'array', nullable: true }),
                items: field('rows[00].items', { type: 'array', nullable: true }),
                name: field('rows[00].items[01].name', { constraints: { required: true } }),
            },
        };
        const required = [{ path: ['rows', 0, 'items', 1, 'name'], message: 'Name is required.' }];
        expect(issues(definition, { rows: null })).toStrictEqual(required);
        expect(issues(definition, { rows: [{ items: [{ name: 'valid' }, { name: '' }] }] })).toStrictEqual(required);
        expect(issues(definition, { rows: [{ items: [{ name: '' }, { name: 'valid' }] }] })).toStrictEqual([]);
    });

    it('resolves conditional requirements for each wildcard row and nested parent', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                email: field('teams.*.members.*.email', {
                    nullable: true,
                    constraints: {
                        requiredWhen: [{ field: 'teams.*.members.*.enabled', operator: 'equals', values: ['true'] }],
                    },
                }),
                company: field('teams.*.members.*.company', {
                    constraints: {
                        requiredWhen: [{ field: 'teams.*.business', operator: 'equals', values: ['true'] }],
                    },
                }),
            },
        };
        const values = {
            teams: [
                {
                    business: true,
                    members: [
                        { enabled: true, email: '', company: '' },
                        { enabled: false, email: null, company: 'Acme' },
                    ],
                },
                {
                    business: false,
                    members: [
                        { enabled: false, email: '', company: '' },
                        { enabled: true, email: null, company: '' },
                    ],
                },
            ],
        };
        expect(issues(definition, values)).toStrictEqual([
            { path: ['teams', 0, 'members', 0, 'email'], message: 'Email is required.' },
            { path: ['teams', 1, 'members', 1, 'email'], message: 'Email is required.' },
            { path: ['teams', 0, 'members', 0, 'company'], message: 'Company is required.' },
        ]);
        expect(issues(definition, { teams: [] })).toStrictEqual([]);
    });

    it('resolves wildcard present, absent and notEquals conditions independently for each row', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                present: field('contacts.*.present', {
                    constraints: { requiredWhen: [{ field: 'contacts.*.trigger', operator: 'present', values: [] }] },
                }),
                absent: field('contacts.*.absent', {
                    constraints: { requiredWhen: [{ field: 'contacts.*.trigger', operator: 'absent', values: [] }] },
                }),
                different: field('contacts.*.different', {
                    constraints: {
                        requiredWhen: [{ field: 'contacts.*.trigger', operator: 'notEquals', values: ['yes'] }],
                    },
                }),
            },
        };
        expect(issues(definition, { contacts: [{ trigger: 'yes' }, { trigger: '' }] })).toStrictEqual([
            { path: ['contacts', 0, 'present'], message: 'Present is required.' },
            { path: ['contacts', 1, 'absent'], message: 'Absent is required.' },
            { path: ['contacts', 1, 'different'], message: 'Different is required.' },
        ]);
    });

    it('validates files, object and array boundaries without changing File identity', () => {
        expect.hasAssertions();
        const definition = {
            defaultValues: {},
            fields: {
                attachment: field('attachment', { type: 'file' }),
                details: field('details', { type: 'object' }),
                tags: field('tags', { type: 'array', constraints: { minItems: 2 } }),
            },
        };
        const file = new File(['content'], 'document.txt');
        const decoded = Schema.decodeUnknownSync(definitionSchema(definition))({
            attachment: file,
            details: {},
            tags: ['one', 'two'],
        });
        expect(getValue(decoded, 'attachment')).toBe(file);
        expect(issues(definition, { attachment: null, details: {}, tags: ['one', 'two'] })).toStrictEqual([]);
        expect(issues(definition, { attachment: {}, details: [], tags: ['one'] })).toStrictEqual([
            { path: ['attachment'], message: 'Attachment must be a file.' },
            { path: ['details'], message: 'Details must be an object.' },
            { path: ['tags'], message: 'Tags must have at least 2 items.' },
        ]);
        expect(issues(definition, [])).toStrictEqual([{ path: [], message: 'Form values must be an object.' }]);
    });
});
