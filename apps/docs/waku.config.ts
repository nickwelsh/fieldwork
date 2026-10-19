import { defineConfig } from '@nickwelsh/docs-base';

export default defineConfig({
    name: 'Formbraid',
    origin: 'https://docs.nickwelsh.me',
    githubUrl: 'https://github.com/nickwelsh/formbraid',
    githubBranch: process.env.GITHUB_SHA ?? 'main',
    githubContentPath: 'apps/docs/content/docs',
    basePath: '/formbraid',
    content: './content/docs',
    refquill: [
        {
            input: './generated/api.json',
            baseUrl: '/docs/0.x/api',
            title: 'API reference',
        },
    ],
});
