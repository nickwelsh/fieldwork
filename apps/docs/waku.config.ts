import { defineConfig } from '@nickwelsh/docs-base';

export default defineConfig({
    name: 'Fieldwork',
    origin: 'https://docs.nickwelsh.me',
    githubUrl: 'https://github.com/nickwelsh/fieldwork',
    githubBranch: process.env.GITHUB_SHA ?? 'main',
    githubContentPath: 'apps/docs/content/docs',
    basePath: '/fieldwork',
    content: './content/docs',
    refquill: [
        {
            input: './generated/api.json',
            baseUrl: '/docs/0.x/api',
            title: 'API reference',
        },
    ],
});
