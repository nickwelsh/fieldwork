/* oxlint-disable eslint/new-cap -- Effect uses capitalized functional Schema constructors. */
import { Schema } from 'effect';
import type { FormDataConvertible, RequestPayload } from '@inertiajs/core';

function isPlainRecord(value: object): boolean {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isConvertible(value: unknown, ancestors: WeakSet<object>, allowBigInt: boolean): value is FormDataConvertible {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'bigint') {
        return allowBigInt;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (value instanceof Date) {
        return Number.isFinite(value.getTime());
    }
    if (value instanceof Blob) {
        return true;
    }
    if (typeof value !== 'object') {
        return false;
    }
    if ((!Array.isArray(value) && !isPlainRecord(value)) || ancestors.has(value)) {
        return false;
    }
    ancestors.add(value);
    try {
        return Object.values(value).every((item: unknown) => isConvertible(item, ancestors, allowBigInt));
    } finally {
        ancestors.delete(value);
    }
}
export function isPayload(value: object): value is RequestPayload {
    return value instanceof FormData || (isPlainRecord(value) && isConvertible(value, new WeakSet(), false));
}

/** The Effect fork also preserves bigint values in JSON and multipart payloads. */
export function isEffectPayload(value: object): value is RequestPayload {
    return value instanceof FormData || (isPlainRecord(value) && isConvertible(value, new WeakSet(), true));
}

const HttpBindingSchema = Schema.Struct({
    kind: Schema.Literal('http'),
    url: Schema.String,
    method: Schema.Literals(['get', 'post', 'put', 'patch', 'delete']),
});
export const isHttpBinding = Schema.is(HttpBindingSchema);
