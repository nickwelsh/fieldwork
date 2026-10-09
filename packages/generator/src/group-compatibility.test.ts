import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { Extraction, FieldDefinition, JsonValue } from '@fieldwork/core';
import type { RegistryManifest, TypeShape } from './contracts.js';
import { emitReact } from './emit.js';
import { inspectRegistries } from './inspect.js';

vi.setConfig({ testTimeout: 10_000 });

async function inspectSlots(types: Readonly<Record<string, string>>): Promise<Readonly<Record<string, TypeShape>>> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-slot-types-'));
    try {
        await writeFile(
            path.join(root, 'tsconfig.json'),
            JSON.stringify({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true } }),
        );
        await writeFile(
            path.join(root, 'forms.ts'),
            `
function createFieldwork(options: unknown) { return options; }
function withFieldGroup<T>(options: { defaultValues: T; props: object }) { return (props: object) => null; }
type Box<T> = { stable: string; optional?: T; explicit?: T | undefined };
type Recursive = { items: Recursive[] };
interface EmptyInterface {}
interface NamedInterface { extra?: string }
interface IndexedInterface { [key: string]: unknown }
interface StableInterface { stable: string }
type EmptyAlias = {};
type NamedAlias = { extra?: string };
enum NativeChoice { Home = 'home', Work = 'work' }
namespace Named { export interface File { value: string } }
${Object.entries(types)
    .map(
        ([name, type]) =>
            `declare const defaults${name}: { value: ${type} }; const ${name} = withFieldGroup({ defaultValues: defaults${name}, props: {} });`,
    )
    .join('\n')}
export default createFieldwork({ fieldComponents: {}, formComponents: {}, fieldGroups: { ${Object.keys(types).join(', ')} } });
`,
        );
        return Object.fromEntries(
            Object.entries(inspectRegistries('forms.ts', root).groups).map(([name, group]) => {
                const slot = group.slots?.['value'];
                if (slot === undefined) {
                    throw new Error(`Missing inspected slot ${name}.`);
                }
                return [name, slot];
            }),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function field(name: string, type: FieldDefinition['type'], nullable = false): FieldDefinition {
    return { name, type, nullable, component: 'Input', label: name, props: {}, constraints: {}, serverRules: [] };
}

function source(fields: Readonly<Record<string, FieldDefinition>>, value: JsonValue): Extraction {
    return {
        version: 1,
        diagnostics: [],
        forms: [
            {
                id: 'SlotTypes',
                defaultValues: { value },
                fields,
                groups: { container: { component: 'Container', fields: { value: 'value' }, props: {} } },
            },
        ],
    };
}

function generate(slot: TypeShape | undefined, extraction: Extraction) {
    if (slot === undefined) {
        throw new Error('Missing test slot.');
    }
    const registry: RegistryManifest = {
        fields: {
            Input: {
                props: {
                    label: { required: true, type: { kind: 'string' } },
                    constraints: { required: true, type: { kind: 'unknown' } },
                },
            },
        },
        components: {},
        groups: { Container: { props: {}, slots: { value: slot } } },
    };
    return emitReact(extraction, registry, { root: os.tmpdir(), output: { forms: 'slot-types' } });
}

function accepted(slot: TypeShape | undefined, extraction: Extraction): boolean {
    try {
        generate(slot, extraction);
        return true;
    } catch {
        return false;
    }
}

function booleanUnion(count: number): string {
    return Array.from(
        { length: 2 ** count },
        (_variant, bits) =>
            `{ ${Array.from({ length: count }, (_property, index) => `b${index}: ${Math.floor(bits / 2 ** index) % 2 !== 0}`).join('; ')} }`,
    ).join(' | ');
}

function booleanObject(count: number, extra: ReadonlyArray<string> = []): Extraction {
    const names = [...Array.from({ length: count }, (_property, index) => `b${index}`), ...extra];
    return source(
        {
            value: field('value', 'object'),
            ...Object.fromEntries(names.map((name) => [name, field(`value.${name}`, 'boolean')] as const)),
        },
        Object.fromEntries(names.map((name) => [name, false] as const)),
    );
}

function mapGroupTarget(form: Extraction['forms'][number], target: string): Extraction['forms'][number] {
    return { ...form, groups: { container: { component: 'Container', fields: { value: target }, props: {} } } };
}

describe('inspected writable group contracts', () => {
    it('preserves option item shapes for collection group reads and writes', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Colors: 'Array<"red" | "blue">',
            Scalar: '"red" | "blue"',
            Ids: 'Array<1 | 2 | "1" | "2">',
            Numbers: 'Array<1 | 2>',
            Record: 'Record<string, "red" | "blue">',
        });
        const colors = source({ value: { ...field('value', 'array'), constraints: { options: ['red', 'blue'] } } }, []);
        expect([accepted(slots['Colors'], colors), accepted(slots['Scalar'], colors)]).toStrictEqual([true, false]);
        const ids = source({ value: { ...field('value', 'array'), constraints: { options: ['1', '2'] } } }, []);
        expect([accepted(slots['Ids'], ids), accepted(slots['Numbers'], ids)]).toStrictEqual([true, false]);
        const record = source(
            { value: { ...field('value', 'object'), constraints: { options: ['red', 'blue'] } } },
            {},
        );
        expect(accepted(slots['Record'], record)).toBe(true);
    });

    it('checks fixed arrays and numeric records with the same contextual types as emitted values', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Text: 'string',
            Rows: 'Array<{ name: string }>',
            NumericObject: '{ "0": { name: string } }',
            LiteralObject: '{ "01": { name: string }; "1": { name: string } }',
        });
        const fixed = source({ value: field('value', 'array'), name: field('value[00].name', 'string') }, [
            { name: '' },
        ]);
        const fixedChild: Extraction = {
            ...fixed,
            forms: fixed.forms.map((form) => mapGroupTarget(form, 'value[00].name')),
        };
        expect([
            accepted(slots['Rows'], fixed),
            accepted(slots['NumericObject'], fixed),
            accepted(slots['Text'], fixedChild),
        ]).toStrictEqual([true, false, false]);
        const inferred = source({ name: field('value.0.name', 'string') }, [{ name: '' }]);
        const inferredChild: Extraction = {
            ...inferred,
            forms: inferred.forms.map((form) => mapGroupTarget(form, 'value.0.name')),
        };
        expect(accepted(slots['Text'], inferredChild)).toBe(false);
        const literal = source(
            {
                value: field('value', 'object'),
                name: field('value.01.name', 'string'),
                other: field('value.1.name', 'string'),
            },
            { '01': { name: '' }, '1': { name: '' } },
        );
        const literalChild: Extraction = {
            ...literal,
            forms: literal.forms.map((form) => mapGroupTarget(form, 'value.01.name')),
        };
        expect([accepted(slots['LiteralObject'], literal), accepted(slots['Text'], literalChild)]).toStrictEqual([
            true,
            true,
        ]);
    });

    it('preserves nullable nested fixed arrays and rejects nonnullable whole-container slots', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            NullableRows: 'Array<{ items: Array<{ name: string }> | null }>',
            Rows: 'Array<{ items: Array<{ name: string }> }>',
        });
        const nested = source(
            {
                value: field('value', 'array'),
                items: field('value[00].items', 'array', true),
                name: field('value.0.items[01].name', 'string'),
            },
            [{ items: null }],
        );
        expect([accepted(slots['NullableRows'], nested), accepted(slots['Rows'], nested)]).toStrictEqual([true, false]);
        expect(generate(slots['NullableRows'], nested)[0]?.contents).toContain(
            '"value": Array<{ "items": Array<{ "name": string; }> | null; }>',
        );
    });

    it('rejects fixed writable child slots of dynamic arrays while preserving whole-array mappings', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Text: 'string',
            AbsentText: 'string | undefined',
            Rows: 'Array<{ name: string }>',
        });
        const parent = source(
            {
                value: field('value', 'array'),
                names: field('value.*.name', 'string'),
                first: field('value.0.name', 'string'),
            },
            [],
        );
        const child: Extraction = {
            ...parent,
            forms: parent.forms.map((form) => mapGroupTarget(form, 'value.0.name')),
        };
        expect(accepted(slots['Text'], child)).toBe(false);
        // An optional group slot permits undefined writes, but the field input still requires a string.
        expect(accepted(slots['AbsentText'], child)).toBe(false);
        expect(accepted(slots['Rows'], parent)).toBe(true);
    });

    it('rejects writable child slots through nullable ancestors while preserving whole-parent mappings', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Text: 'string',
            AbsentText: 'string | undefined',
            NullableText: 'string | null',
            Parent: '{ name: string } | null',
        });
        const parent = source({ value: field('value', 'object', true), name: field('value.name', 'string') }, null);
        const child: Extraction = {
            ...parent,
            forms: parent.forms.map((form) => mapGroupTarget(form, 'value.name')),
        };
        expect([
            accepted(slots['Text'], child),
            accepted(slots['AbsentText'], child),
            accepted(slots['NullableText'], child),
        ]).toStrictEqual([false, false, false]);
        expect(accepted(slots['Parent'], parent)).toBe(true);
        const defined = source({ name: field('value.name', 'string') }, { name: '' });
        const mapped: Extraction = {
            ...defined,
            forms: defined.forms.map((form) => mapGroupTarget(form, 'value.name')),
        };
        expect(accepted(slots['Text'], mapped)).toBe(true);
    });

    it('accepts complete finite discriminated object unions and rejects missing or unsafe variants', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Complete: '{ enabled: true; name: string } | { enabled: false; name: string }',
            Missing: '{ enabled: true; name: string }',
            Unsafe: '{ enabled: true; name: number } | { enabled: false; name: string }',
            Choices:
                "{ choice: 'home'; name: string } | { choice: 'work'; name: string } | { choice: ''; name: string }",
            MissingChoice: "{ choice: 'home'; name: string } | { choice: 'work'; name: string }",
        });
        const boolean = source(
            {
                value: field('value', 'object'),
                enabled: field('value.enabled', 'boolean'),
                name: field('value.name', 'string'),
            },
            { enabled: false, name: '' },
        );
        expect([
            accepted(slots['Complete'], boolean),
            accepted(slots['Missing'], boolean),
            accepted(slots['Unsafe'], boolean),
        ]).toStrictEqual([true, false, false]);
        const choice = source(
            {
                value: field('value', 'object'),
                choice: { ...field('value.choice', 'enum'), constraints: { options: ['home', 'work'] } },
                name: field('value.name', 'string'),
            },
            { choice: '', name: '' },
        );
        expect([accepted(slots['Choices'], choice), accepted(slots['MissingChoice'], choice)]).toStrictEqual([
            true,
            false,
        ]);
    });

    it('covers nullable enum and boolean discriminants without omitting null drafts', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Toggle: '{ enabled: true; name: string } | { enabled: false; name: string } | { enabled: null; name: string }',
            MissingNull: '{ enabled: true; name: string } | { enabled: false; name: string }',
            Choice: "{ choice: 'home'; name: string } | { choice: ''; name: string } | { choice: null; name: string }",
            MissingChoiceNull: "{ choice: 'home'; name: string } | { choice: ''; name: string }",
        });
        const boolean = source(
            {
                value: field('value', 'object'),
                enabled: field('value.enabled', 'boolean', true),
                name: field('value.name', 'string'),
            },
            { enabled: null, name: '' },
        );
        const choice = source(
            {
                value: field('value', 'object'),
                choice: { ...field('value.choice', 'enum', true), constraints: { options: ['home'] } },
                name: field('value.name', 'string'),
            },
            { choice: null, name: '' },
        );
        expect([accepted(slots['Toggle'], boolean), accepted(slots['MissingNull'], boolean)]).toStrictEqual([
            true,
            false,
        ]);
        expect([accepted(slots['Choice'], choice), accepted(slots['MissingChoiceNull'], choice)]).toStrictEqual([
            true,
            false,
        ]);
    });

    it('bounds finite discriminant combinations without counting shared boolean properties', async () => {
        expect.hasAssertions();
        const shared = Array.from({ length: 5 }, (_, index) => `b${index}: boolean`).join('; ');
        const slots = await inspectSlots({
            BelowLimit: booleanUnion(4),
            AboveLimit: booleanUnion(5),
            Shared: `{ enabled: true; ${shared} } | { enabled: false; ${shared} }`,
        });
        expect([
            accepted(slots['BelowLimit'], booleanObject(4)),
            accepted(slots['AboveLimit'], booleanObject(5)),
        ]).toStrictEqual([true, false]);
        expect(accepted(slots['Shared'], booleanObject(5, ['enabled']))).toBe(true);
    });

    it('requires explicit indices on interface slots mapped to untyped objects', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Empty: 'EmptyInterface',
            Named: 'NamedInterface',
            Indexed: 'IndexedInterface',
            Alias: 'NamedAlias',
            Anonymous: '{ extra?: string }',
        });
        const object = source({ value: field('value', 'object') }, {});
        expect([
            accepted(slots['Empty'], object),
            accepted(slots['Named'], object),
            accepted(slots['Indexed'], object),
            accepted(slots['Alias'], object),
            accepted(slots['Anonymous'], object),
        ]).toStrictEqual([false, false, true, false, false]);
        const noExtra = await inspectSlots({ Alias: 'EmptyAlias', Anonymous: '{}', Stable: 'StableInterface' });
        expect([accepted(noExtra['Alias'], object), accepted(noExtra['Anonymous'], object)]).toStrictEqual([
            true,
            true,
        ]);
        const named = source(
            { value: field('value', 'object'), stable: field('value.stable', 'string') },
            { stable: '' },
        );
        expect(accepted(noExtra['Stable'], named)).toBe(true);
    });

    it('preserves undefined inside arrays, indices, and required nested properties', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            ArrayUndefined: 'Array<string | undefined>',
            IndexUndefined: 'Record<string, string | undefined>',
            RequiredUndefined: '{ name: string | undefined }',
        });
        expect(slots['ArrayUndefined']).toMatchObject({
            items: { alternatives: [{ kind: 'undefined' }, { kind: 'string' }] },
        });
        expect(slots['IndexUndefined']).toMatchObject({
            additionalProperties: { alternatives: [{ kind: 'undefined' }, { kind: 'string' }] },
        });
        expect(slots['RequiredUndefined']).toMatchObject({
            properties: {
                name: { required: true, type: { alternatives: [{ kind: 'undefined' }, { kind: 'string' }] } },
            },
        });
        expect(() =>
            generate(
                slots['ArrayUndefined'],
                source({ value: field('value', 'array'), item: field('value.*', 'string') }, []),
            ),
        ).toThrow('incompatible field value');
        expect(() =>
            generate(
                slots['RequiredUndefined'],
                source({ value: field('value', 'object'), name: field('value.name', 'string') }, { name: '' }),
            ),
        ).toThrow('incompatible field value');
    });

    it('distinguishes generic optional absence from explicitly writable undefined', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({ OptionalBox: 'Box<string>' });
        expect(slots['OptionalBox']).toMatchObject({
            properties: {
                optional: { required: false, type: { kind: 'string' } },
                explicit: {
                    required: false,
                    type: { kind: 'union', alternatives: [{ kind: 'undefined' }, { kind: 'string' }] },
                },
            },
        });
        const stable = source(
            { value: field('value', 'object'), stable: field('value.stable', 'string') },
            { stable: '' },
        );
        expect(generate(slots['OptionalBox'], stable)).toHaveLength(1);
    });

    it('checks numeric and string index values while retaining compatible unknown records', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            UndefinedIndex: 'Record<string, string | undefined>',
            NumericIndex: 'Record<number, string>',
            UnknownIndex: 'Record<string, unknown>',
            NumericUnknown: 'Record<number, unknown>',
        });
        const untyped = source({ value: field('value', 'object') }, {});
        expect(slots['NumericIndex']).toMatchObject({ numericProperties: { kind: 'string' } });
        expect([
            accepted(slots['UndefinedIndex'], untyped),
            accepted(slots['NumericIndex'], untyped),
            accepted(slots['UnknownIndex'], untyped),
            accepted(slots['NumericUnknown'], untyped),
        ]).toStrictEqual([false, false, true, true]);
    });

    it('rejects unrepresentable index domains without treating them as empty objects', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            SymbolIndex: 'Record<symbol, string>',
            // oxlint-disable-next-line eslint/no-template-curly-in-string -- Preserve this TypeScript index domain in the inspected fixture.
            PatternIndex: '{ [key: `data-${string}`]: string }',
        });
        const untyped = source({ value: field('value', 'object') }, {});
        expect(slots).toStrictEqual({ SymbolIndex: { kind: 'unsupported' }, PatternIndex: { kind: 'unsupported' } });
        expect([accepted(slots['SymbolIndex'], untyped), accepted(slots['PatternIndex'], untyped)]).toStrictEqual([
            false,
            false,
        ]);
    });

    it.each([9, 16])('preserves finite depth-%i shapes without widening narrower leaves', async (depth) => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            DeepUnknown: `${'Array<'.repeat(depth)}unknown${'>'.repeat(depth)}`,
            DeepString: `${'Array<'.repeat(depth)}string${'>'.repeat(depth)}`,
        });
        const fields = Object.fromEntries(
            Array.from({ length: depth }, (_, index) => {
                const name = `value${'.*'.repeat(index)}`;
                return [name, field(name, 'array')];
            }),
        );
        const nested = source(fields, []);
        expect(generate(slots['DeepUnknown'], nested)).toHaveLength(1);
        expect(() => generate(slots['DeepString'], nested)).toThrow('incompatible field value');
    });

    it('rejects recursive group types instead of widening their cycles to unknown', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({ RecursiveSlot: 'Recursive' });
        expect(slots['RecursiveSlot']).toMatchObject({
            properties: { items: { type: { items: { kind: 'unsupported' } } } },
        });
        expect(() => generate(slots['RecursiveSlot'], source({ value: field('value', 'object') }, {}))).toThrow(
            'incompatible field value',
        );
    });

    it('matches scalar and enum read/write compatibility, including blank enum drafts', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Text: 'string',
            NullableText: 'string | null',
            UndefinedText: 'string | undefined',
            Unknown: 'unknown',
            Boolean: 'boolean',
            Choice: "'' | 'home' | 'work'",
            NarrowChoice: "'' | 'home'",
            Native: "'' | NativeChoice",
        });
        const text = source({ value: field('value', 'string') }, '');
        const choice = source({ value: { ...field('value', 'enum'), constraints: { options: ['home', 'work'] } } }, '');
        expect([
            accepted(slots['Text'], text),
            accepted(slots['NullableText'], text),
            accepted(slots['UndefinedText'], text),
            accepted(slots['Unknown'], text),
        ]).toStrictEqual([true, false, false, false]);
        const boolean = source({ value: field('value', 'boolean') }, false);
        expect(accepted(slots['Boolean'], boolean)).toBe(true);
        expect([
            accepted(slots['Choice'], choice),
            accepted(slots['Text'], choice),
            accepted(slots['NarrowChoice'], choice),
            accepted(slots['Native'], choice),
        ]).toStrictEqual([true, false, false, false]);
    });

    it('preserves array mutability and rejects nominal lookalikes or narrower strings', async () => {
        expect.hasAssertions();
        const slots = await inspectSlots({
            Mutable: 'number[]',
            Readonly: 'readonly number[]',
            NativeFile: 'File | null',
            LookalikeFile: 'Named.File | null',
            // oxlint-disable-next-line eslint/no-template-curly-in-string -- Preserve the narrower TypeScript string type in the inspected fixture.
            Template: '`${string}@${string}`',
        });
        const numbers = source({ value: field('value', 'array'), item: field('value.*', 'number') }, []);
        const file = source({ value: field('value', 'file') }, null);
        expect([accepted(slots['Mutable'], numbers), accepted(slots['Readonly'], numbers)]).toStrictEqual([
            true,
            false,
        ]);
        expect([accepted(slots['NativeFile'], file), accepted(slots['LookalikeFile'], file)]).toStrictEqual([
            true,
            false,
        ]);
        const text = source({ value: field('value', 'string') }, '');
        expect(accepted(slots['Template'], text)).toBe(false);
    });
});
