import { defineConfig } from 'vite-plus';

export default defineConfig({
    pack: {
        entry: ['src/index.ts', 'src/cli.ts', 'src/react.ts'],
        dts: true,
        fixedExtension: false,
        format: 'esm',
        sourcemap: true,
        platform: 'node',
    },
});
