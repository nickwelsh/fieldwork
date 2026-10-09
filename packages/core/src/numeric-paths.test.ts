import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createFormSession, defineForm } from './index.js';

vi.setConfig({ testTimeout: 10_000 });

describe('numeric object paths', () => {
    it('reads and edits numeric object keys without treating them as array indexes', () => {
        expect.hasAssertions();
        const definition = defineForm<{
            codes: { 0: { name: string }; '01': string };
            dynamic: Record<number, string>;
        }>()({
            id: 'numeric-objects',
            defaultValues: { codes: { 0: { name: 'zero' }, '01': 'literal' }, dynamic: {} },
            fields: {},
            groups: {},
        });
        const session = createFormSession({ definition, operation: () => Effect.void });
        expect(session.getField('codes[0].name').value).toBe('zero');
        expect(session.getField('dynamic.0').value).toBeUndefined();
        session.setValue('codes.0.name', 'edited');
        session.setValue('codes.01', 'literal edit');
        session.setValue('dynamic[0]', 'added');
        expect(session.getSnapshot().values).toStrictEqual({
            codes: { 0: { name: 'edited' }, '01': 'literal edit' },
            dynamic: { 0: 'added' },
        });
        expect(Array.isArray(session.getSnapshot().values.dynamic)).toBe(false);
        session.dispose();
    });
});
