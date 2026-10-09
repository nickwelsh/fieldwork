import path from 'node:path';
import ts from 'typescript-api';
import type { ComponentInfo, ModuleExport, PropShape, RegistryManifest, TypeShape } from './contracts.js';

interface Session {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    readonly root: string;
}
interface ShapeContext {
    readonly checker: ts.TypeChecker;
    readonly location: ts.Node;
    readonly ancestors?: ReadonlySet<ts.Type>;
}

function isSequence(type: ts.Type, checker: ts.TypeChecker): boolean {
    return checker.isArrayType(type) || checker.isTupleType(type);
}

/** Interfaces and classes require explicit index signatures; anonymous object types can infer them. */
function hasImplicitIndex(type: ts.Type): boolean {
    if (type.isIntersection()) {
        return type.types.every(hasImplicitIndex);
    }
    const flags = type.getSymbol()?.flags ?? 0;
    return (
        !(flags & ts.SymbolFlags.Class) &&
        Boolean(flags & (ts.SymbolFlags.ObjectLiteral | ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ValueModule)) &&
        type.getCallSignatures().length === 0 &&
        type.getConstructSignatures().length === 0
    );
}

function shape(type: ts.Type, context: ShapeContext): TypeShape {
    const { checker } = context;
    const primitive = primitiveShape(type, checker);
    if (primitive !== undefined) {
        return primitive;
    }
    if (context.ancestors?.has(type) === true) {
        return { kind: 'unsupported' };
    }
    const nested = { ...context, ancestors: new Set(context.ancestors).add(type) };
    if (type.isUnion()) {
        return {
            kind: 'union',
            alternatives: type.types.map((member) => shape(member, nested)),
        };
    }
    if (type.getCallSignatures().length > 0) {
        return { kind: 'function' };
    }
    if (isSequence(type, checker)) {
        const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        return {
            kind: 'array',
            items: item === undefined ? { kind: 'unsupported' } : shape(item, nested),
            ...(checker.isTupleType(type) ? { tuple: true } : {}),
            ...(type.getSymbol()?.name === 'ReadonlyArray' ? { readonly: true } : {}),
        };
    }
    if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
        if (
            checker
                .getIndexInfosOfType(type)
                .some((index) => !(index.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number)))
        ) {
            return { kind: 'unsupported' };
        }
        const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
        const numeric = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        const properties = Object.fromEntries(
            type.getProperties().map((property) => [
                property.name,
                {
                    required: !(property.flags & ts.SymbolFlags.Optional),
                    type: propertyShape(property, nested),
                },
            ]),
        );
        return {
            kind: 'object',
            properties,
            ...(index === undefined ? {} : { additionalProperties: shape(index, nested) }),
            ...(numeric === undefined ? {} : { numericProperties: shape(numeric, nested) }),
            ...(hasImplicitIndex(type) ? {} : { implicitIndex: false }),
        };
    }
    return { kind: 'unsupported' };
}

function primitiveShape(type: ts.Type, checker: ts.TypeChecker): TypeShape | undefined {
    if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) {
        return { kind: 'unknown' };
    }
    if (type.flags & ts.TypeFlags.Undefined) {
        return { kind: 'undefined' };
    }
    if (type.flags & ts.TypeFlags.EnumLike) {
        return { kind: 'unsupported' };
    }
    if (type.isStringLiteral() || type.isNumberLiteral()) {
        return { kind: 'literal', value: type.value };
    }
    if (type.flags & ts.TypeFlags.String) {
        return { kind: 'string' };
    }
    if (type.flags & ts.TypeFlags.Number) {
        return { kind: 'number' };
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
        return { kind: 'literal', value: checker.typeToString(type) === 'true' };
    }
    if (type.flags & ts.TypeFlags.BooleanLike) {
        return { kind: 'boolean' };
    }
    if (type.flags & ts.TypeFlags.Null) {
        return { kind: 'null' };
    }
    const symbol = type.getSymbol();
    if (symbol?.name === 'File' && symbol.declarations?.some((node) => node.getSourceFile().hasNoDefaultLib) === true) {
        return { kind: 'file' };
    }
    return undefined;
}

/** Optional absence is a property flag; explicit undefined remains a writable value. */
function propertyShape(property: ts.Symbol, context: ShapeContext): TypeShape {
    const type = context.checker.getTypeOfSymbol(property);
    if (property.flags & ts.SymbolFlags.Optional) {
        const members = (type.isUnion() ? type.types : [type]).filter(
            (member) => !(member.flags & ts.TypeFlags.Undefined) || member === context.checker.getUndefinedType(),
        );
        if (members.length === 0) {
            return { kind: 'unsupported' };
        }
        const [first] = members;
        if (members.length === 1 && first !== undefined) {
            return shape(first, context);
        }
        return { kind: 'union', alternatives: members.map((member) => shape(member, context)) };
    }
    return shape(type, context);
}

function exported(
    reference: ModuleExport,
    session: Session,
): { symbol: ts.Symbol; node: ts.SourceFile; type: ts.Type } {
    const { root, checker, program } = session;
    const filename = path.resolve(root, reference.module);
    const node = program.getSourceFile(filename);
    if (node === undefined) {
        throw new Error(`Cannot inspect module ${filename}.`);
    }
    const module = checker.getSymbolAtLocation(node);
    const symbol =
        module === undefined
            ? undefined
            : checker.getExportsOfModule(module).find((candidate) => candidate.name === reference.export);
    if (symbol === undefined) {
        throw new Error(`${reference.module} does not export ${reference.export}.`);
    }
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return {
        symbol: resolved,
        node,
        type: checker.getTypeOfSymbolAtLocation(resolved, resolved.valueDeclaration ?? node),
    };
}

function initializerOf(component: ts.Symbol, checker: ts.TypeChecker): ts.Expression | undefined {
    const declaration =
        component.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(component).valueDeclaration
            : component.valueDeclaration;
    if (declaration !== undefined && ts.isVariableDeclaration(declaration)) {
        return declaration.initializer;
    }
    if (declaration !== undefined && ts.isPropertyAssignment(declaration)) {
        return declaration.initializer;
    }
    if (declaration !== undefined && ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration;
        if (value !== undefined && ts.isVariableDeclaration(value)) {
            return value.initializer;
        }
    }
    return undefined;
}

function callName(call: ts.CallExpression, checker: ts.TypeChecker): string {
    const symbol = checker.getSymbolAtLocation(call.expression);
    return symbol === undefined
        ? (call.expression.getText().split('.').at(-1) ?? '')
        : (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).name;
}

function groupSlots(
    component: ts.Symbol,
    checker: ts.TypeChecker,
    props: Record<string, PropShape>,
): Record<string, TypeShape> | undefined {
    const declared = initializerOf(component, checker);
    const initializer = declared === undefined ? undefined : expressionOf(declared, checker);
    if (
        initializer === undefined ||
        !ts.isCallExpression(initializer) ||
        callName(initializer, checker) !== 'withFieldGroup'
    ) {
        return undefined;
    }
    const [argument] = initializer.arguments;
    if (argument === undefined) {
        return undefined;
    }
    const argumentType = checker.getTypeAtLocation(argument);
    const defaults = argumentType.getProperty('defaultValues');
    if (defaults === undefined) {
        return undefined;
    }
    const defaultsProps = argumentType.getProperty('props');
    if (defaultsProps !== undefined) {
        for (const property of checker.getTypeOfSymbolAtLocation(defaultsProps, argument).getProperties()) {
            const existing = props[property.name];
            if (existing !== undefined) {
                props[property.name] = { ...existing, required: false };
            }
        }
    }
    return Object.fromEntries(
        checker
            .getTypeOfSymbolAtLocation(defaults, argument)
            .getProperties()
            .map((slot) => [
                slot.name,
                shape(checker.getTypeOfSymbolAtLocation(slot, slot.valueDeclaration ?? argument), {
                    checker,
                    location: argument,
                }),
            ]),
    );
}

function componentInfo(component: ts.Symbol, checker: ts.TypeChecker, node: ts.SourceFile): ComponentInfo {
    if (!/^[A-Z]\w*$/u.test(component.name) || ['AppField', 'AppForm', 'Field', 'Subscribe'].includes(component.name)) {
        throw new Error(`Invalid or reserved component key: ${component.name}. Use a PascalCase component name.`);
    }
    const location = component.valueDeclaration ?? node;
    const type = checker.getTypeOfSymbolAtLocation(component, location);
    const [signature] = type.getCallSignatures();
    if (signature === undefined) {
        throw new Error(`${component.name} must be a callable React component.`);
    }
    const [parameter] = signature.getParameters();
    const propsType = parameter === undefined ? undefined : checker.getTypeOfSymbolAtLocation(parameter, location);
    const props: Record<string, PropShape> = {};
    for (const prop of propsType
        ?.getProperties()
        .filter((property) => !['form', 'fields', 'children'].includes(property.name)) ?? []) {
        props[prop.name] = {
            required: !(prop.flags & ts.SymbolFlags.Optional),
            type: propertyShape(prop, {
                checker,
                location,
            }),
        };
    }
    const slots = groupSlots(component, checker, props);
    return { props, ...(slots === undefined ? {} : { slots }) };
}

function expressionOf(expression: ts.Expression, checker: ts.TypeChecker, seen = new Set<ts.Node>()): ts.Expression {
    if (seen.has(expression)) {
        throw new Error('Circular form setup reference.');
    }
    seen.add(expression);
    if (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isSatisfiesExpression(expression)
    ) {
        return expressionOf(expression.expression, checker, seen);
    }
    if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
        let symbol = checker.getSymbolAtLocation(expression);
        if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
            symbol = checker.getAliasedSymbol(symbol);
        }
        const declaration = symbol?.valueDeclaration;
        if (declaration !== undefined && ts.isExportAssignment(declaration)) {
            return expressionOf(declaration.expression, checker, seen);
        }
        const initializer = symbol === undefined ? undefined : initializerOf(symbol, checker);
        if (initializer !== undefined) {
            return expressionOf(initializer, checker, seen);
        }
    }
    return expression;
}

function option(expression: ts.Expression, name: string, checker: ts.TypeChecker): ts.Expression | undefined {
    const resolved = expressionOf(expression, checker);
    if (!ts.isObjectLiteralExpression(resolved)) {
        throw new Error('Form setup options must be a statically inspectable object literal.');
    }
    const property = resolved.properties.find(
        (candidate) =>
            (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
            candidate.name.getText() === name,
    );
    if (property !== undefined && ts.isPropertyAssignment(property)) {
        return property.initializer;
    }
    if (property !== undefined && ts.isShorthandPropertyAssignment(property)) {
        return property.name;
    }
    return undefined;
}

function callOptions(expression: ts.Expression, checker: ts.TypeChecker, name: string): ts.Expression {
    const resolved = expressionOf(expression, checker);
    if (!ts.isCallExpression(resolved) || callName(resolved, checker) !== name || resolved.arguments[0] === undefined) {
        throw new Error(`Expected a statically inspectable ${name}({...}) setup.`);
    }
    return resolved.arguments[0];
}

function registry(expression: ts.Expression | undefined, session: Session): Record<string, ComponentInfo> {
    if (expression === undefined) {
        return {};
    }
    const type = session.checker.getTypeAtLocation(expression);
    if (type.getStringIndexType() !== undefined) {
        throw new Error('Registries must retain literal component keys; a broad Record cannot generate an enum.');
    }
    return Object.fromEntries(
        type
            .getProperties()
            .map((component) => [
                component.name,
                componentInfo(component, session.checker, expression.getSourceFile()),
            ]),
    );
}

export function inspectRegistries(module: string, root: string): RegistryManifest {
    const configPath = ts.findConfigFile(root, (filename) => ts.sys.fileExists(filename));
    let compilerOptions: ts.CompilerOptions = {
        strict: true,
        jsx: ts.JsxEmit.ReactJSX,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
    };
    if (configPath !== undefined) {
        const config = ts.readConfigFile(configPath, (filename) => ts.sys.readFile(filename));
        if (config.error !== undefined) {
            throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
        }
        compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options;
    }
    const program = ts.createProgram([path.resolve(root, module)], compilerOptions);
    const session = { program, checker: program.getTypeChecker(), root };
    const setup = exported({ module, export: 'default' }, session);
    const declaration = setup.symbol.valueDeclaration;
    const expression =
        declaration !== undefined && ts.isExportAssignment(declaration)
            ? declaration.expression
            : initializerOf(setup.symbol, session.checker);
    if (expression === undefined) {
        throw new Error('The form module must default-export its createFieldwork setup.');
    }
    const options = callOptions(expression, session.checker, 'createFieldwork');
    const fields = option(options, 'fieldComponents', session.checker);
    const components = option(options, 'formComponents', session.checker);
    const groups = option(options, 'fieldGroups', session.checker);
    if (fields === undefined || components === undefined) {
        throw new Error('createFieldwork must register fieldComponents and formComponents.');
    }
    return {
        fields: registry(fields, session),
        components: registry(components, session),
        groups: registry(groups, session),
    };
}
