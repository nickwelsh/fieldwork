import { defineForm } from '@fieldwork/core';
import type { FieldDefinition } from '@fieldwork/core';

export const benchmarkSizes = [100, 1000, 5000] as const;
export type BenchmarkSize = (typeof benchmarkSizes)[number];
export const detailsPerContact = 25;

export interface BenchmarkValues {
    readonly contacts: ReadonlyArray<{ readonly details: Readonly<Record<string, string>> }>;
}

export function makeBenchmarkDefinition(fieldCount: BenchmarkSize) {
    const contacts = Array.from({ length: fieldCount / detailsPerContact }, (_, row) => ({
        details: Object.fromEntries(
            Array.from({ length: detailsPerContact }, (_detail, detail) => [
                `field${detail}`,
                `initial-${row * detailsPerContact + detail}@example.com`,
            ]),
        ),
    }));
    const fields: Record<string, FieldDefinition> = {};
    for (const [row, contact] of contacts.entries()) {
        for (const name of Object.keys(contact.details)) {
            const path = `contacts.${row}.details.${name}`;
            fields[path] = {
                name: path,
                type: 'string',
                component: 'BenchmarkInput',
                label: path,
                props: {},
                constraints: { required: true, maxLength: 128, format: 'email' },
                nullable: false,
                serverRules: [],
            };
        }
    }
    return defineForm<BenchmarkValues>()({
        id: `massive-${fieldCount}`,
        defaultValues: { contacts },
        fields,
        groups: {},
    });
}

export interface TimingSummary {
    readonly count: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
}

function summarize(values: ReadonlyArray<number>): TimingSummary {
    // Sorting this newly owned array supports the package's ES2022 target.
    // oxlint-disable-next-line unicorn/no-array-sort
    const ordered = [...values].sort((left, right) => left - right);
    const percentile = (fraction: number): number =>
        ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
    return { count: ordered.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: ordered.at(-1) ?? 0 };
}

export interface BenchmarkMeasurement {
    readonly fieldCount: number;
    readonly mode: 'synchronous workload' | 'native input events';
    readonly target: string;
    readonly mutation: TimingSummary;
    readonly editToCommit: TimingSummary;
    readonly fieldRenders: number;
    readonly editedFieldRenders: number;
    readonly unrelatedFieldRenders: number;
    readonly distinctRenderedFields: number;
    readonly rowSelectorCalls: number;
    readonly rowSubscriptionRenders: number;
    readonly userAgent: string;
}

/** Benchmark instrumentation is external to React state and only published after a sample. */
export function makeMeasurements() {
    const fieldRenders = new Map<string, number>();
    const pending = new Map<string, number>();
    const mutations: Array<number> = [];
    const commits: Array<number> = [];
    let selectorCalls = 0;
    let subscriptionRenders = 0;
    return {
        reset(): void {
            fieldRenders.clear();
            pending.clear();
            mutations.length = 0;
            commits.length = 0;
            selectorCalls = 0;
            subscriptionRenders = 0;
        },
        render(name: string): void {
            fieldRenders.set(name, (fieldRenders.get(name) ?? 0) + 1);
        },
        begin(name: string): void {
            pending.set(name, performance.now());
        },
        mutation(milliseconds: number): void {
            mutations.push(milliseconds);
        },
        commit(name: string): void {
            const started = pending.get(name);
            if (started !== undefined) {
                commits.push(performance.now() - started);
                pending.delete(name);
            }
        },
        select(): void {
            selectorCalls += 1;
        },
        subscription(): void {
            subscriptionRenders += 1;
        },
        capture(fieldCount: number, mode: BenchmarkMeasurement['mode'], target: string): BenchmarkMeasurement {
            const total = [...fieldRenders.values()].reduce((sum, count) => sum + count, 0);
            const edited = fieldRenders.get(target) ?? 0;
            return {
                fieldCount,
                mode,
                target,
                mutation: summarize(mutations),
                editToCommit: summarize(commits),
                fieldRenders: total,
                editedFieldRenders: edited,
                unrelatedFieldRenders: total - edited,
                distinctRenderedFields: fieldRenders.size,
                rowSelectorCalls: selectorCalls,
                rowSubscriptionRenders: subscriptionRenders,
                userAgent: navigator.userAgent,
            };
        },
    };
}

export type Measurements = ReturnType<typeof makeMeasurements>;
