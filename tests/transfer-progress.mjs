import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-progress-');
await mkdir(dir + '/copies'); await mkdir(dir + '/moved');
for (const name of ['alpha.txt', 'beta.txt']) await writeFile(`${dir}/${name}`, name);
await writeFile(dir + '/broken.tar.gz', 'not an archive');
assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
await mkdir('test-results', { recursive: true });
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await appPage(context), errors = [];
page.on('pageerror', error => errors.push(error.message));
const file = page.locator('[data-panel=files]'), transfer = file.locator('.transfer').last(), progress = transfer.locator('progress');
const row = name => file.locator('.file-entry').filter({ has: page.locator('.file-name span', { hasText: new RegExp('^' + name.replaceAll('.', '\\.') + '$') }) });
const done = () => transfer.filter({ hasText: ' · Done' }).waitFor();
const cdp = await context.newCDPSession(page);
let release = () => {};

async function hold(operation, at = 1) {
    let count = 0, arrived;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/files', async route => {
        if (route.request().postDataJSON()?.operation === operation && ++count === at) { arrived(); await gate; }
        await route.continue();
    });
    return waiting;
}
async function resume() { release(); await done(); await page.unroute('**/api/files'); }
async function checkBar(name, indeterminate = false) {
    assert.equal(await progress.evaluate(node => node.matches(':indeterminate')), indeterminate);
    const track = transfer.locator('.transfer-progress');
    assert.equal(await track.evaluate(node => node.clientHeight), 2);
    assert.equal(await progress.evaluate(node => node.getBoundingClientRect().height), 4);
    if (indeterminate) {
        const positions = await track.evaluate(node => {
            const animation = node.getAnimations({ subtree: true })[0];
            if (!animation) throw Error('missing indeterminate animation');
            animation.pause();
            const positions = [0, 1200, 2400].map(time => { animation.currentTime = time; return parseFloat(getComputedStyle(node, '::after').left); });
            animation.currentTime = 0;
            return { positions, name: getComputedStyle(node, '::after').animationName, width: node.clientWidth };
        });
        assert.equal(positions.name, 'connection-spring');
        assert.deepEqual(positions.positions.map(x => Math.round(x)), [0, Math.round(positions.width * .8), 0]);
    }
    const before = indeterminate ? 20 : await progress.evaluate(node => node.value);
    const bounds = await track.boundingBox();
    const png = (await page.screenshot({ path: `test-results/transfer-${name}.png` })).toString('base64');
    const after = indeterminate ? 20 : await progress.evaluate(node => node.value);
    const pixels = await page.evaluate(async ({ png, bounds }) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const style = getComputedStyle(document.documentElement);
        const rgb = name => style.getPropertyValue(name).trim().slice(1).match(/../g).map(value => parseInt(value, 16));
        const accent = rgb('--accent'), line = rgb('--line');
        const x = Math.round(bounds.x), y = Math.round(bounds.y), width = Math.floor(bounds.width);
        const pixel = (dx, dy) => [...ctx.getImageData(x + dx, y + dy, 1, 1).data].slice(0, 3);
        const matches = color => Array.from({ length: width }, (_, i) => pixel(i, 0).every((value, c) => value === color[c]));
        return { accent, line, fill: matches(accent).filter(Boolean).length, track: matches(line).filter(Boolean).length,
            thickness: [-1, 0, 1, 2].map(dy => pixel(8, dy)) };
    }, { png, bounds });
    assert.ok(pixels.fill >= bounds.width * Math.min(before, after) / 100 - 4, `${name}: missing accent fill`);
    assert.ok(pixels.fill <= bounds.width * Math.max(before, after) / 100 + 4, `${name}: fill exceeds reported progress`);
    for (const color of pixels.thickness) assert.deepEqual(color, pixels.accent, `${name}: fill must be 4px tall and start at the left`);
    if (after < 90) assert.ok(pixels.track > bounds.width * (1 - Math.max(before, after) / 100) - 5, `${name}: missing thin track`);
    if (indeterminate) await track.evaluate(node => node.getAnimations({ subtree: true })[0].play());
}

try {
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'progress', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 5 }, workspaces: [
        { id: 'progress', name: 'Progress', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 2, h: 2 }] },
    ] })).status(), 200);
    await page.goto(base); await row('alpha.txt').waitFor();
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    const payload = Buffer.alloc(1024 * 1024, 7);
    await file.locator('input[type=file]').setInputFiles({ name: 'upload.bin', mimeType: 'application/octet-stream', buffer: payload });
    await page.waitForFunction(() => document.querySelector('.transfer progress')?.value > 25);
    await checkBar('upload-dark');
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await checkBar('upload-light');
    await done(); assert.deepEqual(await readFile(dir + '/upload.bin'), payload);
    await checkBar('upload-done');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    console.log('PASS real upload fills left to right with a 2px track and 4px accent fill in both themes, then reaches 100%');

    for (const [operation, destination] of [['copy', 'copies'], ['move', 'moved']]) {
        await row('alpha.txt').click(); await row('beta.txt').click({ modifiers: ['Control'] });
        const waiting = hold(operation, 2);
        await row('alpha.txt').click({ button: 'right' });
        await page.getByRole('menuitem', { name: operation === 'copy' ? 'Copy to…' : 'Move to…', exact: true }).click();
        await page.getByRole('dialog').getByRole('textbox').fill(`${dir}/${destination}`);
        await page.getByRole('button', { name: 'Continue', exact: true }).click(); await waiting;
        assert.equal(await progress.evaluate(node => node.value), 50);
        await checkBar(operation); await resume();
        for (const name of ['alpha.txt', 'beta.txt']) assert.equal(await readFile(`${dir}/${destination}/${name}`, 'utf8'), name);
        if (operation === 'move') await assert.rejects(readFile(dir + '/alpha.txt'), { code: 'ENOENT' });
    }
    console.log('PASS copy and move show completed-item progress; real destination contents and moved sources verified');

    let waiting = hold('compress');
    await row('upload.bin').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Compress…', exact: true }).click();
    await page.getByRole('combobox', { name: 'Archive format' }).selectOption('tar.gz');
    await page.getByRole('textbox', { name: 'Archive name' }).fill('archive.tar.gz');
    await page.getByRole('button', { name: 'Compress', exact: true }).click(); await waiting;
    await checkBar('compress', true); await resume(); await row('archive.tar.gz').waitFor();
    waiting = hold('extract');
    await row('archive.tar.gz').dblclick(); await page.getByRole('textbox', { name: 'Extract folder' }).fill('extracted');
    await page.getByRole('button', { name: 'Extract', exact: true }).click(); await waiting;
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    await checkBar('extract-mobile', true); await resume();
    assert.deepEqual(await readFile(dir + '/extracted/upload.bin'), payload);
    console.log('PASS compression and extraction reuse the bidirectional disconnect animation until completion, including mobile');

    await row('broken.tar.gz').dblclick(); await page.getByRole('button', { name: 'Extract', exact: true }).click();
    await transfer.locator(':scope.failed').waitFor();
    assert.ok(await progress.evaluate(node => node.matches(':indeterminate')));
    assert.equal(await transfer.locator('.transfer-progress').evaluate(node => getComputedStyle(node, '::after').animationPlayState), 'paused');
    console.log('PASS failed extraction stops its unknown-progress animation');

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await file.locator('input[type=file]').setInputFiles({ name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8 * 1024 * 1024) });
    await transfer.filter({ hasText: 'Uploading' }).waitFor();
    await transfer.getByRole('button', { name: 'Cancel transfer' }).click(); await transfer.filter({ hasText: 'Cancelled' }).waitFor();
    assert.ok(await progress.evaluate(node => node.value < 100));
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await assert.rejects(readFile(dir + '/cancel.bin'), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
    console.log('PASS cancelled upload retains incomplete progress and publishes no file; no browser exceptions');
} finally {
    release(); await page.unrouteAll({ behavior: 'wait' });
    await page.goto('about:blank'); await api('/settings', 'PUT', original);
    await browser.close(); await rm(dir, { recursive: true, force: true });
}
