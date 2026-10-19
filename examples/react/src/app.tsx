import type { SubmissionDriver } from '@formbraid/core';
import { Effect } from 'effect';
import { useState } from 'react';
import { Form } from './forms.js';
import { update } from './generated/actions/profile.js';
import { MassiveFormBenchmark } from './massive-form-benchmark.js';
import './style.css';

function ProfileExample() {
    const [submitted, setSubmitted] = useState<object | null>(null);
    const submission: SubmissionDriver = {
        submit: ({ data }) =>
            Effect.sync(() => {
                setSubmitted(data);
                return { status: 'success' as const };
            }),
    };
    return (
        <main>
            <h1>Formbraid</h1>
            <p>Laravel rules, application fields, and one address input.</p>
            <Form form={update.form({ user: 42 })} submission={submission}>
                {({ fields, components, groups }) => (
                    <>
                        <fields.name />
                        <fields.email />
                        <fields.newsletter />
                        <fields.company />
                        <groups.address />
                        <components.FormErrors />
                        <components.SubmitButton label="Save Profile" />
                    </>
                )}
            </Form>
            {submitted === null ? null : (
                <section>
                    <h2>Submitted Laravel Fields</h2>
                    <pre>{JSON.stringify(submitted, null, 2)}</pre>
                </section>
            )}
        </main>
    );
}

export function App() {
    return new URLSearchParams(globalThis.location.search).get('benchmark') === 'massive' ? (
        <MassiveFormBenchmark />
    ) : (
        <ProfileExample />
    );
}
