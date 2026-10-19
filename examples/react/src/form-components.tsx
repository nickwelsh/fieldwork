import { useFormContext } from '@formbraid/react';
import { FieldErrors } from './field-components.js';

export function SubmitButton({ label = 'Save' }: { readonly label?: string }) {
    const form = useFormContext();
    return (
        <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
                <button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? 'Saving…' : label}
                </button>
            )}
        </form.Subscribe>
    );
}

export function FormErrors() {
    const form = useFormContext();
    return (
        <form.Subscribe selector={(state) => state.errors[''] ?? []}>
            {(errors) => <FieldErrors errors={errors} />}
        </form.Subscribe>
    );
}

export const formComponents = { SubmitButton, FormErrors };
