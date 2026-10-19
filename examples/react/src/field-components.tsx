import type { FieldProps } from '@formbraid/react';
import { useFieldContext } from '@formbraid/react';
import { useId } from 'react';

function message(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return 'Invalid value.';
}

export function FieldErrors({ errors }: { readonly errors: ReadonlyArray<unknown> }) {
    return errors.length === 0 ? null : <p role="alert">{errors.map((error) => message(error)).join(' ')}</p>;
}

export interface TextFieldProps extends FieldProps<string | null> {
    readonly type?: 'text' | 'email' | 'url';
}

export function TextField({ label, helpText, constraints, type = 'text' }: TextFieldProps) {
    const field = useFieldContext<string | null>();
    const id = useId();
    const helpId = `${id}-help`;
    const errorsId = `${id}-errors`;
    const { errors, touch: handleBlur } = field;
    return (
        <div>
            <label htmlFor={id}>
                {label}
                {constraints.required === true ? ' *' : ''}
            </label>
            <input
                id={id}
                name={field.name}
                type={type}
                value={field.value ?? ''}
                minLength={constraints.minLength}
                maxLength={constraints.maxLength}
                aria-required={constraints.required}
                aria-invalid={errors.length > 0}
                aria-describedby={
                    [helpText === undefined ? '' : helpId, errors.length > 0 ? errorsId : '']
                        .filter(Boolean)
                        .join(' ') || undefined
                }
                onChange={(event) => {
                    field.setValue(event.target.value);
                }}
                onBlur={handleBlur}
            />
            {helpText === undefined ? null : <p id={helpId}>{helpText}</p>}
            <div id={errorsId}>
                <FieldErrors errors={errors} />
            </div>
        </div>
    );
}

export function CheckboxField({ label, helpText, constraints }: FieldProps<boolean>) {
    const field = useFieldContext<boolean>();
    const id = useId();
    const { errors, touch: handleBlur } = field;
    return (
        <div>
            <label htmlFor={id}>
                <input
                    id={id}
                    name={field.name}
                    type="checkbox"
                    checked={field.value}
                    aria-required={constraints.required}
                    aria-invalid={errors.length > 0}
                    onChange={(event) => {
                        field.setValue(event.target.checked);
                    }}
                    onBlur={handleBlur}
                />
                {label}
            </label>
            {helpText === undefined ? null : <p>{helpText}</p>}
            <FieldErrors errors={errors} />
        </div>
    );
}

export const fieldComponents = { TextField, CheckboxField };
