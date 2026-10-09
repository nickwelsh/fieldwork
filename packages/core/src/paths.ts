import type { FieldDefinition } from './contracts.js';

const forbiddenSegments = new Set(['__proto__', 'constructor', 'prototype']);

export function isPathSegment(segment: string): boolean {
    return /^[^.[\]]+$/u.test(segment) && !forbiddenSegments.has(segment);
}

export function pathSegments(path: string): Array<string> {
    if (!/^(?:[^.[\]]+|\[\d+\])(?:\.[^.[\]]+|\[\d+\])*$/u.test(path)) {
        throw new Error(`Invalid field path: ${path}`);
    }
    const dotted = path.replaceAll(/\[(?<index>\d+)\]/gu, '.$<index>');
    const segments = (path.startsWith('[') ? dotted.slice(1) : dotted).split('.');
    // The path grammar already validates segment syntax; only reserved keys need another check.
    if (segments.some((segment) => forbiddenSegments.has(segment))) {
        throw new Error(`Invalid field path: ${path}`);
    }
    return segments;
}

export function normalizeSegment(segment: string, isArray: boolean): string {
    if (isArray && /^\d+$/u.test(segment)) {
        const index = Number(segment);
        if (!Number.isSafeInteger(index)) {
            throw new TypeError(`Invalid array index: ${segment}`);
        }
        return String(index);
    }
    return segment;
}

export function getValue(values: unknown, path: string): unknown {
    let value = values;
    for (const part of pathSegments(path)) {
        const segment = normalizeSegment(part, Array.isArray(value));
        if (typeof value !== 'object' || value === null || !Object.hasOwn(value, segment)) {
            return undefined;
        }
        value = Reflect.get(value, segment) as unknown;
    }
    return value;
}

export function normalizePath(
    path: string,
    values?: unknown,
    isAbsentArray?: (prefix: ReadonlyArray<string>) => boolean,
): string {
    const prefix: Array<string> = [];
    let value = values;
    for (const part of pathSegments(path)) {
        const array =
            Array.isArray(value) || ((value === null || value === undefined) && isAbsentArray?.(prefix) === true);
        const segment = normalizeSegment(part, array);
        prefix.push(segment);
        value =
            typeof value === 'object' && value !== null && Object.hasOwn(value, segment)
                ? (Reflect.get(value, segment) as unknown)
                : undefined;
    }
    return prefix.join('.');
}

/** Infer absent containers from declared defaults and Laravel field metadata. */
export function definitionArrayAt(
    definition: { readonly defaultValues: object; readonly fields: Readonly<Record<string, FieldDefinition>> },
    prefix: ReadonlyArray<string>,
): boolean {
    const fields = Object.values(definition.fields).map((field) => ({ field, parts: pathSegments(field.name) }));
    const inferred = new Map<string, boolean>();
    const arrayAt = (current: ReadonlyArray<string>): boolean => {
        const path = current.join('.');
        const cached = inferred.get(path);
        if (cached !== undefined) {
            return cached;
        }
        if (path !== '' && Array.isArray(getValue(definition.defaultValues, path))) {
            inferred.set(path, true);
            return true;
        }
        let wildcardArray = false;
        for (const { field, parts } of fields) {
            const matches = current.every((segment, i) => {
                const part = parts[i];
                if (part === undefined) {
                    return false;
                }
                if (part === segment || part === '*') {
                    return true;
                }
                // Parent prefixes are strictly shorter; memoization bounds shared metadata lookups.
                const array = arrayAt(current.slice(0, i));
                return normalizeSegment(part, array) === normalizeSegment(segment, array);
            });
            if (matches) {
                if (parts.length === current.length && (field.type === 'array' || field.type === 'object')) {
                    const array = field.type === 'array';
                    inferred.set(path, array);
                    return array;
                }
                wildcardArray ||= parts[current.length] === '*';
            }
        }
        inferred.set(path, wildcardArray);
        return wildcardArray;
    };
    return arrayAt(prefix);
}

export function titleCase(path: string): string {
    let segment = path;
    for (const part of pathSegments(path)) {
        if (!/^\d+$/u.test(part)) {
            segment = part;
        }
    }
    return segment
        .replaceAll(/(?<lower>[a-z\d])(?<upper>[A-Z])/gu, '$<lower> $<upper>')
        .replaceAll(/[_-]+/gu, ' ')
        .replaceAll(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
