import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { Extraction, JsonValue } from '@fieldwork/core';
import { emitReact } from './emit.js';
import { inspectRegistries } from './inspect.js';

vi.setConfig({ testTimeout: 10_000 });

async function configuredProps(type: string, value: JsonValue): Promise<boolean> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-prop-types-'));
    try {
        await writeFile(
            path.join(root, 'forms.ts'),
            `
function createFieldwork(options: unknown) { return options; }
type Recursive = { next?: Recursive };
const Input = (props: { label: string; constraints: unknown; options: ${type} }) => null;
export default createFieldwork({ fieldComponents: { Input }, formComponents: {} });
`,
        );
        const extraction: Extraction = {
            version: 1,
            diagnostics: [],
            forms: [
                {
                    id: 'Props',
                    defaultValues: { value: '' },
                    fields: {
                        value: {
                            name: 'value',
                            type: 'string',
                            nullable: false,
                            component: 'Input',
                            label: 'Value',
                            props: { options: value },
                            constraints: {},
                            serverRules: [],
                        },
                    },
                    groups: {},
                },
            ],
        };
        const registry = inspectRegistries('forms.ts', root);
        try {
            emitReact(extraction, registry, { root, output: { forms: 'generated' } });
            return true;
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('component prop type')) {
                throw error;
            }
            return false;
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe('configured JSON component props', () => {
    it('checks string indices including nested and declared values', async () => {
        expect.hasAssertions();
        await expect(configuredProps('Record<string, number>', { count: 1 })).resolves.toBe(true);
        await expect(configuredProps('Record<string, number>', { count: 'wrong' })).resolves.toBe(false);
        await expect(configuredProps('Record<string, { count: number }>', { item: { count: 'wrong' } })).resolves.toBe(
            false,
        );
        await expect(
            configuredProps('{ fixed: number; [key: string]: number }', { fixed: 1, extra: 'wrong' }),
        ).resolves.toBe(false);
        await expect(configuredProps('Record<string, unknown>', { anything: { nested: ['value'] } })).resolves.toBe(
            true,
        );
    });

    it('checks numeric indices while allowing unconstrained named properties', async () => {
        expect.hasAssertions();
        await expect(configuredProps('{ [key: number]: number }', { '0': 1, title: 'value' })).resolves.toBe(true);
        await expect(configuredProps('{ [key: number]: number }', { '0': 'wrong' })).resolves.toBe(false);
        await expect(
            configuredProps('{ [key: string]: string | number; [key: number]: number }', { '0': 'wrong' }),
        ).resolves.toBe(false);
        await expect(
            configuredProps('{ [key: string]: string | number; [key: number]: number }', { '0': 1, title: 'value' }),
        ).resolves.toBe(true);
    });

    it('rejects actual tuples and JSON values reaching opaque recursive branches', async () => {
        expect.hasAssertions();
        await expect(configuredProps('[number, string]', [1, 2])).resolves.toBe(false);
        await expect(configuredProps('[number, string]', [1, 'value'])).resolves.toBe(false);
        await expect(configuredProps('Array<[number, string]>', [[1, 'value']])).resolves.toBe(false);
        await expect(configuredProps('Recursive', { next: {} })).resolves.toBe(false);
        await expect(configuredProps('Array<Recursive>', [{ next: {} }])).resolves.toBe(false);
    });

    it('accepts absent optional branches and empty arrays without opaque values', async () => {
        expect.hasAssertions();
        await expect(configuredProps('Recursive', {})).resolves.toBe(true);
        await expect(configuredProps('Array<Recursive>', [])).resolves.toBe(true);
    });
});
