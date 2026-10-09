import type { SubmissionContext, SubmissionDriver, SubmissionResult } from './contracts.js';
import { Effect } from 'effect';

/** Adapt a typed binding executor to the portable runtime boundary. */
export function defineSubmissionDriver<TBinding>(options: {
    readonly accepts: (binding: unknown) => binding is TBinding;
    readonly submit: (
        context: Omit<SubmissionContext, 'binding'> & { readonly binding: TBinding },
    ) => Effect.Effect<SubmissionResult>;
}): SubmissionDriver {
    return {
        submit: (context) => {
            if (!options.accepts(context.binding)) {
                return Effect.succeed({ status: 'failure', error: new Error('Unsupported submission binding.') });
            }
            return options.submit({ ...context, binding: context.binding });
        },
    };
}
