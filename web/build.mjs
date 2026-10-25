import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
await build({ entryPoints: ['web/terminal/runtime.ts'], bundle: true, format: 'iife', globalName: 'tuxeeEngine', platform: 'browser', target: 'es2015', minify: true, outfile: 'internal/terminal/engine.js', banner: { js: 'globalThis.TextEncoder = class { encode(s) { return new Uint8Array(__encodeUTF8(s)); } };' } });
await rm('web/dist', { recursive: true, force: true });
await mkdir('web/dist', { recursive: true });
const bundle = await build({ entryPoints: ['web/app.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outdir: 'web/dist', write: false, metafile: true, legalComments: 'eof', loader: { '.webp': 'file' }, assetNames: 'assets/[name]-[hash]', publicPath: '/' });
assert.ok(Object.values(bundle.metafile.outputs).every(output => output.imports.every(imported => !imported.external || imported.kind === 'url-token' && imported.path.startsWith('data:'))), 'frontend must have no external runtime imports');
for (const file of bundle.outputFiles.filter(file => !/\.(js|css)$/.test(file.path))) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
}
const script = bundle.outputFiles.find(file => file.path.endsWith('/app.js')).text.replace(/<\/script/gi, '<\\/script');
const styles = bundle.outputFiles.find(file => file.path.endsWith('/app.css')).text;
const source = await readFile('web/index.html', 'utf8');
const html = source.replace('<!-- tuxee:styles -->', () => `<style>${styles}</style>`).replace('<!-- tuxee:script -->', () => `<script type="module">${script}</script>`);
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html), 'frontend must not load external assets');
await writeFile('web/dist/index.html', html);
await writeFile('web/dist/script-csp.txt', createHash('sha256').update(script).digest('base64'));
await build({ entryPoints: ['web/sw.js'], bundle: true, minify: true, target: 'es2022', outfile: 'web/dist/sw.js' });
for (const asset of ['favicon.png', 'social-preview.jpg']) await cp(`web/${asset}`, `web/dist/${asset}`);
await cp('third_party', 'web/dist/licenses', { recursive: true, filter: source => !source.endsWith('AGENTS.md') });
await cp('THIRD_PARTY_NOTICES.md', 'web/dist/licenses/THIRD_PARTY_NOTICES.md');
console.log(`Local frontend: ${Math.round(Buffer.byteLength(html) / 1024)} KB, ${Math.round(gzipSync(html).length / 1024)} KB gzip; no CDN assets.`);
