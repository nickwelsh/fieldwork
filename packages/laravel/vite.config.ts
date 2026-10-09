import { defineConfig } from 'vite-plus';

export default defineConfig({
    pack: {
        entry: ['js/generator.ts'],
        dts: true,
        fixedExtension: false,
        format: 'esm',
        sourcemap: true,
        platform: 'node',
    },
});
