import type { GroupFields } from '@formbraid/react';

type Choice = '' | 'home' | 'work';
interface EmptyInterface {
    optional?: unknown;
}
interface IndexedInterface extends Record<string, unknown> {
    optional?: unknown;
}
interface StableInterface {
    stable: string;
}
type Toggle = { enabled: true; name: string } | { enabled: false; name: string };
type NullableToggle = Toggle | { enabled: null; name: string };
type NullableChoice = { choice: 'home'; name: string } | { choice: ''; name: string } | { choice: null; name: string };
interface NullableParentValues {
    value: { name: string } | null;
}
const nullableParent: GroupFields<{ value: { name: string } | null }, NullableParentValues> = { value: 'value' };
const nullableChild: GroupFields<{ value: string }, NullableParentValues> = {
    // @ts-expect-error Reading a child through a nullable ancestor can return undefined.
    value: 'value.name',
};
const absentChild: GroupFields<{ value: string | undefined }, NullableParentValues> = {
    // @ts-expect-error The writable leaf remains string and cannot accept undefined.
    value: 'value.name',
};
const nullableToggle: GroupFields<{ value: NullableToggle }, { value: { enabled: boolean | null; name: string } }> = {
    value: 'value',
};
const nullableChoice: GroupFields<{ value: NullableChoice }, { value: { choice: '' | 'home' | null; name: string } }> =
    { value: 'value' };
const toggle: GroupFields<{ value: Toggle }, { value: { enabled: boolean; name: string } }> = { value: 'value' };
const incompleteToggle: GroupFields<
    { value: { enabled: true; name: string } },
    { value: { enabled: boolean; name: string } }
> = {
    // @ts-expect-error Missing the false discriminant cannot safely read every generated value.
    value: 'value',
};
const emptyAlias: GroupFields<{ value: { optional?: unknown } }, { value: Record<string, unknown> }> = {
    value: 'value',
};
const indexedInterface: GroupFields<{ value: IndexedInterface }, { value: Record<string, unknown> }> = {
    value: 'value',
};
const stableInterface: GroupFields<{ value: StableInterface }, { value: { stable: string } }> = { value: 'value' };
// @ts-expect-error Interface slots require an explicit index signature for whole-slot Record writes.
const emptyInterface: GroupFields<{ value: EmptyInterface }, { value: Record<string, unknown> }> = { value: 'value' };
const text: GroupFields<{ value: string }, { value: string }> = { value: 'value' };
const choices: GroupFields<{ value: Choice }, { value: Choice }> = { value: 'value' };
const unknownArray: GroupFields<{ value: Array<unknown> }, { value: Array<unknown> }> = { value: 'value' };
const unknownRecord: GroupFields<{ value: Record<number, unknown> }, { value: Record<string, unknown> }> = {
    value: 'value',
};
const optionalExtras: GroupFields<
    { value: { stable: string; optional?: string; explicit?: string | undefined } },
    { value: { stable: string } }
> = { value: 'value' };
// @ts-expect-error Whole-slot writes cannot add undefined array items.
const undefinedArray: GroupFields<{ value: Array<string | undefined> }, { value: Array<string> }> = { value: 'value' };
// @ts-expect-error Scalar slots cannot broaden nullable values.
const nullableText: GroupFields<{ value: string | null }, { value: string }> = { value: 'value' };
// @ts-expect-error Enum slots cannot broaden writes to arbitrary strings.
const widerChoice: GroupFields<{ value: string }, { value: Choice }> = { value: 'value' };
// @ts-expect-error Enum slots cannot narrow reads to fewer options.
const narrowerChoice: GroupFields<{ value: '' | 'home' }, { value: Choice }> = { value: 'value' };
// @ts-expect-error Readonly arrays cannot replace a mutable parent array.
const readonlyArray: GroupFields<{ value: ReadonlyArray<number> }, { value: Array<number> }> = { value: 'value' };
void [
    nullableParent,
    nullableChild,
    absentChild,
    nullableToggle,
    nullableChoice,
    toggle,
    incompleteToggle,
    emptyAlias,
    indexedInterface,
    stableInterface,
    emptyInterface,
    text,
    choices,
    unknownArray,
    unknownRecord,
    optionalExtras,
    undefinedArray,
    nullableText,
    widerChoice,
    narrowerChoice,
    readonlyArray,
];
