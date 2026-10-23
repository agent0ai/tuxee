import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const fixture = await mkdtemp(fields[5] + '/tuxee-upload-benchmark-');
await chown(fixture, Number(fields[2]), Number(fields[3]));
const state = await mkdtemp('/tmp/tuxee-upload-benchmark-');
await mkdir(state + '/source');
await copyFile(resolve(process.argv[2] || 'bin/tuxee'), state + '/tuxee');
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, context, original, api;
const results = [];
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const me = await (await context.request.get(base + '/api/me')).json(); original = me.settings;
    api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'benchmark', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 5 }, workspaces: [
        { id: 'benchmark', name: 'Benchmark', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: fixture, x: 0, y: 0, w: 2, h: 2 }] },
    ] })).status(), 200);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.locator('.file-list').waitFor();
    await page.evaluate(() => {
        window.finished = 1; window.progressValues = [];
        document.querySelector('input[type=file]').addEventListener('change', () => { window.started = performance.now(); window.finished = 0; window.progressValues = []; });
        new MutationObserver(() => {
            const view = [...document.querySelectorAll('.transfer')].at(-1);
            if (!view || window.finished) return;
            const progress = view.querySelector('progress');
            if (progress.hasAttribute('value')) window.progressValues.push(progress.value);
            if (view.textContent.includes(' · Done') || view.classList.contains('failed')) window.finished = performance.now();
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['value', 'class'] });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    let active = new Set(), maximum = 0, requests = 0;
    page.on('request', request => { if (request.url().includes('/api/upload?')) { active.add(request); requests++; maximum = Math.max(maximum, active.size); } });
    page.on('response', response => active.delete(response.request()));
    page.on('requestfailed', request => active.delete(request));
    for (const latency of [0, 100]) for (const [count, bytes] of [[100, 4096], [500, 4096], [1, 20 * 1024 * 1024]]) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: 20 * 1024 * 1024, uploadThroughput: 20 * 1024 * 1024 });
        for (let trial = 1; trial <= 3; trial++) {
            const prefix = `${latency}-${count}-${trial}`;
            const files = Array.from({ length: count }, (_, i) => `${prefix}-${i}.bin`);
            for (const [i, name] of files.entries()) await writeFile(`${state}/source/${name}`, Buffer.alloc(bytes, i % 251));
            active = new Set(); maximum = 0; requests = 0;
            await page.locator('input[type=file]').setInputFiles(files.map(name => `${state}/source/${name}`));
            await page.waitForFunction(() => window.finished > 0, null, { timeout: 120000 });
            const view = page.locator('.transfer').last();
            assert.match(await view.innerText(), new RegExp(`${count}/${count} files.* · Done$`));
            const timing = await page.evaluate(() => ({ seconds: (window.finished - window.started) / 1000, progress: window.progressValues }));
            assert.ok(timing.progress.every((value, i, all) => value >= 0 && value <= 100 && (!i || value >= all[i - 1])), 'aggregate progress must not go backwards or exceed 100%');
            assert.equal(requests, count);
            for (const [i, name] of files.entries()) assert.deepEqual(await readFile(`${fixture}/${name}`), Buffer.alloc(bytes, i % 251));
            const result = { latencyMS: latency, files: count, bytesPerFile: bytes, trial, seconds: Number(timing.seconds.toFixed(3)), maxConcurrentRequests: maximum };
            results.push(result); console.log(JSON.stringify(result));
            for (const name of files) { await rm(`${fixture}/${name}`); await rm(`${state}/source/${name}`); }
        }
    }
    assert.deepEqual(errors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile(process.argv[3] || 'test-results/upload-benchmark.json', JSON.stringify(results, null, 2) + '\n');
} finally {
    try {
        if (context) for (const page of context.pages()) await page.close();
        if (original) assert.equal((await api('/settings', 'PUT', original)).status(), 200);
    } finally {
        await browser?.close();
        server.kill('SIGTERM'); await stopped;
        await rm(fixture, { recursive: true, force: true });
        await rm(state, { recursive: true, force: true });
    }
}
