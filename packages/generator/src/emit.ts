import path from 'node:path';
import { isJsonValue, isRecord, pathSegments } from '@formbraid/core';
import type { Extraction, FieldDefinition, FormDefinition, GroupDefinition, JsonValue } from '@formbraid/core';
import type { GeneratedFile, GeneratedOperation, GenerationContext, RegistryManifest, TypeShape } from './contracts.js';

/** Preserve JSON values without allowing literals to close an enclosing HTML script. */
function sourceLiteral(value: unknown, space?: number): string {
    if (value === undefined) {
        return 'undefined';
    }
    return JSON.stringify(value, null, space)
        .replaceAll('<', String.raw`\u003c`)
        .replaceAll('>', String.raw`\u003e`)
        .replaceAll('\u2028', String.raw`\u2028`)
        .replaceAll('\u2029', String.raw`\u2029`);
}

function accepts(value: JsonValue, type: TypeShape): boolean {
    if (type.kind === 'unknown') {
        return true;
    }
    if (type.kind === 'union') {
        return type.alternatives?.some((alternative) => accepts(value, alternative)) ?? false;
    }
    if (type.kind === 'literal') {
        return type.value === value;
    }
    if (type.kind === 'null') {
        return value === null;
    }
    if (type.kind === 'array') {
        return (
            type.tuple !== true &&
            Array.isArray(value) &&
            (type.items === undefined ||
                value.every((item: JsonValue) => accepts(item, type.items ?? { kind: 'unknown' })))
        );
    }
    if (type.kind === 'object') {
        if (!isRecord(value)) {
            return false;
        }
        return acceptsObject(value, type);
    }
    return typeof value === type.kind;
}

function acceptsObject(value: Record<string, unknown>, type: TypeShape): boolean {
    return (
        Object.entries(type.properties ?? {}).every(
            ([name, prop]) =>
                (!prop.required && !Object.hasOwn(value, name)) ||
                (Object.hasOwn(value, name) && isJsonValue(value[name]) && accepts(value[name], prop.type)),
        ) &&
        Object.entries(value).every(
            ([name, item]) =>
                isJsonValue(item) &&
                (type.additionalProperties === undefined || accepts(item, type.additionalProperties)) &&
                (!numericName(name) || type.numericProperties === undefined || accepts(item, type.numericProperties)),
        )
    );
}

function validateProps(
    name: string,
    values: Readonly<Record<string, JsonValue>>,
    props: RegistryManifest['fields'][string]['props'],
): void {
    for (const [key, value] of Object.entries(values)) {
        const prop = props[key];
        if (prop === undefined) {
            throw new Error(`${name}: unknown component prop ${key}.`);
        }
        if (!accepts(value, prop.type)) {
            throw new Error(`${name}: ${key} does not match the component prop type.`);
        }
    }
    for (const [key, prop] of Object.entries(props)) {
        if (prop.required && !Object.hasOwn(values, key)) {
            throw new Error(`${name}: missing required component prop ${key}.`);
        }
    }
}

function optionValues(options: ReadonlyArray<string | number>): ReadonlyArray<string | number> {
    const values = new Set<string | number>(options);
    for (const option of options) {
        if (typeof option === 'number') {
            values.add(String(option));
        } else {
            const numeric = Number(option);
            if (Number.isFinite(numeric) && String(numeric) === option) {
                values.add(numeric);
            }
        }
    }
    return [...values];
}

function collectionType(field: FieldDefinition): string {
    return field.constraints.options === undefined
        ? 'unknown'
        : optionValues(field.constraints.options)
              .map((option) => sourceLiteral(option))
              .join(' | ') || 'never';
}

function collectionShape(field: FieldDefinition): TypeShape {
    return field.constraints.options === undefined
        ? { kind: 'unknown' }
        : {
              kind: 'union',
              alternatives: optionValues(field.constraints.options).map((value) => ({ kind: 'literal', value })),
          };
}

function baseFieldType(field: FieldDefinition): string {
    switch (field.type) {
        case 'integer':
        case 'number': {
            return 'number';
        }
        case 'boolean': {
            return 'boolean';
        }
        case 'file': {
            return 'File';
        }
        case 'array': {
            return `Array<${collectionType(field)}>`;
        }
        case 'object': {
            return `Record<string, ${collectionType(field)}>`;
        }
        case 'enum': {
            return [...(field.constraints.options?.map((option) => sourceLiteral(option)) ?? ['string']), '""'].join(
                ' | ',
            );
        }
        case 'date':
        case 'string': {
            return 'string';
        }
        default: {
            throw new Error('Unsupported field type.');
        }
    }
}

function fieldType(field: FieldDefinition): string {
    const type = baseFieldType(field);
    return field.nullable || field.type === 'file' ? `${type} | null` : type;
}

/** Structural assignability checks both reads and whole-slot writes without sampling draft values. */
function assignable(source: TypeShape, target: TypeShape): boolean {
    if (source.kind === 'unsupported' || target.kind === 'unsupported') {
        return false;
    }
    if (target.kind === 'unknown') {
        return true;
    }
    if (source.kind === 'union') {
        return source.alternatives?.every((member) => assignable(member, target)) ?? false;
    }
    if (target.kind === 'union') {
        // TypeScript represents boolean slots as the complete union of true and false.
        if (source.kind === 'boolean') {
            return (
                assignable({ kind: 'literal', value: false }, target) &&
                assignable({ kind: 'literal', value: true }, target)
            );
        }
        return assignableUnion(source, target.alternatives ?? []);
    }
    if (source.kind === 'literal') {
        return target.kind === 'literal' ? source.value === target.value : typeof source.value === target.kind;
    }
    if (source.kind !== target.kind) {
        return false;
    }
    if (source.kind === 'array') {
        return assignableArray(source, target);
    }
    if (source.kind === 'object') {
        return assignableObject(source, target);
    }
    return true;
}

function literalVariants(type: TypeShape): ReadonlyArray<TypeShape> | undefined {
    if (type.kind === 'boolean') {
        return [
            { kind: 'literal', value: false },
            { kind: 'literal', value: true },
        ];
    }
    if (type.kind === 'literal' || type.kind === 'null') {
        return [type];
    }
    if (type.kind !== 'union') {
        return undefined;
    }
    const members = type.alternatives?.map(literalVariants);
    return members?.every((member) => member !== undefined) === true ? members.flat() : undefined;
}

/** TypeScript permits a finite discriminant to cover multiple object alternatives (up to 25 combinations). */
function assignableUnion(source: TypeShape, alternatives: ReadonlyArray<TypeShape>): boolean {
    if (alternatives.some((member) => assignable(source, member))) {
        return true;
    }
    if (source.kind !== 'object' || alternatives.some((member) => member.kind !== 'object')) {
        return false;
    }
    let variants = [source];
    for (const [name, property] of Object.entries(source.properties ?? {})) {
        const literals = literalVariants(property.type);
        if (
            property.required &&
            literals !== undefined &&
            literals.length > 1 &&
            alternatives.every((member) => {
                const target = member.properties?.[name];
                return target?.required === true && literalVariants(target.type) !== undefined;
            }) &&
            alternatives.some(
                (member) => !assignable(property.type, member.properties?.[name]?.type ?? { kind: 'unsupported' }),
            )
        ) {
            if (variants.length * literals.length > 25) {
                return false;
            }
            variants = variants.flatMap((variant) => literals.map((type) => objectVariant(variant, name, type)));
        }
    }
    return (
        variants.length > 1 && variants.every((variant) => alternatives.some((member) => assignable(variant, member)))
    );
}

function objectVariant(source: TypeShape, name: string, type: TypeShape): TypeShape {
    return { ...source, properties: { ...source.properties, [name]: { required: true, type } } };
}

function assignableArray(source: TypeShape, target: TypeShape): boolean {
    // Generated wildcard values are dynamic arrays, which cannot guarantee a tuple's positions or length.
    return (
        source.tuple !== true &&
        target.tuple !== true &&
        (source.readonly !== true || target.readonly === true) &&
        assignable(source.items ?? { kind: 'unknown' }, target.items ?? { kind: 'unknown' })
    );
}

function assignableObject(source: TypeShape, target: TypeShape): boolean {
    const sourceProps = source.properties ?? {};
    const targetProps = target.properties ?? {};
    for (const [name, property] of Object.entries(targetProps)) {
        const actual = sourceProps[name];
        if (actual === undefined) {
            const index = numericName(name)
                ? (source.numericProperties ?? source.additionalProperties)
                : source.additionalProperties;
            if (property.required || (index !== undefined && !assignable(index, property.type))) {
                return false;
            }
        } else if ((property.required && !actual.required) || !assignable(actual.type, property.type)) {
            return false;
        }
    }
    return (
        assignableIndex(source, target.additionalProperties, false) &&
        assignableIndex(source, target.numericProperties, true)
    );
}

function numericName(name: string): boolean {
    return name !== '' && String(Number(name)) === name;
}

function assignableIndex(source: TypeShape, index: TypeShape | undefined, numeric: boolean): boolean {
    const effective = numeric ? (source.numericProperties ?? source.additionalProperties) : source.additionalProperties;
    return (
        index === undefined ||
        (Object.entries(source.properties ?? {}).every(([name, property]) =>
            !numeric || numericName(name) ? assignable(property.type, index) : true,
        ) &&
            (effective === undefined ? source.implicitIndex !== false : assignable(effective, index)) &&
            (numeric || source.numericProperties === undefined || assignable(source.numericProperties, index)))
    );
}

function inspectable(type: TypeShape): boolean {
    return (
        type.kind !== 'unsupported' &&
        type.tuple !== true &&
        (type.alternatives?.every(inspectable) ?? true) &&
        (type.items === undefined || inspectable(type.items)) &&
        (type.additionalProperties === undefined || inspectable(type.additionalProperties)) &&
        (type.numericProperties === undefined || inspectable(type.numericProperties)) &&
        Object.values(type.properties ?? {}).every((property) => inspectable(property.type))
    );
}

interface ValueNode {
    readonly children: Map<string, ValueNode>;
    array?: boolean;
    type?: string;
    shape?: TypeShape;
}

function baseFieldShape(field: FieldDefinition): TypeShape {
    switch (field.type) {
        case 'integer':
        case 'number': {
            return { kind: 'number' };
        }
        case 'date':
        case 'string': {
            return { kind: 'string' };
        }
        case 'boolean':
        case 'file': {
            return { kind: field.type };
        }
        case 'array': {
            return { kind: 'array', items: collectionShape(field) };
        }
        case 'object': {
            return { kind: 'object', additionalProperties: collectionShape(field) };
        }
        case 'enum': {
            return field.constraints.options === undefined
                ? { kind: 'string' }
                : {
                      kind: 'union',
                      alternatives: [...field.constraints.options, ''].map((value) => ({ kind: 'literal', value })),
                  };
        }
        default: {
            throw new Error('Unsupported field type.');
        }
    }
}

function fieldShape(field: FieldDefinition): TypeShape {
    const type = baseFieldShape(field);
    return field.nullable || field.type === 'file' ? { kind: 'union', alternatives: [type, { kind: 'null' }] } : type;
}

function valueTree(form: FormDefinition): ValueNode {
    const root: ValueNode = { children: new Map() };
    for (const field of Object.values(form.fields)) {
        let node = root;
        for (const segment of pathSegments(field.name)) {
            let child = node.children.get(segment);
            if (child === undefined) {
                child = { children: new Map() };
                node.children.set(segment, child);
            }
            node = child;
        }
        node.type = fieldType(field);
        node.shape = fieldShape(field);
        if (field.type === 'array' || field.type === 'object') {
            node.array = field.type === 'array';
        }
    }
    resolveContainers(root, [form.defaultValues]);
    return root;
}

function arrayKey(segment: string): string {
    if (!/^\d+$/u.test(segment)) {
        return segment;
    }
    const index = Number(segment);
    if (!Number.isSafeInteger(index)) {
        throw new TypeError(`Invalid array index: ${segment}.`);
    }
    return String(index);
}

function mergeNode(target: ValueNode, incoming: ValueNode): void {
    if (target.type !== undefined && incoming.type !== undefined && target.type !== incoming.type) {
        throw new TypeError('Conflicting types for equivalent field paths.');
    }
    if (incoming.type !== undefined) {
        target.type ??= incoming.type;
    }
    if (incoming.shape !== undefined) {
        target.shape ??= incoming.shape;
    }
    if (incoming.array !== undefined) {
        target.array ??= incoming.array;
    }
    for (const [name, child] of incoming.children) {
        const previous = target.children.get(name);
        if (previous === undefined) {
            target.children.set(name, child);
        } else {
            mergeNode(previous, child);
        }
    }
}

function childSamples(samples: ReadonlyArray<unknown>, segment: string): ReadonlyArray<unknown> {
    return samples.flatMap((sample) => {
        if (segment === '*') {
            const items: ReadonlyArray<unknown> = Array.isArray(sample) ? sample : [];
            return items;
        }
        const key = Array.isArray(sample) ? arrayKey(segment) : segment;
        return typeof sample === 'object' && sample !== null && Object.hasOwn(sample, key)
            ? [Reflect.get(sample, key) as unknown]
            : [];
    });
}

function resolveContainers(node: ValueNode, samples: ReadonlyArray<unknown>): void {
    node.array ??= samples.some((sample) => Array.isArray(sample)) || node.children.has('*');
    if (node.array) {
        const children = [...node.children];
        node.children.clear();
        for (const [segment, child] of children) {
            const key = arrayKey(segment);
            if (key !== '*' && !/^\d+$/u.test(key)) {
                throw new Error(`Invalid array child: ${segment}.`);
            }
            const previous = node.children.get(key);
            if (previous === undefined) {
                node.children.set(key, child);
            } else {
                mergeNode(previous, child);
            }
        }
    }
    for (const [segment, child] of node.children) {
        resolveContainers(child, childSamples(samples, segment));
    }
}

function arrayShapes(node: ValueNode): TypeShape {
    const shapes = new Map<string, TypeShape>();
    for (const child of node.children.values()) {
        shapes.set(renderValues(child), valueShape(child));
    }
    return shapes.size === 1
        ? ([...shapes.values()][0] ?? { kind: 'unknown' })
        : { kind: 'union', alternatives: [...shapes.values()] };
}

function valueShape(node: ValueNode): TypeShape {
    if (node.array === true && node.children.size > 0) {
        return nullableShape(node, { kind: 'array', items: arrayShapes(node) });
    }
    if (node.children.size === 0) {
        return node.shape ?? { kind: 'unknown' };
    }
    return nullableShape(node, {
        kind: 'object',
        properties: Object.fromEntries(
            [...node.children].map(([name, child]) => [name, { required: true, type: valueShape(child) }]),
        ),
    });
}

function nullableShape(node: ValueNode, nested: TypeShape): TypeShape {
    return nullableNode(node) ? { kind: 'union', alternatives: [nested, { kind: 'null' }] } : nested;
}

function nullableNode(node: ValueNode): boolean {
    return node.shape?.kind === 'union' && node.shape.alternatives?.some((type) => type.kind === 'null') === true;
}

function renderValues(node: ValueNode): string {
    if (node.array === true && node.children.size > 0) {
        const items = [...new Set([...node.children.values()].map((child) => renderValues(child)))].join(' | ');
        return `Array<${items}>${nullableNode(node) ? ' | null' : ''}`;
    }
    if (node.children.size > 0) {
        return `{ ${[...node.children].map(([name, child]) => `${sourceLiteral(name)}: ${renderValues(child)};`).join(' ')} }${nullableNode(node) ? ' | null' : ''}`;
    }
    return node.type ?? 'unknown';
}

function nameFor(id: string): string {
    const name = id.split('\\').at(-1) ?? id;
    if (!/^[A-Za-z_]\w*$/u.test(name)) {
        throw new Error(`Invalid generated form name: ${id}`);
    }
    return name;
}

function validateForm(form: FormDefinition, manifest: RegistryManifest): void {
    const values = valueTree(form);
    for (const field of Object.values(form.fields)) {
        const component = manifest.fields[field.component];
        if (component === undefined) {
            throw new Error(`${form.id}.${field.name}: unregistered field component ${field.component}.`);
        }
        validateProps(
            `${form.id}.${field.name}`,
            {
                ...field.props,
                label: field.label,
                ...(field.helpText === undefined ? {} : { helpText: field.helpText }),
                constraints: jsonConstraints(field),
            },
            component.props,
        );
    }
    for (const [name, group] of Object.entries(form.groups)) {
        validateGroup(form, { name, group, values }, manifest);
    }
}

function jsonConstraints(field: FieldDefinition): JsonValue {
    if (!isJsonValue(field.constraints)) {
        throw new Error(`Invalid constraints for ${field.name}.`);
    }
    return field.constraints;
}

function writableGroupNode(values: ValueNode, target: string): ValueNode | undefined {
    let node: ValueNode | undefined = values;
    for (const segment of pathSegments(target)) {
        // Nullable parents and dynamic arrays add undefined to leaf reads while leaf writes remain required.
        if (node === undefined || nullableNode(node) || node.array === true) {
            return undefined;
        }
        node = node.children.get(segment);
    }
    return node;
}

function validateGroup(
    form: FormDefinition,
    binding: { name: string; group: GroupDefinition; values: ValueNode },
    manifest: RegistryManifest,
): void {
    const { name, group, values } = binding;
    const component = manifest.groups[group.component];
    if (component === undefined) {
        throw new Error(`${form.id}.${name}: unregistered group ${group.component}.`);
    }
    validateProps(
        `${form.id}.${name}`,
        {
            ...group.props,
            ...(group.label === undefined ? {} : { label: group.label }),
            ...(group.helpText === undefined ? {} : { helpText: group.helpText }),
        },
        component.props,
    );
    if (component.slots === undefined) {
        throw new Error(
            `${group.component}: group slots could not be inspected. Export a group created with withFieldGroup({ defaultValues, ... }).`,
        );
    }
    for (const slot of Object.keys(component.slots)) {
        if (!Object.hasOwn(group.fields, slot)) {
            throw new Error(`${form.id}.${name}: missing group slot ${slot}.`);
        }
    }
    for (const [slot, target] of Object.entries(group.fields)) {
        const slotType = component.slots[slot];
        const field = Object.values(form.fields).find((candidate) => candidate.name === target);
        if (slotType === undefined || field === undefined) {
            throw new Error(`${form.id}.${name}: invalid group slot or field ${slot}: ${target}.`);
        }
        const node = writableGroupNode(values, target);
        if (
            target.includes('*') ||
            node === undefined ||
            !inspectable(slotType) ||
            !assignable(valueShape(node), slotType) ||
            !assignable(slotType, valueShape(node))
        ) {
            throw new Error(`${form.id}.${name}.${slot}: incompatible field value type for ${target}.`);
        }
    }
}

export function emitReact(
    extraction: Extraction,
    manifest: RegistryManifest,
    context: GenerationContext,
): ReadonlyArray<GeneratedFile> {
    const names = new Set<string>();
    const files: Array<GeneratedFile> = [];
    for (const form of extraction.forms) {
        validateForm(form, manifest);
        const name = nameFor(form.id);
        if (names.has(name)) {
            throw new Error(`Duplicate generated form filename: ${name}.`);
        }
        names.add(name);
        const body = sourceLiteral(form, 4);
        files.push({
            path: path.resolve(context.root, context.output.forms, context.source ?? '.', `${name}.ts`),
            contents: `// Generated by Formbraid. Edit the FormRequest or configuration.\nimport { defineForm } from '@formbraid/core';\n\nexport interface ${name}Values ${renderValues(valueTree(form))}\n\nexport const ${name} = defineForm<${name}Values>()(${body});\n`,
        });
    }
    return files;
}

function renderImports(lines: ReadonlyArray<string>): string {
    const named = new Map<string, Set<string>>();
    const other = new Set<string>();
    for (const line of lines) {
        const match = /^import \{(?<names>[^}]+)\} from (?<module>['"][^'"]+['"]);$/u.exec(line);
        const module = match?.groups?.['module'];
        const names = match?.groups?.['names'];
        if (module === undefined || names === undefined) {
            other.add(line);
        } else {
            const imports = named.get(module) ?? new Set<string>();
            for (const name of names.split(',')) {
                imports.add(name.trim());
            }
            named.set(module, imports);
        }
    }
    return [
        ...[...named].map(([module, imports]) => `import { ${[...imports].join(', ')} } from ${module};`),
        ...other,
    ].join('\n');
}

export function emitActions(
    operations: ReadonlyArray<GeneratedOperation>,
    extraction: Extraction,
    context: GenerationContext,
): ReadonlyArray<GeneratedFile> {
    if (operations.length > 0 && context.output.actions === undefined) {
        throw new Error('Submission operations require output.actions.');
    }
    const files: Array<GeneratedFile> = [];
    if (context.output.actions !== undefined) {
        const actions = new Map<string, Array<string>>();
        for (const operation of operations) {
            if (!extraction.forms.some((form) => form.id === operation.schema)) {
                throw new Error(`Operation ${operation.name} references an unknown schema ${operation.schema}.`);
            }
            const formName = nameFor(operation.schema);
            const actionName = operation.name.split('.').at(-1) ?? operation.name;
            const groupName = operation.name.split('.').slice(0, -1).join('.') || 'operations';
            if (
                !/^[\w.-]+$/u.test(groupName) ||
                !/^[A-Za-z_]\w*$/u.test(actionName) ||
                groupName.split('.').some((segment) => segment === '')
            ) {
                throw new Error(`Unsupported action name: ${operation.name}`);
            }
            let relative = path
                .relative(
                    path.resolve(context.root, context.output.actions),
                    path.resolve(context.root, context.output.forms, context.source ?? '.', `${formName}.js`),
                )
                .split(path.sep)
                .join('/');
            if (!relative.startsWith('.')) {
                relative = `./${relative}`;
            }
            const parameterType = `{ ${operation.parameters
                .map(
                    (parameter) =>
                        `${sourceLiteral(parameter.name)}${parameter.optional === true ? '?' : ''}: string | number;`,
                )
                .join(' ')} }`;
            const bound = `({ version: 1 as const, definition: ${formName}, submission: { driver: ${sourceLiteral(context.submission)}, binding: ${operation.binding} } } satisfies FormDescriptor<${formName}Values, typeof ${formName}.fields, typeof ${formName}.groups>)`;
            const expression =
                operation.parameters.length === 0 ? `() => ${bound}` : `(parameters: ${parameterType}) => ${bound}`;
            const entries = actions.get(groupName) ?? [];
            if (entries.some((entry) => entry.includes(`export const ${actionName} =`))) {
                throw new Error(`Duplicate generated action: ${operation.name}`);
            }
            entries.push(
                `import { ${formName} } from ${sourceLiteral(relative)};\nimport type { ${formName}Values } from ${sourceLiteral(relative)};\n${operation.imports.join('\n')}\nexport const ${actionName} = { form: ${expression} };`,
            );
            actions.set(groupName, entries);
        }
        for (const [name, entries] of actions) {
            files.push({
                path: path.resolve(context.root, context.output.actions, `${name}.ts`),
                contents: `// Generated by Formbraid.\n${renderImports(["import type { FormDescriptor } from '@formbraid/core';", ...entries.flatMap((entry) => entry.split('\n').filter((line) => line.startsWith('import ')))])}\n\n${entries.flatMap((entry) => entry.split('\n').filter((line) => !line.startsWith('import '))).join('\n')}\n`,
            });
        }
    }
    return files;
}
