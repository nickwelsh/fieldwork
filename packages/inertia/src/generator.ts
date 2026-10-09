import { defineSubmission } from '@fieldwork/generator';
import type { GenerationError, OperationProvider, SubmissionGenerator } from '@fieldwork/generator';
import type { HttpOperation } from '@fieldwork/core';

export function inertia<E, R>(options: {
    readonly bindings: OperationProvider<HttpOperation, E, R>;
}): SubmissionGenerator<E | GenerationError, R> {
    return defineSubmission({
        bindings: options.bindings,
        imports: ["import { routeUrl } from '@fieldwork/core';"],
        emitBinding: (operation) =>
            `{ kind: 'http', url: routeUrl(${JSON.stringify(operation.binding.uri)}, ${operation.parameters.length === 0 ? '{}' : 'parameters'}), method: ${JSON.stringify(operation.binding.method)} }`,
    });
}
