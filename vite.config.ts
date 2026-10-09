import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite-plus';

export default {
    staged: { '*': 'vp check --fix' },
    lint: {
        categories: {
            correctness: 'error',
            nursery: 'error',
            pedantic: 'error',
            perf: 'error',
            restriction: 'error',
            style: 'error',
            suspicious: 'error',
        },
        env: {
            browser: true,
            builtin: true,
        },
        jsPlugins: [
            '@html-eslint/eslint-plugin-react',
            // '@microsoft/eslint-plugin-sdl',
            'eslint-plugin-compat',
            'eslint-plugin-no-only-tests',
            'eslint-plugin-no-use-extend-native',
            'eslint-plugin-regexp',
            {
                name: 'react-hooks-plugin',
                specifier: 'eslint-plugin-react-hooks',
            },
        ],
        options: {
            typeAware: true,
            typeCheck: true,
        },
        overrides: [
            { files: ['examples/react/src/address-group.tsx'], rules: { 'eslint/func-name-matching': 'off' } },
            {
                files: ['**/vite.config.ts', '**/generated/actions/**', 'benchmarks/**'],
                rules: { 'import/no-relative-parent-imports': 'off' },
            },
            {
                files: ['packages/generator/src/inspect.ts'],
                // TypeScript represents compiler flags as bitmasks.
                rules: { 'eslint/no-bitwise': 'off' },
            },
            {
                files: ['packages/react/src/render.tsx'],
                // This module erases native generics to dispatch statically checked registry bindings.
                rules: { 'typescript/no-unsafe-type-assertion': 'off' },
            },
            {
                files: ['packages/inertia/src/driver.ts', '**/*.test.tsx'],
                // Callback transports and controlled test gates require a promise adapter.
                rules: { 'promise/avoid-new': 'off' },
            },
            {
                files: [
                    'packages/generator/**',
                    'benchmarks/**',
                    'packages/laravel/js/**',
                    '**/generator.ts',
                    '**/vite.config.ts',
                    '**/fieldwork.config.ts',
                ],
                env: { node: true, browser: false },
                rules: { 'compat/compat': 'off', 'import/no-nodejs-modules': 'off' },
            },
            {
                files: ['**/*.test.ts', '**/*.test.tsx'],
                rules: { 'compat/compat': 'off', 'typescript/unbound-method': 'off', 'vitest/no-hooks': 'off' },
            },
            {
                files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.tsx', '**/*.spec.tsx'],
                plugins: ['vitest'],
                rules: {
                    'vitest/no-hooks': 'off',
                    'vitest/no-importing-vitest-globals': 'off',
                    'vitest/prefer-to-be-truthy': 'off',
                    'vitest/prefer-to-be-falsy': 'off',
                    'vitest/prefer-called-once': 'off',
                },
            },
        ],
        plugins: ['typescript', 'unicorn', 'oxc', 'react', 'react-perf', 'jsx-a11y', 'eslint', 'import', 'promise'],
        rules: {
            // Misc
            'compat/compat': 'error',
            'no-only-tests/no-only-tests': 'error',
            'no-use-extend-native/no-use-extend-native': 'error',
            // HTML ESLint React
            '@html-eslint/react/classname-spacing': [
                'error',
                {
                    callees: ['clsx', 'cn', 'classnames'],
                },
            ],
            '@html-eslint/react/no-duplicate-classname': [
                'error',
                {
                    callees: ['clsx', 'cn', 'classnames'],
                },
            ],
            '@html-eslint/react/no-ineffective-attrs': 'error',
            '@html-eslint/react/no-invalid-attr-value': 'error',
            '@html-eslint/react/no-obsolete-attrs': 'error',
            '@html-eslint/react/no-obsolete-tags': 'error',
            '@html-eslint/react/use-baseline': 'error',

            // ESLint
            'eslint/one-var': 'off',
            'eslint/func-style': 'off',
            'eslint/sort-imports': 'off',
            'eslint/no-duplicate-imports': [
                'error',
                {
                    allowSeparateTypeImports: true,
                },
            ],
            'eslint/no-magic-numbers': 'off',
            'eslint/no-ternary': 'off',
            'eslint/class-methods-use-this': 'off',
            'eslint/no-undefined': 'off',
            'eslint/max-statements': 'off',
            'eslint/no-use-before-define': [
                'error',
                {
                    functions: false,
                },
            ],
            'eslint/max-lines': 'off',
            'eslint/max-lines-per-function': 'off',
            'eslint/sort-keys': 'off',
            'eslint/no-void': [
                'error',
                {
                    allowAsStatement: true,
                },
            ],
            'eslint/id-length': 'off',
            'eslint/no-inline-comments': 'off',
            'eslint/capitalized-comments': 'off',
            'eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    fix: { imports: 'safe-fix', variables: 'fix' },
                },
            ],

            // Import
            'import/no-named-export': 'off',
            'import/prefer-default-export': 'off',
            'import/no-default-export': 'off',
            'import/no-unassigned-import': [
                'error',
                {
                    allow: ['**/*.css'],
                },
            ],
            'import/max-dependencies': 'off',
            'import/exports-last': 'off',
            'import/group-exports': 'off',

            // OXC
            'oxc/no-rest-spread-properties': 'off',
            'oxc/no-optional-chaining': 'off',
            'oxc/no-async-await': 'off',
            'oxc/no-barrel-file': 'off',

            // React
            'react/react-in-jsx-scope': 'off',
            'react/jsx-filename-extension': [
                'error',
                {
                    extensions: ['tsx'],
                },
            ],
            'react/jsx-props-no-spreading': 'off',
            'react/no-multi-comp': 'off',
            'react/only-export-components': 'off',
            'react/jsx-max-depth': 'off',
            'react/forbid-component-props': 'off',
            'react/no-object-type-as-default-prop': 'off',
            'react/jsx-no-literals': 'off',

            // React Performance
            'react-perf/jsx-no-jsx-as-prop': 'off',
            'react-perf/jsx-no-new-object-as-prop': 'off',
            'react-perf/jsx-no-new-function-as-prop': 'off',
            'react-perf/jsx-no-new-array-as-prop': 'off',

            // React Hooks
            'react-hooks-plugin/config': 'error',
            'react-hooks-plugin/rules-of-hooks': 'error',
            'react-hooks-plugin/exhaustive-deps': 'error',
            'react-hooks-plugin/error-boundaries': 'error',
            'react-hooks-plugin/component-hook-factories': 'error',
            'react-hooks-plugin/gating': 'error',
            'react-hooks-plugin/globals': 'error',
            'react-hooks-plugin/immutability': 'error',
            'react-hooks-plugin/preserve-manual-memoization': 'error',
            'react-hooks-plugin/purity': 'error',
            'react-hooks-plugin/refs': 'error',
            'react-hooks-plugin/set-state-in-effect': 'error',
            'react-hooks-plugin/set-state-in-render': 'error',
            'react-hooks-plugin/static-components': 'error',
            'react-hooks-plugin/unsupported-syntax': 'error',
            'react-hooks-plugin/use-memo': 'error',
            'react-hooks-plugin/incompatible-library': 'error',

            // Regex
            'regexp/confusing-quantifier': 'error',
            'regexp/control-character-escape': 'error',
            'regexp/match-any': 'error',
            'regexp/negation': 'error',
            'regexp/no-contradiction-with-assertion': 'error',
            'regexp/no-dupe-characters-character-class': 'error',
            'regexp/no-dupe-disjunctions': 'error',
            'regexp/no-empty-alternative': 'error',
            'regexp/no-empty-capturing-group': 'error',
            'regexp/no-empty-character-class': 'error',
            'regexp/no-empty-group': 'error',
            'regexp/no-empty-lookarounds-assertion': 'error',
            'regexp/no-empty-string-literal': 'error',
            'regexp/no-escape-backspace': 'error',
            'regexp/no-extra-lookaround-assertions': 'error',
            'regexp/no-invalid-regexp': 'error',
            'regexp/no-invisible-character': 'error',
            'regexp/no-lazy-ends': 'error',
            'regexp/no-legacy-features': 'error',
            'regexp/no-misleading-capturing-group': 'error',
            'regexp/no-misleading-unicode-character': 'error',
            'regexp/no-missing-g-flag': 'error',
            'regexp/no-non-standard-flag': 'error',
            'regexp/no-obscure-range': 'error',
            'regexp/no-optional-assertion': 'error',
            'regexp/no-potentially-useless-backreference': 'error',
            'regexp/no-super-linear-backtracking': 'error',
            'regexp/no-trivially-nested-assertion': 'error',
            'regexp/no-trivially-nested-quantifier': 'error',
            'regexp/no-unused-capturing-group': 'error',
            'regexp/no-useless-assertions': 'error',
            'regexp/no-useless-backreference': 'error',
            'regexp/no-useless-character-class': 'error',
            'regexp/no-useless-dollar-replacements': 'error',
            'regexp/no-useless-escape': 'error',
            'regexp/no-useless-flag': 'error',
            'regexp/no-useless-lazy': 'error',
            'regexp/no-useless-non-capturing-group': 'error',
            'regexp/no-useless-quantifier': 'error',
            'regexp/no-useless-range': 'error',
            'regexp/no-useless-set-operand': 'error',
            'regexp/no-useless-string-literal': 'error',
            'regexp/no-useless-two-nums-quantifier': 'error',
            'regexp/no-zero-quantifier': 'error',
            'regexp/optimal-lookaround-quantifier': 'error',
            'regexp/optimal-quantifier-concatenation': 'error',
            'regexp/prefer-character-class': 'error',
            'regexp/prefer-d': 'error',
            'regexp/prefer-plus-quantifier': 'error',
            'regexp/prefer-predefined-assertion': 'error',
            'regexp/prefer-question-quantifier': 'error',
            'regexp/prefer-range': 'error',
            'regexp/prefer-set-operation': 'error',
            'regexp/prefer-star-quantifier': 'error',
            'regexp/prefer-unicode-codepoint-escapes': 'error',
            'regexp/prefer-w': 'error',
            'regexp/simplify-set-operations': 'error',
            'regexp/sort-flags': 'error',
            'regexp/strict': 'error',
            'regexp/use-ignore-case': 'error',

            // Security
            // "@microsoft/sdl/no-cookies": "error",
            // "@microsoft/sdl/no-document-domain": "error",
            // "@microsoft/sdl/no-document-write": "error",
            // "@microsoft/sdl/no-html-method": "error",
            // "@microsoft/sdl/no-inner-html": "error",
            // "@microsoft/sdl/no-insecure-random": "error",
            // "@microsoft/sdl/no-insecure-url": "error",
            // "@microsoft/sdl/no-msapp-exec-unsafe": "error",
            // "@microsoft/sdl/no-postmessage-star-origin": "error",
            // "@microsoft/sdl/no-unsafe-alloc": "error",
            // "@microsoft/sdl/no-winjs-html-unsafe": "error",

            // Typescript
            'typescript/return-await': ['error', 'always'],
            'typescript/explicit-function-return-type': 'off',
            'typescript/explicit-module-boundary-types': 'off',
            'typescript/prefer-readonly-parameter-types': 'off',
            'typescript/parameter-properties': 'off',
            'typescript/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: true }],
            'typescript/consistent-type-definitions': ['error', 'interface'],
            'typescript/array-type': [
                'error',
                {
                    default: 'generic',
                },
            ],
            'typescript/no-confusing-void-expression': [
                'error',
                {
                    ignoreArrowShorthand: true,
                },
            ],

            // Unicorn
            'unicorn/no-null': 'off',
            'unicorn/filename-case': 'off',

            // Vitest
            'vitest/prefer-called-times': 'error',
            'vitest/prefer-importing-vitest-globals': 'error',
            'vitest/no-importing-vitest-globals': 'off',
        },
        ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/vendor/**', '.agents', '.codex'],
    },
    fmt: {
        semi: true,
        singleQuote: true,
        printWidth: 120,
        tabWidth: 4,
        sortPackageJson: true,
        ignorePatterns: ['**/vendor/**', '**/dist/**'],
        overrides: [{ files: ['**/*.{yaml,yml}'], options: { tabWidth: 2 } }],
    },
    resolve: {
        alias: {
            '@fieldwork/example': fileURLToPath(new URL('examples/react/src', import.meta.url)),
            '@fieldwork/laravel/generator': fileURLToPath(new URL('packages/laravel/js/generator.ts', import.meta.url)),
            '@fieldwork/react/generator': fileURLToPath(new URL('packages/react/src/generator.ts', import.meta.url)),
            '@fieldwork/inertia/generator': fileURLToPath(
                new URL('packages/inertia/src/generator.ts', import.meta.url),
            ),
            '@fieldwork/generator/react': fileURLToPath(new URL('packages/generator/src/react.ts', import.meta.url)),
            '@fieldwork/generator': fileURLToPath(new URL('packages/generator/src/index.ts', import.meta.url)),
            '@fieldwork/inertia/effect': fileURLToPath(new URL('packages/inertia/src/effect.ts', import.meta.url)),
            '@fieldwork/inertia': fileURLToPath(new URL('packages/inertia/src/index.ts', import.meta.url)),
            '@fieldwork/react': fileURLToPath(new URL('packages/react/src/index.ts', import.meta.url)),
            '@fieldwork/core': fileURLToPath(new URL('packages/core/src/index.ts', import.meta.url)),
        },
    },
    test: {
        globals: true,
        testTimeout: 10_000,
        include: ['packages/**/*.test.{ts,tsx}'],
        environment: 'jsdom',
        restoreMocks: true,
    },
} as const satisfies UserConfig;
