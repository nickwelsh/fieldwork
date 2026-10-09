import { pathSegments, resolveConstraints } from '@fieldwork/core';
import type { FieldDefinition, FormDefinition, FormState, GroupDefinition } from '@fieldwork/core';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { ComponentRegistry, LayoutBindings } from './types.js';
import type { FormApi } from './form-api.js';
import { FieldContext, useSelection } from './hooks.js';

export interface RuntimeInstance {
    readonly definition: FormDefinition;
    readonly form: FormApi<Record<string, unknown>>;
    readonly fieldComponents: ComponentRegistry;
    readonly formComponents: ComponentRegistry;
}

export interface RuntimeBindings {
    readonly fields: Record<string, unknown>;
    readonly components: Record<string, ComponentType<Record<string, unknown>>>;
    readonly groups: Record<string, ComponentType<Record<string, unknown>>>;
    readonly automatic: ReadonlyArray<{
        readonly key: string;
        readonly component: ComponentType<Record<string, unknown>>;
    }>;
}

export interface BindingIdentityCache {
    readonly fields: Map<string, ComponentType<Record<string, unknown>>>;
    readonly containers: Map<string, ComponentType<Record<string, unknown>>>;
    readonly groups: Map<string, ComponentType<Record<string, unknown>>>;
    readonly components: Map<string, ComponentType<Record<string, unknown>>>;
}

export const InstanceContext = createContext<RuntimeInstance | null>(null);

function useInstance(): RuntimeInstance {
    const instance = useContext(InstanceContext);
    if (instance === null) {
        throw new Error('A bound Fieldwork component must be rendered inside its Form.');
    }
    return instance;
}

function registered(registry: ComponentRegistry, name: string): unknown {
    return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

function renderComponent(component: unknown, props: Record<string, unknown>): ReactNode {
    if (typeof component !== 'function' && (typeof component !== 'object' || component === null)) {
        throw new Error('The requested component is not registered with Fieldwork.');
    }
    // Registry lookup is the single dynamic boundary; public bindings retain each component's exact props.
    return createElement(component as ComponentType<Record<string, unknown>>, props);
}

function makeField(key: string): ComponentType<Record<string, unknown>> {
    return function BoundField(overrides): ReactNode {
        const { definition, form } = useInstance();
        const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
        if (field === undefined) {
            throw new Error(`Unknown field: ${key}`);
        }
        const context = useMemo(() => ({ session: form.session, name: field.name }), [form, field.name]);
        const selectRequired = useMemo(
            () => (state: FormState<Record<string, unknown>>) =>
                resolveConstraints(field.constraints, state.values).required,
            [field.constraints],
        );
        const required = useSelection(form.session, selectRequired);
        const instance = useInstance();
        return (
            <FieldContext value={context}>
                {renderComponent(registered(instance.fieldComponents, field.component), {
                    ...field.props,
                    label: field.label,
                    ...(field.helpText === undefined ? {} : { helpText: field.helpText }),
                    constraints: { ...field.constraints, required },
                    ...overrides,
                })}
            </FieldContext>
        );
    };
}

function makeComponent(name: string): ComponentType<Record<string, unknown>> {
    return function BoundComponent(props): ReactNode {
        const { formComponents } = useInstance();
        return renderComponent(registered(formComponents, name), props);
    };
}

function makeGroup(name: string, registry: ComponentRegistry): ComponentType<Record<string, unknown>> {
    return function BoundGroup(overrides): ReactNode {
        const { definition, form } = useInstance();
        const group = Object.hasOwn(definition.groups, name) ? definition.groups[name] : undefined;
        if (group === undefined) {
            throw new Error(`Unknown group: ${name}`);
        }
        return renderComponent(registered(registry, group.component), {
            ...group.props,
            ...(group.label === undefined ? {} : { label: group.label }),
            ...(group.helpText === undefined ? {} : { helpText: group.helpText }),
            ...overrides,
            form,
            fields: group.fields,
        });
    };
}

interface FieldNode {
    readonly children: Map<string, FieldNode>;
    field?: { readonly name: string; readonly component: ComponentType<Record<string, unknown>> };
}

function insertField(tree: FieldNode, path: string, component: ComponentType<Record<string, unknown>>): void {
    const segments = pathSegments(path);
    let node = tree;
    for (const segment of segments) {
        let child = node.children.get(segment);
        if (child === undefined) {
            child = { children: new Map() };
            node.children.set(segment, child);
        }
        node = child;
    }
    if (node.field !== undefined) {
        throw new Error(`Duplicate bound field path: ${path}`);
    }
    node.field = { name: path, component };
}

function fieldTree(
    node: FieldNode,
    identities: BindingIdentityCache,
    enumerable = true,
): { readonly binding: unknown; readonly paths: ReadonlyArray<string> } {
    // Sorting makes identities independent of definition field order.
    const entries = [...node.children];
    // oxlint-disable-next-line unicorn/no-array-sort -- Map entries own this new array; ES2022 is the package target.
    entries.sort(([left], [right]) => left.localeCompare(right));
    const children = entries.map(
        ([name, child]) => [name, fieldTree(child, identities, name !== 'defaultProps')] as const,
    );
    const paths = [
        ...(node.field === undefined ? [] : [node.field.name]),
        ...children.flatMap(([, child]) => child.paths),
    ];
    const properties: Record<string, unknown> = {};
    for (const [name, child] of children) {
        // React enumerates type.defaultProps when constructing an element. A data
        // namespace with that name must expose its bindings without injecting props.
        Object.defineProperty(properties, name, { value: child.binding, enumerable });
    }
    if (node.field === undefined) {
        return { binding: Object.freeze(properties), paths };
    }
    const { component } = node.field;
    if (children.length === 0) {
        return { binding: component, paths };
    }
    const binding = cached(identities.containers, JSON.stringify(paths), () => {
        function BoundContainer(props: Record<string, unknown>): ReactNode {
            return createElement(component, props);
        }
        // Keep each layout's child properties immutable. Attaching them to the shared
        // field component would let suspended renders change another layout's tree.
        for (const [name, child] of children) {
            Object.defineProperty(BoundContainer, name, { value: child.binding, enumerable });
        }
        return Object.freeze(BoundContainer);
    });
    return { binding, paths };
}

function cached(
    cache: Map<string, ComponentType<Record<string, unknown>>>,
    name: string,
    create: () => ComponentType<Record<string, unknown>>,
): ComponentType<Record<string, unknown>> {
    let component = cache.get(name);
    if (component === undefined) {
        component = create();
        cache.set(name, component);
    }
    return component;
}

/** Rebuild layout membership while retaining component identities for unchanged names. */
export function createBindings(
    definition: FormDefinition,
    options: {
        readonly components: ReadonlyArray<string>;
        readonly registry: ComponentRegistry;
        readonly identities: BindingIdentityCache;
        readonly submitComponent?: string;
    },
): RuntimeBindings {
    const { components, registry, submitComponent, identities } = options;
    const tree: FieldNode = { children: new Map() };
    const flat = new Map<string, ComponentType<Record<string, unknown>>>();
    for (const [name, field] of Object.entries(definition.fields).filter(
        ([, candidate]) => !candidate.name.includes('*'),
    )) {
        const component = cached(identities.fields, name, () => makeField(name));
        insertField(tree, name, component);
        flat.set(field.name, component);
    }
    const groups = Object.fromEntries(
        Object.keys(definition.groups).map((name) => [
            name,
            cached(identities.groups, name, () => makeGroup(name, registry)),
        ]),
    );
    const formComponents = Object.fromEntries(
        components.map((name) => [name, cached(identities.components, name, () => makeComponent(name))]),
    );
    const membership = new Map<string, string>();
    for (const [name, group] of Object.entries(definition.groups)) {
        for (const path of Object.values(group.fields)) {
            membership.set(path, name);
        }
    }
    const placed = new Set<string>();
    const automatic: Array<{ readonly key: string; readonly component: ComponentType<Record<string, unknown>> }> = [];
    for (const field of Object.values<FieldDefinition>(definition.fields)) {
        const groupName = membership.get(field.name);
        const component = groupName === undefined ? flat.get(field.name) : groups[groupName];
        const identity = groupName === undefined ? `field:${field.name}` : `group:${groupName}`;
        if (component !== undefined && !placed.has(identity)) {
            automatic.push({ key: identity, component });
            placed.add(identity);
        }
    }
    if (submitComponent !== undefined && formComponents[submitComponent] !== undefined) {
        automatic.push({ key: `component:${submitComponent}`, component: formComponents[submitComponent] });
    }
    const fields = fieldTree(tree, identities).binding as Record<string, unknown>;
    return { fields, groups, components: formComponents, automatic };
}

export function eraseInstance(instance: unknown): RuntimeInstance {
    return instance as RuntimeInstance;
}
export function typedBindings<
    TFields extends Readonly<Record<string, FieldDefinition>>,
    TGroups extends Readonly<Record<string, GroupDefinition>>,
    TFieldComponents extends ComponentRegistry,
    TComponents extends ComponentRegistry,
    TGroupComponents extends ComponentRegistry,
>(bindings: RuntimeBindings): LayoutBindings<TFields, TGroups, TFieldComponents, TComponents, TGroupComponents> {
    return bindings as unknown as LayoutBindings<TFields, TGroups, TFieldComponents, TComponents, TGroupComponents>;
}
