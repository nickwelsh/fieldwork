import { createFormbraid, useFieldContext, useFormContext } from '@formbraid/react';
import type { FieldProps } from '@formbraid/react';
import { Effect } from 'effect';
import { createContext, useContext, useId, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import {
    benchmarkSizes,
    detailsPerContact,
    makeBenchmarkDefinition,
    makeMeasurements,
} from './benchmark-measurements.js';
import type { BenchmarkMeasurement, BenchmarkSize, BenchmarkValues, Measurements } from './benchmark-measurements.js';

const MeasurementsContext = createContext<Measurements | null>(null);

function useMeasurements(): Measurements {
    const measurements = useContext(MeasurementsContext);
    if (measurements === null) {
        throw new Error('Benchmark instrumentation is missing.');
    }
    return measurements;
}

function BenchmarkInput({ label, constraints }: FieldProps<string>) {
    const field = useFieldContext<string>();
    const measurements = useMeasurements();
    const id = useId();
    measurements.render(field.name);
    useLayoutEffect(() => {
        measurements.commit(field.name);
    });
    return (
        <label htmlFor={id}>
            {label}
            <input
                id={id}
                name={field.name}
                value={field.value}
                maxLength={constraints.maxLength}
                aria-required={constraints.required}
                aria-invalid={field.errors.length > 0}
                onChange={(event) => {
                    measurements.begin(field.name);
                    const started = performance.now();
                    field.setValue(event.target.value);
                    measurements.mutation(performance.now() - started);
                }}
            />
        </label>
    );
}

function BenchmarkSubscriptions() {
    const form = useFormContext<BenchmarkValues>();
    const measurements = useMeasurements();
    const rows = form.getState().values.contacts.length;
    return (
        <div className="benchmark-subscriptions" aria-label="Selected row subscriptions">
            {Array.from({ length: rows }, (_, row) => (
                <form.Subscribe
                    key={row}
                    selector={(state) => {
                        measurements.select();
                        return state.values.contacts[row]?.details['field0'];
                    }}
                >
                    {(value) => {
                        measurements.subscription();
                        return <output>{value}</output>;
                    }}
                </form.Subscribe>
            ))}
            <form.Subscribe selector={(state) => state.isSubmitting}>
                {(busy) => <output>{busy ? 'Submitting' : 'Ready'}</output>}
            </form.Subscribe>
        </div>
    );
}

const formbraid = createFormbraid({
    fieldComponents: { BenchmarkInput },
    formComponents: { BenchmarkSubscriptions },
    submitComponent: 'BenchmarkSubscriptions',
});

async function nextFrame(): Promise<void> {
    // Frames separate setup/publication from the measured synchronous workload; they are not timed as CPU work.
    // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame exposes a callback rather than a native Promise.
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
            resolve();
        });
    });
}

function BenchmarkSession({ fieldCount }: { readonly fieldCount: BenchmarkSize }) {
    // oxlint-disable-next-line react/hook-use-state -- Definitions are deliberately mount-only for each selected benchmark size.
    const [definition] = useState(() => makeBenchmarkDefinition(fieldCount));
    // oxlint-disable-next-line react/hook-use-state -- Instrumentation is an external mutable recorder, not rendered state.
    const [measurements] = useState(makeMeasurements);
    const instance = formbraid.useForm(definition, { operation: () => Effect.void });
    const [running, setRunning] = useState(false);
    const [target, setTarget] = useState<'first' | 'last'>(() =>
        new URLSearchParams(globalThis.location.search).get('target') === 'last' ? 'last' : 'first',
    );
    const [result, setResult] = useState<BenchmarkMeasurement | null>(null);
    const path =
        `contacts.${target === 'first' ? 0 : fieldCount / detailsPerContact - 1}.details.${target === 'first' ? 'field0' : `field${detailsPerContact - 1}`}` as const;
    async function runSample(): Promise<void> {
        const original = instance.form.getFieldValue(path);
        if (typeof original !== 'string') {
            throw new TypeError('The target field must have a populated string baseline.');
        }
        setRunning(true);
        await nextFrame();
        // Warm the same field/store/render path before reporting timings.
        for (let edit = 0; edit < 30; edit += 1) {
            flushSync(() => {
                instance.form.setFieldValue(path, edit % 2 === 0 ? 'warm@example.com' : original);
            });
        }
        measurements.reset();
        for (let edit = 0; edit < 300; edit += 1) {
            measurements.begin(path);
            flushSync(() => {
                const started = performance.now();
                instance.form.setFieldValue(path, edit % 2 === 0 ? 'edited@example.com' : original);
                measurements.mutation(performance.now() - started);
            });
        }
        const captured = measurements.capture(fieldCount, 'synchronous workload', path);
        setResult(captured);
        setRunning(false);
    }
    async function startManualSample(): Promise<void> {
        setResult(null);
        await nextFrame();
        measurements.reset();
    }
    return (
        <MeasurementsContext value={measurements}>
            <section className="benchmark-controls" aria-label="Benchmark controls">
                <label>
                    Target field{' '}
                    <select
                        value={target}
                        disabled={running}
                        onChange={(event) => {
                            setTarget(event.target.value === 'last' ? 'last' : 'first');
                        }}
                    >
                        <option value="first">First field</option>
                        <option value="last">Last field</option>
                    </select>
                </label>
                <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                        void runSample();
                    }}
                >
                    {running ? 'Running…' : 'Run 300 edits'}
                </button>
                <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                        void startManualSample();
                    }}
                >
                    Start manual sample
                </button>
                <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                        setResult(measurements.capture(fieldCount, 'native input events', path));
                    }}
                >
                    Read manual sample
                </button>
                <p>
                    Mutation timing covers the session update and synchronous subscriber notifications. Edit-to-commit
                    timing ends in the edited input’s layout effect. It excludes frame waits and does not measure
                    painting.
                </p>
                <p>
                    Automated runs use 30 warmup edits followed by 300 alternating updates with a forced React commit.
                    Manual samples measure real input events. Result publication happens after sampling.
                </p>
                <output aria-live="polite">
                    {result === null
                        ? 'No sample recorded.'
                        : `${result.editToCommit.count} committed edits; ${result.unrelatedFieldRenders} unrelated field renders.`}
                </output>
                {result === null ? null : <pre aria-label="Benchmark results">{JSON.stringify(result, null, 2)}</pre>}
            </section>
            <formbraid.Form form={instance} className="benchmark-fields" aria-label={`${fieldCount} field benchmark`} />
        </MeasurementsContext>
    );
}

export function MassiveFormBenchmark() {
    const [fieldCount, setFieldCount] = useState<BenchmarkSize>(() => {
        const requested = Number(new URLSearchParams(globalThis.location.search).get('fields'));
        return benchmarkSizes.find((size) => size === requested) ?? 1000;
    });
    return (
        <main className="massive-benchmark">
            <h1>Formbraid massive form benchmark</h1>
            <p>
                Every field is mounted: nested contact records, generated field metadata, and one selected-value
                subscription per contact. No virtualization.
            </p>
            <p>
                <a href="/">Open the profile example</a>
            </p>
            <label>
                Mounted fields{' '}
                <select
                    value={fieldCount}
                    onChange={(event) => {
                        const size = benchmarkSizes.find((candidate) => candidate === Number(event.target.value));
                        if (size !== undefined) {
                            setFieldCount(size);
                        }
                    }}
                >
                    {benchmarkSizes.map((size) => (
                        <option key={size} value={size}>
                            {size.toLocaleString()} fields
                        </option>
                    ))}
                </select>
            </label>
            <BenchmarkSession key={fieldCount} fieldCount={fieldCount} />
        </main>
    );
}
