/* oxlint-disable eslint/no-await-in-loop -- Sequential samples measure complete workflows; parallel submits would coalesce. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Effect, Schema } from 'effect';
import { createFormSession, defineForm, definitionSchema, getValue } from '../packages/core/src/index.ts';
import type { FieldDefinition, FieldState, FormDefinition, FormSession } from '../packages/core/src/index.ts';

/** Run with: node --import tsx benchmarks/form-session.ts --output=/tmp/formbraid-session.json */
interface Values {
    readonly contacts: Array<{ readonly details: Record<string, string> }>;
}
type Path = `contacts[${number}].details.${string}`;
type Listeners = 'none' | 'value-selectors' | 'field-selectors';
interface Scenario {
    readonly listeners: Listeners;
    readonly target: 'first' | 'last';
    readonly lifecycle: 'mounted' | 'after-reset';
    readonly metadata?: 'all-touched';
}
interface Fixture {
    readonly definition: FormDefinition<Values>;
    readonly paths: ReadonlyArray<Path>;
}
interface Counters {
    notifications: number;
    changes: number;
}
interface Distribution {
    readonly samples: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maximumMs: number;
}

const sizes = [100, 1000, 5000];
const perRecord = 25;
const warmup = 50;
const measured = 150;
const rounds = 3;
const scenarios: ReadonlyArray<Scenario> = [
    { listeners: 'none', target: 'first', lifecycle: 'mounted' },
    { listeners: 'none', target: 'last', lifecycle: 'mounted' },
    { listeners: 'none', target: 'first', lifecycle: 'after-reset' },
    { listeners: 'none', target: 'last', lifecycle: 'after-reset' },
    { listeners: 'value-selectors', target: 'first', lifecycle: 'mounted' },
    { listeners: 'value-selectors', target: 'last', lifecycle: 'mounted' },
    { listeners: 'field-selectors', target: 'first', lifecycle: 'mounted' },
    { listeners: 'field-selectors', target: 'last', lifecycle: 'mounted' },
    { listeners: 'none', target: 'last', lifecycle: 'mounted', metadata: 'all-touched' },
    { listeners: 'field-selectors', target: 'last', lifecycle: 'mounted', metadata: 'all-touched' },
];

function fixture(size: number): Fixture {
    const contacts: Values['contacts'] = [];
    const fields: Record<string, FieldDefinition> = {};
    const paths: Array<Path> = [];
    for (let index = 0; index < size; index += 1) {
        const row = Math.floor(index / perRecord);
        const column = index % perRecord;
        const record = contacts[row] ?? { details: {} };
        contacts[row] = record;
        record.details[`field${column}`] = `initial-${index}@example.com`;
        const path: Path = `contacts[${row}].details.field${column}`;
        paths.push(path);
        fields[path] = {
            name: path,
            type: 'string',
            component: 'TextField',
            label: `Contact ${row + 1} Field ${column + 1}`,
            nullable: false,
            props: {},
            serverRules: [],
            constraints: { required: true, maxLength: 128, format: 'email' },
        };
    }
    const definition = defineForm<Values>()({
        id: `benchmark-${size}`,
        defaultValues: { contacts },
        fields,
        groups: {},
    });
    return { definition, paths };
}

function distribution(durations: ReadonlyArray<number>): Distribution {
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a private copy under the workspace's ES2022 type target.
    const ordered = [...durations].sort((left, right) => left - right);
    const quantile = (fraction: number) => ordered[Math.ceil(fraction * ordered.length) - 1] ?? 0;
    return {
        samples: durations.length,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
        maximumMs: ordered.at(-1) ?? 0,
    };
}

function sameField(left: FieldState, right: FieldState): boolean {
    return (
        Object.is(left.value, right.value) &&
        left.touched === right.touched &&
        left.dirty === right.dirty &&
        left.errors.length === right.errors.length &&
        left.errors.every((message, index) => message === right.errors[index])
    );
}

function subscriptions(
    session: FormSession<Values>,
    source: Fixture,
    options: { readonly kind: Listeners; readonly counters: Counters },
): ReadonlyArray<() => void> {
    const { kind, counters } = options;
    if (kind === 'none') {
        return [];
    }
    if (kind === 'field-selectors') {
        return source.paths.map((path) => {
            let previous = session.getField(path);
            return session.subscribe(() => {
                counters.notifications += 1;
                const next = session.getField(path);
                if (!sameField(previous, next)) {
                    counters.changes += 1;
                    previous = next;
                }
            });
        });
    }
    return source.paths.map((path) => {
        let previous = getValue(session.getSnapshot().values, path);
        return session.subscribe(() => {
            counters.notifications += 1;
            const next = getValue(session.getSnapshot().values, path);
            if (!Object.is(previous, next)) {
                counters.changes += 1;
                previous = next;
            }
        });
    });
}

function editing(source: Fixture, scenario: Scenario) {
    const session = createFormSession({ definition: source.definition });
    if (scenario.lifecycle === 'after-reset') {
        session.reset();
    }
    if (scenario.metadata === 'all-touched') {
        for (const path of source.paths) {
            session.touch(path);
        }
    }
    const counters: Counters = { notifications: 0, changes: 0 };
    const cleanup = subscriptions(session, source, { kind: scenario.listeners, counters });
    const path = scenario.target === 'first' ? source.paths[0] : source.paths.at(-1);
    if (path === undefined) {
        throw new Error('The fixture must contain the requested field.');
    }
    const original = session.getField(path).value;
    assert.ok(typeof original === 'string', 'The target field must have a populated string baseline.');
    const edited = 'edited@example.com';
    const write = (index: number) => {
        session.setValue(path, index % 2 === 0 ? edited : original);
    };
    const durations: Array<number> = [];
    for (let round = 0; round < rounds; round += 1) {
        for (let index = 0; index < warmup; index += 1) {
            write(index);
        }
        counters.notifications = 0;
        counters.changes = 0;
        for (let index = 0; index < measured; index += 1) {
            const started = performance.now();
            write(index);
            durations.push(performance.now() - started);
        }
        const observers = scenario.listeners === 'none' ? 0 : source.paths.length;
        assert.equal(
            counters.notifications,
            observers * measured,
            'Every mounted selector must be notified for every draft update.',
        );
        assert.equal(
            counters.changes,
            observers === 0 ? 0 : measured,
            'Only the edited field selection should change.',
        );
        assert.equal(session.getSnapshot().isDirty, false, 'Alternating edits must return to the baseline.');
    }
    const report = {
        fields: source.paths.length,
        ...scenario,
        metadata: scenario.metadata ?? 'pristine',
        ...distribution(durations),
        notificationsPerWrite: counters.notifications / measured,
        selectedChangesPerWrite: counters.changes / measured,
    };
    for (const unsubscribe of cleanup) {
        unsubscribe();
    }
    session.dispose();
    return report;
}

function validation(source: Fixture): Distribution {
    const decode = Schema.decodeUnknownSync(definitionSchema(source.definition), { errors: 'all' });
    const values = source.definition.defaultValues;
    const durations: Array<number> = [];
    for (let index = 0; index < 5; index += 1) {
        decode(values);
    }
    for (let index = 0; index < 30; index += 1) {
        const started = performance.now();
        decode(values);
        durations.push(performance.now() - started);
    }
    return distribution(durations);
}

async function submission(source: Fixture) {
    const session = createFormSession({ definition: source.definition, operation: () => Effect.void });
    const started = performance.now();
    const first = await session.submit();
    const coldMs = performance.now() - started;
    assert.equal(first.status, 'success');
    // Samples stay sequential so they measure complete workflows, rather than duplicate-submit coalescing.
    for (let index = 0; index < 5; index += 1) {
        await session.submit();
    }
    const durations: Array<number> = [];
    for (let index = 0; index < 30; index += 1) {
        const begin = performance.now();
        const result = await session.submit();
        durations.push(performance.now() - begin);
        assert.equal(result.status, 'success');
    }
    session.dispose();
    return { fields: source.paths.length, coldMs, warm: distribution(durations) };
}

const results = [];
const validationResults = [];
const submissionResults = [];
for (const size of sizes) {
    const source = fixture(size);
    for (const scenario of scenarios) {
        const result = editing(source, scenario);
        results.push(result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    validationResults.push({ fields: size, ...validation(source) });
    submissionResults.push(await submission(source));
}
const report = {
    environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpus: cpus().length,
        osRelease: release(),
        timestamp: new Date().toISOString(),
    },
    methodology: {
        sizes,
        fieldsPerRecord: perRecord,
        warmupPerRound: warmup,
        measuredPerRound: measured,
        rounds,
        validationWarmup: 5,
        validationSamples: 30,
    },
    edits: results,
    validation: validationResults,
    submission: submissionResults,
    heapUsedBytes: process.memoryUsage().heapUsed,
};
const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
if (output !== undefined) {
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ validation: validationResults, submission: submissionResults, output })}\n`);
