import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { resolveDocument } from '@nickwelsh/refquill-schema';
import { Miniflare } from 'miniflare';

const output = await readBuildOutput(process.cwd());
const worker = output.workers.default;
assert.equal(worker.bundleDir, undefined);
assert.ok(worker.assetsDir !== undefined);
const runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    workers: [
        {
            config: {
                name: worker.config.name,
                compatibilityDate: worker.config.compatibilityDate,
                // Miniflare requires a module even when the assets router owns every response.
                manifest: {
                    mainModule: 'index.js',
                    modules: {
                        'index.js': {
                            type: 'esm',
                            contents: 'export default { fetch() { throw new Error("Unexpected Worker execution"); } };',
                        },
                    },
                },
                assets: { ...worker.config.assets, directory: worker.assetsDir, hasUserWorker: false },
            },
        },
    ],
});
try {
    const origin = await runtime.ready;
    const get = async (pathname: string) => {
        const response = await runtime.dispatchFetch(new URL(pathname, origin));
        assert.equal(response.status, 200, pathname);
        return await response.text();
    };
    await get('/fieldwork/');
    for await (const file of glob('content/docs/**/*.mdx')) {
        const route = file.replace('content', '/fieldwork').replace(/(?:\/index)?\.mdx$/u, '/');
        const html = await get(route);
        assert.ok(html.includes(`https://docs.nickwelsh.me${route.replace(/\/$/u, '')}`), route);
    }

    const reference = resolveDocument(JSON.parse(await readFile('generated/api.json', 'utf8')));
    assert.ok(reference.symbols.some((symbol) => symbol.name === 'createFormSession'));
    assert.ok(reference.symbols.some((symbol) => symbol.name === 'createFieldwork'));
    assert.ok(reference.symbols.some((symbol) => symbol.language === 'php' && symbol.name === 'Field'));
    await get('/fieldwork/docs/0.x/api/');
    await get('/fieldwork/docs/0.x/api/typescript/');
    await get('/fieldwork/docs/0.x/api/laravel/');
    const search = await get('/fieldwork/api/search');
    assert.ok(search.includes('createFormSession'));
    assert.ok(search.includes('Quickstart'));
    const markdown = await get('/fieldwork/llms.mdx/docs/0.x/getting-started/quickstart/content.md');
    assert.ok(markdown.includes('createFieldwork'));
    const index = await get('/fieldwork/llms.txt');
    assert.ok(index.includes('https://docs.nickwelsh.me/fieldwork/docs/0.x'));

    const html = await get('/fieldwork/docs/0.x/getting-started/installation/');
    assert.ok(html.includes('/apps/docs/content/docs/0.x/getting-started/installation.mdx'));
    const stylesheet = /href="(?<stylesheet>\/fieldwork\/assets\/[^"]+\.css)"/u.exec(html)?.groups?.stylesheet;
    assert.ok(stylesheet !== undefined);
    await get(stylesheet);
    const missing = await runtime.dispatchFetch(new URL('/fieldwork/does-not-exist', origin));
    assert.equal(missing.status, 404);
    const missingHtml = await missing.text();
    assert.ok(missingHtml.includes('Page not found'));
} finally {
    await runtime.dispose();
}
