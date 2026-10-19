import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
    cleanBuildOutputDir,
    getWorkerAssetsDir,
    readBuildOutput,
    writeRootConfig,
    writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import config from './cloudflare.config.ts';

// docs-base prerenders pages, RSC payloads, search, and Markdown endpoints.
// Preserve its public prefix in the asset tree so Workers serves the same URLs.
const root = process.cwd();
await cleanBuildOutputDir(root);
const assets = getWorkerAssetsDir(root);
await mkdir(assets, { recursive: true });
await cp(path.join(root, 'dist/public'), path.join(assets, 'fieldwork'), { recursive: true });
await writeRootConfig(root, undefined, { mode: 'production', isPreview: false });
await writeWorkerConfig({ root, config: config.worker });
await readBuildOutput(root);
