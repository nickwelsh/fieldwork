import type { FrameworkDriver } from './contracts.js';
import { emitReact, emitActions } from './emit.js';
import { inspectRegistries } from './inspect.js';

export function react(module: string): FrameworkDriver {
    return { inspect: (context) => inspectRegistries(module, context.root), generate: emitReact, actions: emitActions };
}
