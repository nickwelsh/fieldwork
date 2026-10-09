import { defineConfig } from 'vite-plus';

export default defineConfig({
    pack: {
        entry: ['src/index.ts', 'src/generator.ts', 'src/effect.ts'],
        dts: true,
        format: 'esm',
        sourcemap: true,
        platform: 'neutral',
    },
});
