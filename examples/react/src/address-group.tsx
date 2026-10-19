import { useId, useState } from 'react';
import { withFieldGroup } from '@formbraid/react';
import { FieldErrors } from './field-components.js';

export interface AddressValues {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
}

const defaultValues: AddressValues = { line1: '', line2: null, city: '', state: '', postalCode: '' };
const exampleAddress: AddressValues = {
    line1: '123 Main Street',
    line2: null,
    city: 'Boston',
    state: 'MA',
    postalCode: '02110',
};

// The provider-specific lookup is application code; this runnable example uses a local suggestion.
export const AddressAutocomplete = withFieldGroup({
    defaultValues,
    props: { label: 'Address', helpText: 'Search for an address, then choose a suggestion.' },
    render: function AddressAutocomplete({ group, label, helpText }) {
        const id = useId();
        const [query, setQuery] = useState('');
        function selectAddress(address: AddressValues): void {
            group.setFieldValue('line1', address.line1);
            group.setFieldValue('line2', address.line2);
            group.setFieldValue('city', address.city);
            group.setFieldValue('state', address.state);
            group.setFieldValue('postalCode', address.postalCode);
            setQuery(address.line1);
        }
        return (
            <fieldset>
                <legend>{label}</legend>
                <label htmlFor={id}>Find Address</label>
                <input
                    id={id}
                    type="search"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                    }}
                    onBlur={() => {
                        for (const name of ['line1', 'line2', 'city', 'state', 'postalCode'] as const) {
                            group.touchField(name);
                        }
                    }}
                />
                <p>{helpText}</p>
                {query.length === 0 ? null : (
                    <button
                        type="button"
                        onClick={() => {
                            selectAddress(exampleAddress);
                        }}
                    >
                        123 Main Street, Boston, MA 02110
                    </button>
                )}
                {(['line1', 'line2', 'city', 'state', 'postalCode'] as const).map((name) => (
                    <group.Field key={name} name={name}>
                        {(field) => <FieldErrors errors={field.errors} />}
                    </group.Field>
                ))}
                <group.Subscribe selector={(state) => state.values}>
                    {(values) => (
                        <output>
                            {[values.line1, values.city, values.state, values.postalCode].filter(Boolean).join(', ')}
                        </output>
                    )}
                </group.Subscribe>
            </fieldset>
        );
    },
});

export const fieldGroups = { AddressAutocomplete };
