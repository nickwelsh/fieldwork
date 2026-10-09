import path from 'node:path';
import { parseExtractionEffect } from '@fieldwork/core';
import { defineConfig } from '@fieldwork/generator';
import { exportPhp, laravel } from '@fieldwork/laravel/generator';
import { react } from '@fieldwork/react/generator';
import { inertia } from '@fieldwork/inertia/generator';
import { Effect } from 'effect';

// The standalone demo uses Laravel's extractor without booting an application.
const app = {
    ...laravel(),
    extract: ({ root }: { root: string }) =>
        Effect.gen(function* extractExample() {
            const { stdout } = yield* exportPhp('php', [path.join(root, 'php/export.php')], root);
            return yield* parseExtractionEffect(stdout);
        }),
};

export default defineConfig({
    sources: { app },
    framework: react('./src/forms.ts'),
    submissions: {
        web: inertia({
            bindings: {
                source: app,
                extract: () =>
                    Effect.succeed([
                        {
                            name: 'profile.update',
                            schema: 'Example\\UpdateProfileRequest',
                            parameters: [{ name: 'user' }],
                            binding: { uri: 'users/{user}', method: 'patch' },
                        },
                    ]),
            },
        }),
    },
    output: { forms: './src/generated/forms', actions: './src/generated/actions' },
});
