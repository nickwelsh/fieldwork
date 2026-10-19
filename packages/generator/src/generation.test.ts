import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript-api';
import { Deferred, Effect, Result, Schema } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it, vi } from 'vite-plus/test';
import { definitionSchema, parseExtraction, parseExtractionEffect, parseFormDescriptor } from '@fieldwork/core';
import { UpdateProfileRequest } from '@fieldwork/example/generated/forms/UpdateProfileRequest.js';
import { update } from '@fieldwork/example/generated/actions/profile.js';
import type { Extraction, FieldDefinition, JsonValue } from '@fieldwork/core';
import type { FieldworkConfig, GeneratedFile, RegistryManifest, TypeShape } from './contracts.js';
import { emitReact, emitActions } from './emit.js';
import { laravel, exportPhp } from '@fieldwork/laravel/generator';
import { inertia } from '@fieldwork/inertia/generator';
import { defineConfig, defineSubmission, GenerationError } from './contracts.js';
import type { GenerateOptions } from './generate.js';
import { generate } from './generate.js';
import { inspectRegistries } from './inspect.js';

vi.setConfig({ testTimeout: 10_000 });
const exampleRoot = path.resolve('examples/react');
const manifest = inspectRegistries('src/forms.ts', exampleRoot);
const sourceForm = {
    id: UpdateProfileRequest.id,
    defaultValues: { ...UpdateProfileRequest.defaultValues },
    fields: UpdateProfileRequest.fields,
    groups: UpdateProfileRequest.groups,
};
const extraction: Extraction = {
    version: 1,
    forms: [sourceForm],
    diagnostics: [],
};
const context = { root: exampleRoot, output: { forms: 'generated/forms', actions: 'generated/actions' } };

type NodeEnvironment = NodeServices.NodeServices;

async function runNode<A, E>(effect: Effect.Effect<A, E, NodeEnvironment>) {
    return await Effect.runPromise(Effect.provide(effect, NodeServices.layer));
}

async function runGeneration<E>(config: FieldworkConfig<E, NodeEnvironment>, options: GenerateOptions) {
    return await runNode(generate(config, options));
}

function replaceField(component: string, props: { type: string }): Extraction {
    return {
        ...extraction,
        forms: [
            {
                ...sourceForm,
                fields: {
                    ...UpdateProfileRequest.fields,
                    email: { ...UpdateProfileRequest.fields.email, component, props },
                },
            },
        ],
    };
}

function generateWith(registry: RegistryManifest, source = extraction) {
    return emitReact(source, registry, context);
}

function firstGenerated(files: ReadonlyArray<GeneratedFile>): GeneratedFile {
    const [file] = files;
    if (file === undefined) {
        throw new Error('Missing generated form.');
    }
    return file;
}

function firstForm(source: Extraction): Extraction['forms'][number] {
    const [form] = source.forms;
    if (form === undefined) {
        throw new Error('Missing extracted form.');
    }
    return form;
}

function sourceField(source: Extraction['forms'][number], name: string): FieldDefinition {
    const field = source.fields[name];
    if (field === undefined) {
        throw new Error(`Missing extracted field ${name}.`);
    }
    return field;
}

function containerSource(fields: Readonly<Record<string, FieldDefinition>>, value: JsonValue): Extraction {
    return {
        ...extraction,
        forms: [
            {
                ...sourceForm,
                defaultValues: { ...sourceForm.defaultValues, value },
                fields: { ...sourceForm.fields, ...fields },
                groups: { container: { component: 'Container', fields: { value: 'value' }, props: {} } },
            },
        ],
    };
}

function containerField(name: string, type: FieldDefinition['type'], nullable = false): FieldDefinition {
    return { ...sourceForm.fields.email, name, type, nullable, constraints: {}, props: {} };
}

function containerRegistry(type: TypeShape): RegistryManifest {
    return { ...manifest, groups: { Container: { props: {}, slots: { value: type } } } };
}

const address = manifest.groups['AddressAutocomplete'];
if (address === undefined) {
    throw new Error('Missing address fixture.');
}

function multipleConfig() {
    const app = { extract: () => Effect.succeed(extraction) };
    const external = { extract: () => Effect.succeed(extraction) };
    const web = inertia({
        bindings: {
            source: app,
            extract: () =>
                Effect.succeed([
                    {
                        name: 'profile.update',
                        schema: sourceForm.id,
                        parameters: [{ name: 'user' }, { name: 'section', optional: true }],
                        binding: { uri: 'users/{user}/{section?}', method: 'patch' },
                    },
                ]),
        },
    });
    const mutations = defineSubmission({
        bindings: {
            source: app,
            extract: () =>
                Effect.succeed([
                    {
                        name: 'profile.update',
                        schema: sourceForm.id,
                        parameters: [],
                        binding: { mutation: 'profile.update' },
                    },
                ]),
        },
        emitBinding: (operation) => JSON.stringify({ kind: 'mutation', ...operation.binding }),
    });
    const config = {
        sources: { app, external },
        framework: { inspect: () => manifest, generate: emitReact, actions: emitActions },
        submissions: { web, mutations },
        output: { forms: 'forms', actions: 'actions' },
    };
    return { ...config, submissions: { web, mutations } };
}

describe('generator contracts', () => {
    it('keeps generation lazy and reports compiler exceptions as typed failures', async () => {
        expect.hasAssertions();
        const inspect = vi.fn<() => RegistryManifest>(() => {
            throw new Error('Registry cannot be inspected.');
        });
        const extract = vi.fn<() => Effect.Effect<Extraction>>(() => Effect.succeed(extraction));
        const program = generate(
            defineConfig({
                sources: { app: { extract } },
                framework: { inspect, generate: emitReact, actions: emitActions },
                output: { forms: 'forms' },
            }),
            { root: exampleRoot },
        );
        expect(inspect).not.toHaveBeenCalled();
        expect(extract).not.toHaveBeenCalled();
        const error = await runNode(Effect.flip(program));
        expect(error).toBeInstanceOf(GenerationError);
        expect(error).toMatchObject({ stage: 'inspection', message: 'Registry cannot be inspected.' });
        expect(extract).not.toHaveBeenCalled();
    });

    it('interrupts concurrent source extraction when a sibling fails and preserves its domain error', async () => {
        expect.hasAssertions();
        let interrupted = false;
        const failure = new Error('Source unavailable');
        const result = await runNode(
            Effect.gen(function* runConcurrentGeneration() {
                const started = yield* Deferred.make<boolean>();
                const config = defineConfig({
                    sources: {
                        slow: {
                            extract: () =>
                                Effect.gen(function* extractSlow() {
                                    yield* Deferred.succeed(started, true);
                                    return yield* Effect.never;
                                }).pipe(
                                    Effect.ensuring(
                                        Effect.sync(() => {
                                            interrupted = true;
                                        }),
                                    ),
                                ),
                        },
                        failing: {
                            extract: () =>
                                Effect.gen(function* extractFailing() {
                                    yield* Deferred.await(started);
                                    return yield* Effect.fail(failure);
                                }),
                        },
                    },
                    framework: { inspect: () => manifest, generate: emitReact, actions: emitActions },
                    output: { forms: 'forms' },
                });
                return yield* Effect.flip(generate(config, { root: exampleRoot }));
            }),
        );
        expect(result).toBe(failure);
        expect(interrupted).toBe(true);
    });

    it('owns scoped driver resources and finalizes them before returning failure', async () => {
        expect.hasAssertions();
        let released = false;
        const failure = new Error('Backend unavailable');
        const config = defineConfig({
            sources: {
                app: {
                    artifacts: () =>
                        Effect.acquireRelease(Effect.succeed([]), () =>
                            Effect.sync(() => {
                                released = true;
                            }),
                        ),
                    extract: () => Effect.fail(failure),
                },
            },
            framework: { inspect: () => manifest, generate: emitReact, actions: emitActions },
            output: { forms: 'forms' },
        });
        const result = await runNode(Effect.flip(generate(config, { root: exampleRoot })));
        expect(result).toBe(failure);
        expect(released).toBe(true);
    });

    it('follows setup and group aliases and rejects incomplete or widened direct registries', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-inspection-'));
        const module = path.join(root, 'forms.ts');
        const declarations = `
function createFieldwork(options: unknown) { return options; }
function withFieldGroup(options: {
    defaultValues: { line1: string; line2: string | null; attachment: File | null; metadata: Record<string, number>; pair: [number, number] };
    props: { label: string };
}) { return (props: { label: string }) => null; }
const TextField = (props: { label: string }) => null;
const addressDefaults: { line1: string; line2: string | null; attachment: File | null; metadata: Record<string, number>; pair: [number, number] } = { line1: '', line2: null, attachment: null, metadata: {}, pair: [0, 0] };
const Address = withFieldGroup({ defaultValues: addressDefaults, props: { label: 'Address' } });
const AddressAlias = Address;
throw new Error('UI modules must not execute');
`;
        try {
            await writeFile(
                module,
                `${declarations}
const registries = { TextField };
const setup = createFieldwork({ fieldComponents: registries, formComponents: {}, fieldGroups: { AddressAlias: AddressAlias } });
export default setup;`,
            );
            const inspected = inspectRegistries('forms.ts', root);
            expect(inspected.fields['TextField']?.props['label']?.required).toBe(true);
            expect(inspected.groups['AddressAlias']).toMatchObject({
                props: { label: { required: false } },
                slots: {
                    line2: { kind: 'union' },
                    attachment: { kind: 'union', alternatives: [{ kind: 'null' }, { kind: 'file' }] },
                    metadata: { kind: 'object', properties: {}, additionalProperties: { kind: 'number' } },
                    pair: { kind: 'array', items: { kind: 'number' }, tuple: true },
                },
            });
            await writeFile(module, `${declarations} export default createFieldwork({ formComponents: {} });`);
            expect(() => inspectRegistries('forms.ts', root)).toThrow('must register fieldComponents');
            await writeFile(
                module,
                `${declarations}
const fields: Record<string, typeof TextField> = { TextField };
export default createFieldwork({ fieldComponents: fields, formComponents: {} });`,
            );
            expect(() => inspectRegistries('forms.ts', root)).toThrow('must retain literal component keys');
            await writeFile(
                module,
                `${declarations} export default createFieldwork({ fieldComponents: { BadField: 42 }, formComponents: {} });`,
            );
            expect(() => inspectRegistries('forms.ts', root)).toThrow('must be a callable React component');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('inspects direct field, form, and group registries without executing UI modules', () => {
        expect.hasAssertions();
        expect(Object.keys(manifest.fields)).toStrictEqual(['TextField', 'CheckboxField']);
        expect(Object.keys(manifest.components)).toStrictEqual(['SubmitButton', 'FormErrors']);
        expect(manifest.groups['AddressAutocomplete']?.slots?.['line2']).toMatchObject({
            kind: 'union',
            alternatives: [{ kind: 'null' }, { kind: 'string' }],
        });
        expect(manifest.groups['AddressAutocomplete']?.props['label']?.required).toBe(false);
    });

    it('rejects unknown components, invalid props, and incompatible or missing group slots', () => {
        expect.hasAssertions();
        expect(() => generateWith(manifest, replaceField('UnknownField', { type: 'email' }))).toThrow(
            'unregistered field',
        );
        expect(() => generateWith(manifest, replaceField('TextField', { type: 'invalid' }))).toThrow(
            'component prop type',
        );
        const narrowGroup: RegistryManifest = {
            ...manifest,
            groups: {
                AddressAutocomplete: { ...address, slots: { ...address.slots, city: { kind: 'literal', value: '' } } },
            },
        };
        expect(() => generateWith(narrowGroup)).toThrow('incompatible field value');
        const missingSlot = {
            ...extraction,
            forms: [
                {
                    ...sourceForm,
                    groups: {
                        address: { ...UpdateProfileRequest.groups.address, fields: { line1: 'address_line_1' } },
                    },
                },
            ],
        };
        expect(() => generateWith(manifest, missingSlot)).toThrow('missing group slot');
        const wrongType = {
            ...extraction,
            forms: [
                {
                    ...sourceForm,
                    groups: {
                        address: {
                            ...UpdateProfileRequest.groups.address,
                            fields: { ...UpdateProfileRequest.groups.address.fields, city: 'newsletter' },
                        },
                    },
                },
            ],
        };
        expect(() => generateWith(manifest, wrongType)).toThrow('incompatible field value');
    });

    it('preserves native file and nullable file group slot compatibility', () => {
        expect.hasAssertions();
        const source: Extraction = {
            ...extraction,
            forms: [
                {
                    ...sourceForm,
                    fields: {
                        ...sourceForm.fields,
                        attachment: {
                            ...sourceForm.fields.email,
                            name: 'attachment',
                            type: 'file',
                            constraints: {},
                            props: {},
                            nullable: true,
                        },
                    },
                    groups: { upload: { component: 'Upload', fields: { file: 'attachment' }, props: {} } },
                },
            ],
        };
        const fileManifest: RegistryManifest = {
            ...manifest,
            groups: {
                Upload: {
                    props: {},
                    slots: { file: { kind: 'union', alternatives: [{ kind: 'null' }, { kind: 'file' }] } },
                },
            },
        };
        expect(generateWith(fileManifest, source)).toHaveLength(1);
        expect(() =>
            generateWith(
                { ...fileManifest, groups: { Upload: { props: {}, slots: { file: { kind: 'file' } } } } },
                source,
            ),
        ).toThrow('incompatible field value');
    });

    it('checks array group slots against wildcard item shapes for reads and writes', () => {
        expect.hasAssertions();
        const numbers = containerSource(
            { value: containerField('value', 'array'), item: containerField('value.*', 'number') },
            [1],
        );
        const numeric: TypeShape = { kind: 'array', items: { kind: 'number' } };
        const strings: TypeShape = { kind: 'array', items: { kind: 'string' } };
        expect(generateWith(containerRegistry(numeric), numbers)[0]?.contents).toContain('"value": Array<number>');
        expect(() => generateWith(containerRegistry(strings), numbers)).toThrow('incompatible field value');
        // Whole-slot writes must also fit the source: a union group could otherwise insert strings.
        expect(() =>
            generateWith(
                containerRegistry({
                    kind: 'array',
                    items: { kind: 'union', alternatives: [{ kind: 'number' }, { kind: 'string' }] },
                }),
                numbers,
            ),
        ).toThrow('incompatible field value');
        expect(() => generateWith(containerRegistry({ ...numeric, tuple: true }), numbers)).toThrow(
            'incompatible field value',
        );
    });

    it('preserves unknown array slots and checks nullable array slots', () => {
        expect.hasAssertions();
        // A broad array has no owned item schema and cannot satisfy a narrower group's readable values.
        const untyped = containerSource({ value: containerField('value', 'array') }, []);
        expect(() => generateWith(containerRegistry({ kind: 'array', items: { kind: 'string' } }), untyped)).toThrow(
            'incompatible field value',
        );
        expect(generateWith(containerRegistry({ kind: 'array', items: { kind: 'unknown' } }), untyped)).toHaveLength(1);
        const numeric: TypeShape = { kind: 'array', items: { kind: 'number' } };
        const nullable = containerSource(
            { value: containerField('value', 'array', true), item: containerField('value.*', 'number') },
            null,
        );
        expect(() => generateWith(containerRegistry(numeric), nullable)).toThrow('incompatible field value');
        expect(
            generateWith(containerRegistry({ kind: 'union', alternatives: [numeric, { kind: 'null' }] }), nullable),
        ).toHaveLength(1);
    });

    it('checks nested object and array shapes rather than empty object samples', async () => {
        expect.hasAssertions();
        const nested = containerSource(
            {
                value: containerField('value', 'object'),
                city: containerField('value.city', 'string'),
                members: containerField('value.members', 'array'),
                active: containerField('value.members.*.active', 'boolean'),
            },
            { city: 'Boston', members: [{ active: true }] },
        );
        const shape: TypeShape = {
            kind: 'object',
            properties: {
                city: { required: true, type: { kind: 'string' } },
                members: {
                    required: true,
                    type: {
                        kind: 'array',
                        items: {
                            kind: 'object',
                            properties: { active: { required: true, type: { kind: 'boolean' } } },
                        },
                    },
                },
            },
        };
        expect(generateWith(containerRegistry(shape), nested)).toHaveLength(1);
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-nested-slots-'));
        try {
            await writeFile(
                path.join(root, 'forms.ts'),
                `
function createFieldwork(options: unknown) { return options; }
function withFieldGroup<T>(options: { defaultValues: T; props: object }) { return (props: object) => null; }
const defaults: { city: string; members: Array<{ active: boolean }> } = { city: '', members: [] };
const Container = withFieldGroup({ defaultValues: { value: defaults }, props: {} });
export default createFieldwork({ fieldComponents: {}, formComponents: {}, fieldGroups: { Container } });
`,
            );
            const inspected = inspectRegistries('forms.ts', root);
            // Includes the checker's boolean union representation inside the array's object items.
            expect(generateWith({ ...manifest, groups: inspected.groups }, nested)).toHaveLength(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
        expect(() =>
            generateWith(
                containerRegistry({
                    ...shape,
                    properties: { ...shape.properties, city: { required: true, type: { kind: 'number' } } },
                }),
                nested,
            ),
        ).toThrow('incompatible field value');
        expect(() =>
            generateWith(
                containerRegistry({
                    kind: 'object',
                    properties: { city: { required: true, type: { kind: 'string' } } },
                }),
                nested,
            ),
        ).toThrow('incompatible field value');
    });

    it('keeps untyped objects broad and rejects narrowed properties, including optional ones', () => {
        expect.hasAssertions();
        const broad = containerSource({ value: containerField('value', 'object') }, {});
        expect(() =>
            generateWith(
                containerRegistry({
                    kind: 'object',
                    properties: { city: { required: true, type: { kind: 'string' } } },
                }),
                broad,
            ),
        ).toThrow('incompatible field value');
        expect(() =>
            generateWith(
                containerRegistry({
                    kind: 'object',
                    properties: { city: { required: false, type: { kind: 'string' } } },
                }),
                broad,
            ),
        ).toThrow('incompatible field value');
        expect(
            generateWith(containerRegistry({ kind: 'object', additionalProperties: { kind: 'unknown' } }), broad),
        ).toHaveLength(1);
    });

    it('generates parent and child bindings that compile through the public React API', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-parent-child-'));
        const generated: Extraction = {
            ...extraction,
            forms: [
                {
                    id: 'ParentChild',
                    defaultValues: { profile: { name: '' } },
                    fields: {
                        profile: containerField('profile', 'object', true),
                        'profile.name': containerField('profile.name', 'string'),
                    },
                    groups: {},
                },
            ],
        };
        try {
            const file = firstGenerated(emitReact(generated, manifest, { root, output: { forms: '.' } }));
            await writeFile(file.path, file.contents);
            const consumer = path.join(root, 'consumer.tsx');
            await writeFile(
                consumer,
                `
import { ParentChild } from './ParentChild.js';
import { createFieldwork } from '@fieldwork/react';
const { Form } = createFieldwork({
    fieldComponents: { TextField: (props: { label: string; constraints: unknown }) => null },
    formComponents: {},
});
export const View = () => <Form form={ParentChild}>{({ fields }) => <><fields.profile /><fields.profile.name /></>}</Form>;
`,
            );
            const program = ts.createProgram([consumer], {
                strict: true,
                exactOptionalPropertyTypes: true,
                skipLibCheck: true,
                noEmit: true,
                jsx: ts.JsxEmit.ReactJSX,
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                paths: {
                    '@fieldwork/core': [path.resolve('packages/core/src/index.ts')],
                    '@fieldwork/react': [path.resolve('packages/react/src/index.ts')],
                    react: [path.resolve('node_modules/@types/react')],
                    'react/jsx-runtime': [path.resolve('node_modules/@types/react/jsx-runtime.d.ts')],
                },
            });
            expect(
                ts
                    .getPreEmitDiagnostics(program)
                    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
            ).toStrictEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('compiles extracted fixed arrays and bracket aliases while preserving numeric object keys', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-fixed-values-'));
        try {
            const fixture = path.join(root, 'extract.php');
            await writeFile(
                fixture,
                `<?php
require ${JSON.stringify(path.resolve('packages/laravel/vendor/autoload.php'))};
$config = require ${JSON.stringify(path.resolve('packages/laravel/config/fieldwork.php'))};
$config['fields']['types']['array'] = 'TextField';
$config['fields']['types']['integer'] = 'TextField';
class FixedValues {
    public function rules(): array {
        return ['rows' => ['array'], 'rows.0.name' => ['string'], 'rows.1.age' => ['integer'],
            'implicit.0.name' => ['string'], 'codes.01.name' => ['string'], 'codes.1.age' => ['integer']];
    }
}
$extracted = (new \\Fieldwork\\Laravel\\RequestExtractor($config))->extract(new FixedValues);
echo json_encode(['version' => 1, 'forms' => [$extracted['form']], 'diagnostics' => $extracted['diagnostics']], JSON_THROW_ON_ERROR);
`,
            );
            const { stdout } = await runNode(exportPhp('php', [fixture], root));
            const extracted = parseExtraction(stdout);
            const source = firstForm(extracted);
            const generated: Extraction = {
                ...extracted,
                forms: [
                    {
                        ...source,
                        fields: {
                            ...source.fields,
                            alias: { ...sourceField(source, 'rows.0.name'), name: 'rows[00].name' },
                        },
                    },
                ],
            };
            const file = firstGenerated(emitReact(generated, manifest, { root, output: { forms: '.' } }));
            await writeFile(file.path, file.contents);
            const consumer = path.join(root, 'consumer.ts');
            await writeFile(
                consumer,
                `
import { FixedValues } from './FixedValues.js';
import { createFormSession } from '@fieldwork/core';
const form = createFormSession({ definition: FixedValues });
form.append('rows', { name: 'next' });
form.append('rows', { age: 42 });
form.append('implicit', { name: 'next' });
form.setValue('rows[00].name', 'name');
form.setValue('codes.01.name', 'literal');
form.setValue('codes.1.age', 42);
FixedValues.defaultValues.rows.map(row => row);
const literal: string = form.getField('codes.01.name').value;
const other: number = form.getField('codes.1.age').value;
// @ts-expect-error A numeric object key stays distinct from its padded sibling.
form.setValue('codes.01.age', 42);
// @ts-expect-error Fixed array children retain their declared input types.
form.setValue('rows[0].name', 42);
export { literal, other };
`,
            );
            const program = ts.createProgram([consumer], {
                strict: true,
                exactOptionalPropertyTypes: true,
                skipLibCheck: true,
                noEmit: true,
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                paths: { '@fieldwork/core': [path.resolve('packages/core/src/index.ts')] },
            });
            expect(
                ts
                    .getPreEmitDiagnostics(program)
                    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
            ).toStrictEqual([]);
            expect(file.contents).toContain('"rows": Array<{ "name": string; } | { "age": number; }>');
            expect(file.contents).toContain('"implicit": Array<{ "name": string; }>');
            expect(file.contents).toContain('"codes": { "01": { "name": string; }; "1": { "age": number; }; }');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('translates Laravel collection options and associative rows into compilable native forms', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-laravel-arrays-'));
        try {
            const fixture = path.join(root, 'extract.php');
            await writeFile(
                fixture,
                `<?php
require ${JSON.stringify(path.resolve('packages/laravel/vendor/autoload.php'))};
$config = require ${JSON.stringify(path.resolve('packages/laravel/config/fieldwork.php'))};
$config['fields']['types']['array'] = 'TextField';
$config['fields']['types']['integer'] = 'TextField';
class CollectionValues {
    public function rules(): array {
        return ['colors' => ['array', 'in:red,blue'], 'ids' => ['array', 'in:1,2'],
            'rows.*.name' => ['required', 'string'], 'rows.*' => ['array', 'min:1', 'max:2'], 'rows' => ['array'],
            'profile.name' => ['string'], 'profile' => ['array'],
            'optional.name' => ['string'], 'optional' => ['nullable', 'array'],
            'codes.01.name' => ['string'], 'codes.1.age' => ['integer'], 'codes' => ['array']];
    }
}
$request = new CollectionValues;
$factory = new \\Illuminate\\Validation\\Factory(new \\Illuminate\\Translation\\Translator(new \\Illuminate\\Translation\\ArrayLoader, 'en'));
if (! $factory->make(['colors' => ['red'], 'ids' => [1, '2'], 'rows' => [['name' => 'Nick']], 'profile' => ['name' => 'Nick'], 'optional' => null], $request->rules())->passes()) {
    throw new Exception('The native regression payload must also pass Laravel validation.');
}
$extracted = (new \\Fieldwork\\Laravel\\RequestExtractor($config))->extract($request);
echo json_encode(['version' => 1, 'forms' => [$extracted['form']], 'diagnostics' => $extracted['diagnostics']], JSON_THROW_ON_ERROR);
`,
            );
            const { stdout } = await runNode(exportPhp('php', [fixture], root));
            const extracted = parseExtraction(stdout);
            const source = firstForm(extracted);
            const decode = Schema.decodeUnknownResult(definitionSchema(source));
            expect(
                Result.isSuccess(
                    decode({
                        colors: ['red'],
                        ids: [1, '2'],
                        rows: [{ name: 'Nick' }],
                        profile: { name: 'Nick' },
                        optional: null,
                    }),
                ),
            ).toBe(true);
            expect(Result.isFailure(decode({ colors: 'red', rows: [{ name: 'Nick', extra: 1, other: 2 }] }))).toBe(
                true,
            );
            const file = firstGenerated(emitReact(extracted, manifest, { root, output: { forms: '.' } }));
            await writeFile(file.path, file.contents);
            const consumer = path.join(root, 'consumer.ts');
            await writeFile(
                consumer,
                `
import { CollectionValues } from './CollectionValues.js';
import { createFormSession } from '@fieldwork/core';
const form=createFormSession({definition:CollectionValues});
form.append('colors','red');
form.append('ids',1);
form.append('ids','2');
form.append('rows',{name:'Nick'});
form.setValue('profile.name','Nick');
form.setValue('optional.name','Nick');
form.setValue('codes.01.name','literal');
form.setValue('codes.1.age',42);
const nullableRead:string|undefined=form.getField('optional.name').value;
// @ts-expect-error Collection options do not permit arbitrary strings.
form.append('colors','green');
// @ts-expect-error A collection option field cannot accept a scalar replacement.
form.setValue('colors','red');
// @ts-expect-error Associative containers retain object shapes.
form.append('profile',{name:'Nick'});
export {nullableRead};
`,
            );
            const program = ts.createProgram([consumer], {
                strict: true,
                exactOptionalPropertyTypes: true,
                skipLibCheck: true,
                noEmit: true,
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                paths: { '@fieldwork/core': [path.resolve('packages/core/src/index.ts')] },
            });
            expect(
                ts
                    .getPreEmitDiagnostics(program)
                    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
            ).toStrictEqual([]);
            expect(file.contents).toContain('"colors": Array<"red" | "blue">');
            expect(file.contents).toContain('"rows": Array<{ "name": string; }>');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('emits public descriptors whose driver bindings survive the portable JSON boundary', () => {
        expect.hasAssertions();
        const form = update.form({ user: 42 });
        const data = parseFormDescriptor(JSON.stringify(form));
        expect(data).toStrictEqual({
            version: 1,
            definition: sourceForm,
            submission: { driver: 'web', binding: { kind: 'http', url: '/users/42', method: 'patch' } },
        });
        const actions = emitActions(
            [
                { name: 'profile.update', schema: sourceForm.id, parameters: [], binding: '{}', imports: [] },
                { name: 'profile.create', schema: sourceForm.id, parameters: [], binding: '{}', imports: [] },
            ],
            extraction,
            { ...context, submission: 'http' },
        );
        const { contents } = firstGenerated(actions);
        expect(contents).toContain('satisfies FormDescriptor<UpdateProfileRequestValues');
        expect(contents).toContain('version: 1 as const');
        expect(contents.match(/import type \{ FormDescriptor \}/gu)).toHaveLength(1);
        expect(contents).not.toContain('bindForm');
    });

    it('emits literal definitions, optional route parameters, and enum blank draft values', () => {
        expect.hasAssertions();
        const files = generateWith(manifest);
        expect(files[0]?.contents).toContain('export interface UpdateProfileRequestValues');
        expect(
            emitActions(
                [
                    {
                        name: 'profile.update',
                        schema: sourceForm.id,
                        parameters: [{ name: 'user' }, { name: 'section', optional: true }],
                        binding: '{ kind: "http" }',
                        imports: [],
                    },
                ],
                extraction,
                { ...context, submission: 'web' },
            )[0]?.contents,
        ).toContain('"section"?: string | number');
        const choice = {
            ...extraction,
            forms: [
                {
                    ...sourceForm,
                    fields: {
                        ...UpdateProfileRequest.fields,
                        email: {
                            ...UpdateProfileRequest.fields.email,
                            type: 'enum' as const,
                            constraints: { options: ['home', 'work'] },
                        },
                    },
                },
            ],
        };
        expect(generateWith(manifest, choice)[0]?.contents).toContain('"home" | "work" | ""');
    });

    it('bootstraps PHP enums before extraction and check mode detects drift without writing', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-generation-'));
        const enumPath = path.join(root, 'FormField.php');
        const extract = vi.fn<() => Effect.Effect<Extraction>>(() =>
            Effect.promise(async () => {
                await expect(readFile(enumPath, 'utf8')).resolves.toContain('case TextField');
                return extraction;
            }),
        );
        const config = {
            sources: {
                app: {
                    extract,
                    artifacts: () =>
                        Effect.succeed([
                            {
                                path: enumPath,
                                contents: '<?php\n// case TextField\n',
                            },
                        ]),
                },
            },
            framework: { inspect: () => manifest, generate: emitReact, actions: emitActions },
            output: {
                forms: 'forms',
                actions: 'actions',
            },
        };
        try {
            const result = await runGeneration(config, { root });
            expect(result.files).toHaveLength(2);
            await expect(runGeneration(config, { root, check: true })).resolves.toMatchObject({ diagnostics: [] });
            const formPath = path.join(root, 'forms/UpdateProfileRequest.ts');
            await writeFile(formPath, '// drift');
            await expect(runGeneration(config, { root, check: true })).rejects.toThrow('Generated files are stale');
            await expect(readFile(formPath, 'utf8')).resolves.toBe('// drift');
            expect(extract).toHaveBeenCalledTimes(3);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('namespaces schema sources and executors and rejects providers for unknown sources', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-multiple-'));
        const config = multipleConfig();
        try {
            const generated = await runGeneration(config, { root });
            expect(generated.files.map((file) => path.relative(root, file))).toStrictEqual([
                'forms/app/UpdateProfileRequest.ts',
                'forms/external/UpdateProfileRequest.ts',
                'actions/web/profile.ts',
                'actions/mutations/profile.ts',
            ]);
            const action = await readFile(path.join(root, 'actions/web/profile.ts'), 'utf8');
            expect(action).toContain("driver: 'web'");
            expect(action).toContain('section?: string | number');
            expect(action).toContain('../../forms/app/UpdateProfileRequest.js');
            await expect(
                runGeneration(
                    { ...config, sources: { external: { extract: () => Effect.succeed(extraction) } } },
                    { root },
                ),
            ).rejects.toThrow('unregistered schema source');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('detects obsolete generated actions in check mode and removes them while preserving application files', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-obsolete-'));
        const config = multipleConfig();
        try {
            await runGeneration(config, { root });
            const handwritten = path.join(root, 'actions/handwritten.ts');
            await writeFile(handwritten, '// Application action');
            const outside = path.join(root, 'outside.ts');
            await writeFile(outside, '// Generated by Fieldwork.\nexport const outside = true;');
            await symlink(outside, path.join(root, 'actions/link.ts'));
            await symlink(path.dirname(outside), path.join(root, 'actions/linked-directory'));
            const next = { ...config, submissions: { web: config.submissions.web } };
            await expect(runGeneration(next, { root, check: true })).rejects.toThrow('Obsolete generated');
            await expect(readFile(path.join(root, 'actions/mutations/profile.ts'), 'utf8')).resolves.toContain(
                'mutation',
            );
            await runGeneration(next, { root });
            await expect(readFile(path.join(root, 'actions/mutations/profile.ts'), 'utf8')).rejects.toThrow('ENOENT');
            await expect(readFile(handwritten, 'utf8')).resolves.toBe('// Application action');

            await expect(runGeneration(next, { root, check: true })).resolves.toMatchObject({ diagnostics: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reads backend enum targets before missing enum case mappings can bootstrap', async () => {
        expect.hasAssertions();
        const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-enums-'));
        const backend = laravel();
        const extract = vi.fn<() => Effect.Effect<Extraction>>(() =>
            Effect.promise(async () => {
                const { stdout } = await runNode(
                    exportPhp(
                        'php',
                        [
                            '-r',
                            "require 'app/Enums/Fields.php'; $config = require 'config/fieldwork.php'; echo $config['fields']['types']['string']->value;",
                        ],
                        root,
                    ),
                );
                expect(stdout).toBe('TextField');
                return extraction;
            }),
        );
        const config = {
            sources: { app: { ...backend, extract } },
            framework: { inspect: () => manifest, generate: emitReact, actions: emitActions },
            output: { forms: 'forms' },
        };
        try {
            await mkdir(path.join(root, 'config'));
            await writeFile(
                path.join(root, 'composer.json'),
                JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
            );
            await writeFile(
                path.join(root, 'config/fieldwork.php'),
                `<?php
use App\\Enums\\Fields;
return ['enums' => ['fields' => Fields::class], 'fields' => ['types' => ['string' => Fields::TextField]]];`,
            );
            await expect(runGeneration(config, { root, check: true })).rejects.toThrow('Generated files are stale');
            expect(extract).not.toHaveBeenCalled();
            await expect(readFile(path.join(root, 'app/Enums/Fields.php'), 'utf8')).rejects.toThrow('ENOENT');
            await runGeneration(config, { root });
            expect(extract).toHaveBeenCalledTimes(1);
            await expect(runGeneration(config, { root, check: true })).resolves.toMatchObject({ diagnostics: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects malformed source exports at the JSON boundary', () => {
        expect.hasAssertions();
        const invalidVersion = Effect.runSync(Effect.flip(parseExtractionEffect('{"version":2}')));
        const invalidJson = JSON.stringify({
            ...extraction,
            forms: [{ ...sourceForm, fields: { broken: { type: 'mystery' } } }],
        });
        const invalidField = Effect.runSync(Effect.flip(parseExtractionEffect(invalidJson)));
        expect(invalidVersion).toBeInstanceOf(Schema.SchemaError);
        expect(invalidField).toBeInstanceOf(Schema.SchemaError);
    });
});
