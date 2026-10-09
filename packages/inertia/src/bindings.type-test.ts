import { inertia } from './generator.js';
import type { OperationProvider } from '@fieldwork/generator';

/** HTTP submission generators accept HTTP providers from any schema source. */
export function ProviderTypeProof(mutations: OperationProvider<{ mutation: string }>) {
    // @ts-expect-error A mutation provider has no HTTP URI/method capability.
    const invalid = inertia({ bindings: mutations });
    return invalid;
}
