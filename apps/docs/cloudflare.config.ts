import { defineConfig, triggers } from 'cf/config';

export default defineConfig({
    worker: {
        name: 'fieldwork-docs',
        compatibilityDate: '2026-10-19',
        workersDev: false,
        previewUrls: false,
        assets: {
            htmlHandling: 'auto-trailing-slash',
            notFoundHandling: '404-page',
        },
        triggers: [
            triggers.fetch({ pattern: 'docs.nickwelsh.me/fieldwork', zone: 'nickwelsh.me' }),
            triggers.fetch({ pattern: 'docs.nickwelsh.me/fieldwork/*', zone: 'nickwelsh.me' }),
        ],
        observability: {
            enabled: true,
            traces: { enabled: true, headSamplingRate: 0.01 },
        },
    },
});
