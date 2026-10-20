import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, stat, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const home = fields[5], uid = Number(fields[2]), gid = Number(fields[3]);
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const fixture = `${home}/tuxee-upload-fixtures`, source = await mkdtemp(`${tmpdir()}/tuxee-upload-`);
await rm(fixture, { recursive: true, force: true });
await mkdir(fixture, { mode: 0o700 }); await chown(fixture, uid, gid);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
assert.equal((await api('/files', 'POST', { operation: 'mkdir', path: home + '/uploads', parents: true })).status(), 200);
const settings = { theme: 'dark', current: 'uploads', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 5 }, workspaces: [
    { id: 'uploads', name: 'Uploads', columns: 4, rows: 2, active: 'files', panels: [
        { id: 'files', kind: 'files', path: fixture, x: 0, y: 0, w: 2, h: 1 },
        { id: 'term', kind: 'terminal', path: fixture, x: 2, y: 0, w: 2, h: 1 },
        { id: 'uploads-a', kind: 'files', path: home + '/uploads', x: 0, y: 1, w: 2, h: 1 },
        { id: 'uploads-b', kind: 'files', path: home + '/uploads/', x: 2, y: 1, w: 2, h: 1 },
    ] },
] };
assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
const page = await context.newPage(), errors = [], external = [], published = [], lists = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (request.url() === base + '/api/files' && request.postDataJSON()?.operation === 'list') lists.push(request.postDataJSON().path);
});
page.on('request', request => { if (!request.url().startsWith(base + '/') && !/^(data|blob):/.test(request.url())) external.push(request.url()); });
const cdp = await context.newCDPSession(page);
const file = page.locator('[data-panel=files]'), terminal = page.locator('[data-panel=term]');
const transfer = owner => owner.locator('.transfer').last();
const done = async owner => { await transfer(owner).filter({ hasText: ' · Done' }).waitFor({ timeout: 30000 }); };
const check = label => console.log(`PASS ${label}`);
async function drop(target, paths) {
    const box = await target.boundingBox(); assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const data = { items: [], files: paths, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
        if (type === 'dragOver') {
            const overlay = await target.evaluate(node => {
                const view = node.closest('.panel')?.querySelector('.terminal-view');
                if (!view) return null;
                const style = getComputedStyle(view, '::after');
                return { state: view.dataset.state, label: view.getAttribute('data-drop'), content: style.content, fill: style.backgroundColor, border: style.borderTopStyle, z: Number(style.zIndex), pointerEvents: style.pointerEvents };
            });
            if (overlay?.state === 'connected') {
                assert.equal(overlay.label, 'Upload and paste'); assert.equal(overlay.content, '"Upload and paste"');
                assert.notEqual(overlay.fill, 'rgba(0, 0, 0, 0)'); assert.notEqual(overlay.fill, 'transparent');
                assert.equal(overlay.border, 'dashed'); assert.ok(overlay.z > 10); assert.equal(overlay.pointerEvents, 'none');
            } else if (overlay) assert.equal(overlay.label, null);
        }
    }
    assert.equal(await target.evaluate(node => node.closest('.panel')?.querySelector('.terminal-view')?.getAttribute('data-drop') ?? null), null);
}
async function pasteImage(target) {
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 3; canvas.height = 2;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#32a15c'; ctx.fillRect(0, 0, 3, 2);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    });
    await target.focus();
    const response = page.waitForResponse(response => response.ok() && response.url().includes('/api/upload?'));
    await page.keyboard.press(await target.evaluate(node => node.classList.contains('xterm-helper-textarea')) ? 'Shift+Insert' : 'Control+V');
    return (await (await response).json()).path;
}
async function expectFile(path, contents) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (await readFile(path, 'utf8').catch(() => null) === contents) return;
        await page.waitForTimeout(50);
    }
    assert.equal(await readFile(path, 'utf8'), contents);
}
async function navigate(path) {
    await file.getByRole('textbox', { name: 'Directory path' }).fill(path);
    const response = page.waitForResponse(r => r.url().endsWith('/api/files') && r.request().postDataJSON()?.operation === 'list');
    await file.getByRole('textbox', { name: 'Directory path' }).press('Enter'); await response;
}
async function uploadedRows(path) {
    for (const id of ['uploads-a', 'uploads-b'])
        await page.locator(`[data-panel="${id}"] .file-entry`).filter({ hasText: path.split('/').at(-1) }).waitFor();
    assert.deepEqual(lists, [home + '/uploads', home + '/uploads'], 'refresh each matching browser once and leave unrelated folders alone');
    assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => document.activeElement === node), 'automatic refresh preserves terminal focus');
}
let session, releaseList = () => {};
try {
    await page.goto(base); await terminal.locator('[data-state=connected]').waitFor();
    session = await terminal.locator('[data-terminal]').getAttribute('data-terminal');
    await file.locator('.file-list').waitFor();
    await page.evaluate(() => {
        window.batchCount = 0; window.maxTransfers = 0;
        new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.transfer')) window.batchCount++;
            window.maxTransfers = Math.max(window.maxTransfers, document.querySelectorAll('.transfer').length);
        }).observe(document.body, { childList: true, subtree: true });
    });
    const folder = `${source}/bundle`, loose = `${source}/loose.txt`;
    await mkdir(folder + '/nested/empty', { recursive: true });
    for (let i = 0; i < 105; i++) await writeFile(`${folder}/file-${i}.txt`, `entry ${i}\n`);
    await writeFile(folder + '/nested/deep.txt', 'nested bytes'); await writeFile(loose, 'loose bytes');
    await drop(file.locator('.file-list'), [folder, loose]); await done(file);
    assert.equal((await readdir(fixture + '/bundle')).length, 106);
    for (let i = 0; i < 105; i++) assert.equal(await readFile(`${fixture}/bundle/file-${i}.txt`, 'utf8'), `entry ${i}\n`);
    assert.equal(await readFile(fixture + '/bundle/nested/deep.txt', 'utf8'), 'nested bytes');
    assert.ok((await stat(fixture + '/bundle/nested/empty')).isDirectory());
    assert.equal(await readFile(fixture + '/loose.txt', 'utf8'), 'loose bytes');
    assert.equal((await stat(fixture + '/loose.txt')).uid, uid);
    assert.equal(await page.evaluate(() => window.batchCount), 1);
    assert.equal(await page.evaluate(() => window.maxTransfers), 1);
    assert.match(await transfer(file).innerText(), /107\/107 files.*\/.*Done/);
    check('real native folder drop: more than 100 entries, nested/empty folders, exact bytes, Linux ownership and one batch indicator');

    await drop(file.locator('.panel-header'), [folder, loose]); await done(file);
    assert.equal(await readFile(fixture + '/bundle (1)/nested/deep.txt', 'utf8'), 'nested bytes');
    assert.equal(await readFile(fixture + '/loose (1).txt', 'utf8'), 'loose bytes');
    assert.equal(await readFile(fixture + '/loose.txt', 'utf8'), 'loose bytes');
    check('repeat uploads allocate numbered files/folders and preserve originals');

    const before = await page.evaluate(() => window.batchCount), url = page.url();
    await drop(page.locator('.topbar'), [loose]); await page.waitForTimeout(300);
    assert.equal(page.url(), url); assert.equal(await page.evaluate(() => window.batchCount), before);
    check('external file drops outside panels cannot navigate or upload');

    const firstImage = await pasteImage(file.locator('.file-list')); await done(file);
    assert.equal(firstImage, fixture + '/clipboard-image.png');
    const png = await readFile(firstImage); assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const nextImage = await pasteImage(file.locator('.file-list')); await done(file);
    assert.equal(nextImage, fixture + '/clipboard-image (1).png'); assert.deepEqual(await readFile(nextImage), png);
    check('real clipboard PNG paste uploads and increments names');

    const input = terminal.locator('.xterm-helper-textarea');
    await input.focus(); await page.keyboard.type(`printf '%s\\n' `);
    const quoted = `${source}/host's file.txt`; await writeFile(quoted, 'terminal bytes');
    const previousUploads = new Set(await readdir(home + '/uploads').catch(() => []));
    let listRead, interceptList = true;
    const oldListReady = new Promise(resolve => { listRead = resolve; });
    const releaseOldList = new Promise(resolve => { releaseList = resolve; });
    await page.route(base + '/api/files', async route => {
        const data = route.request().postDataJSON();
        if (!interceptList || data?.operation !== 'list' || data.path !== home + '/uploads') return route.continue();
        interceptList = false;
        const response = await route.fetch(); listRead();
        await releaseOldList; await route.fulfill({ response });
    });
    await page.locator('[data-panel=uploads-a]').getByRole('button', { name: 'Refresh files' }).click();
    await oldListReady;
    lists.length = 0;
    await drop(terminal.locator('.terminal-host'), [quoted]); await done(terminal);
    const added = (await readdir(home + '/uploads')).filter(name => !previousUploads.has(name));
    assert.equal(added.length, 1);
    const terminalPath = home + '/uploads/' + added[0]; published.push(terminalPath); assert.equal(await readFile(terminalPath, 'utf8'), 'terminal bytes');
    releaseList();
    await uploadedRows(terminalPath);
    await page.unroute(base + '/api/files');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes("host'\\''s file"));
    await input.focus();
    await page.keyboard.type(`> '${fixture}/terminal-paths'`);
    await assert.rejects(stat(fixture + '/terminal-paths'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(path => document.querySelector('.xterm-rows')?.textContent.includes(path), 'terminal-paths');
    await expectFile(fixture + '/terminal-paths', terminalPath + '\n');
    check('native terminal drop uploads into ~/uploads, refreshes even after a delayed stale listing, and pastes quoted paths without Enter');

    await input.focus(); await page.keyboard.type(`printf '%s\\n' `);
    lists.length = 0;
    const terminalImage = await pasteImage(input); published.push(terminalImage); await done(terminal);
    assert.ok(terminalImage.startsWith(home + '/uploads/clipboard-image'));
    assert.deepEqual(await readFile(terminalImage), png);
    await uploadedRows(terminalImage);
    await page.keyboard.type(`> '${fixture}/clipboard-path'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/clipboard-path', terminalImage + '\n');
    check('terminal drops and clipboard images refresh both uploads browsers once, preserve terminal focus and paste actual paths');

    await page.evaluate(() => navigator.clipboard.writeText('printf text-paste-ok'));
    await input.focus(); await page.keyboard.press('Control+Shift+V'); await page.keyboard.type(` > '${fixture}/plain-paste'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/plain-paste', 'text-paste-ok');
    check('normal terminal text paste is unchanged');

    // Browsers cannot populate an OS file-manager clipboard through the Clipboard API.
    // Exercise the exposed File payload without mocking the upload or filesystem.
    await file.locator('.file-list').evaluate(node => {
        const data = new DataTransfer(); data.items.add(new File(['clipboard document'], 'pasted.txt', { type: 'text/plain' }));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }); await done(file);
    assert.equal(await readFile(fixture + '/pasted.txt', 'utf8'), 'clipboard document');
    check('clipboard file payload uses the same upload pipeline');

    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 500, downloadThroughput: -1, uploadThroughput: -1 });
    const listRequest = page.waitForRequest(request => request.url().endsWith('/api/files') && request.postDataJSON()?.operation === 'list');
    await file.locator('.file-list').focus(); await page.keyboard.press('F5'); await listRequest;
    await input.focus(); await page.keyboard.type('printf focus-kept');
    await file.locator('.file-list.loading').waitFor({ state: 'hidden' });
    assert.ok(await input.evaluate(node => document.activeElement === node), 'a delayed list response stole terminal focus');
    await page.keyboard.type(` > '${fixture}/focus-kept'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/focus-kept', 'focus-kept');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    check('delayed folder refresh cannot steal focus or interrupt typing in another component');

    const terminalFolder = `${source}/terminal-bundle`;
    await mkdir(terminalFolder + '/empty', { recursive: true });
    await writeFile(terminalFolder + '/inside.txt', 'folder to terminal');
    const previousFolders = new Set(await readdir(home + '/uploads'));
    await input.focus(); await page.keyboard.type(`printf '%s\\n' `);
    lists.length = 0;
    await drop(terminal.locator('.panel-header'), [terminalFolder]); await done(terminal);
    const addedFolders = (await readdir(home + '/uploads')).filter(name => !previousFolders.has(name));
    assert.equal(addedFolders.length, 1);
    const folderPath = home + '/uploads/' + addedFolders[0]; published.push(folderPath);
    await uploadedRows(folderPath);
    assert.equal(await readFile(folderPath + '/inside.txt', 'utf8'), 'folder to terminal');
    assert.ok((await stat(folderPath + '/empty')).isDirectory());
    await input.focus(); await page.keyboard.type(`> '${fixture}/folder-path'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/folder-path', folderPath + '\n');
    check('terminal folder drop pastes just the uploaded root, preserving its hierarchy');

    await file.getByRole('button', { name: 'Filter files', exact: true }).click();
    const filter = file.getByRole('searchbox', { name: 'Filter files' });
    await page.evaluate(() => navigator.clipboard.writeText('loose'));
    const batchesBeforeText = await page.evaluate(() => window.batchCount);
    await filter.focus(); await page.keyboard.press('Control+V');
    assert.equal(await filter.inputValue(), 'loose');
    assert.equal(await page.evaluate(() => window.batchCount), batchesBeforeText);
    await filter.press('Escape');
    check('paste in editable file-browser fields remains normal text editing');

    const slowTerminalFile = source + '/slow-terminal.bin';
    await writeFile(slowTerminalFile, Buffer.alloc(256 * 1024, 4));
    const beforeSlowUpload = new Set(await readdir(home + '/uploads'));
    await navigate(home + '/uploads');
    await input.focus(); await page.keyboard.type(`printf '%s\\n' `);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await drop(terminal.locator('.terminal-host'), [slowTerminalFile]);
    await transfer(terminal).filter({ hasText: '0/1 files' }).waitFor();
    await file.getByRole('button', { name: 'Filter files', exact: true }).click();
    await filter.fill('keep typing'); await done(terminal);
    assert.ok(await filter.evaluate(node => document.activeElement === node), 'terminal upload completion stole focus');
    assert.equal(await filter.inputValue(), 'keep typing');
    const addedSlowFiles = (await readdir(home + '/uploads')).filter(name => !beforeSlowUpload.has(name));
    assert.equal(addedSlowFiles.length, 1);
    const slowPath = home + '/uploads/' + addedSlowFiles[0]; published.push(slowPath);
    assert.deepEqual(await readFile(slowPath), Buffer.alloc(256 * 1024, 4));
    await filter.press('Escape');
    await input.focus(); await page.keyboard.type(`> '${fixture}/slow-path'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/slow-path', slowPath + '\n');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await navigate(fixture);
    check('terminal upload completion pastes into its target without stealing focus from another field');

    await mkdir(fixture + '/other'); await chown(fixture + '/other', uid, gid);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await file.locator('input[type=file]').setInputFiles([
        { name: 'snapshot.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(256 * 1024, 3) },
        { name: 'snapshot.txt', mimeType: 'text/plain', buffer: Buffer.from('original directory') },
    ]);
    await transfer(file).filter({ hasText: '0/2 files' }).waitFor();
    await navigate(fixture + '/other'); await done(file);
    assert.equal((await readFile(fixture + '/snapshot.bin')).length, 256 * 1024);
    assert.equal(await readFile(fixture + '/snapshot.txt', 'utf8'), 'original directory');
    assert.deepEqual(await readdir(fixture + '/other'), []);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await navigate(fixture);
    check('navigation during a batch keeps every file in the captured destination');

    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await file.locator('input[type=file]').setInputFiles([
        { name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('completed before cancellation') },
        { name: 'cancel.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8 * 1024 * 1024, 7) },
        { name: 'never.txt', mimeType: 'text/plain', buffer: Buffer.from('must not upload') },
    ]);
    await transfer(file).filter({ hasText: '1/3 files' }).waitFor();
    await transfer(file).getByRole('button', { name: 'Cancel transfer' }).click();
    await transfer(file).filter({ hasText: 'Cancelled' }).waitFor();
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForTimeout(300);
    await assert.rejects(stat(fixture + '/cancel.bin')); await assert.rejects(stat(fixture + '/never.txt'));
    await file.locator('.file-entry').filter({ hasText: 'kept.txt' }).waitFor();
    assert.equal(await readFile(fixture + '/kept.txt', 'utf8'), 'completed before cancellation');
    assert.ok(!(await readdir(fixture)).some(name => name.startsWith('.tuxee-upload-')));
    check('cancelling a bundle removes active staging and stops queued files');
    await api(`/terminals/${session}`, 'DELETE');
    await terminal.locator('[data-state=ended]').waitFor();
    const beforeRejected = await page.evaluate(() => window.batchCount);
    await drop(terminal.locator('.panel-header'), [loose]);
    assert.equal(await page.evaluate(() => window.batchCount), beforeRejected);
    check('ended terminal rejects external uploads');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compact-board').waitFor();
    await file.locator('.file-list').waitFor();
    const mobileImage = await pasteImage(file.locator('.file-list')); await done(file);
    assert.equal(mobileImage, fixture + '/clipboard-image (2).png');
    assert.deepEqual(await readFile(mobileImage), png);
    const progressBox = await transfer(file).boundingBox();
    assert.ok(progressBox.x >= 0 && progressBox.x + progressBox.width <= 390);
    check('clipboard uploads and batch indicator also fit the compact file-browser view');
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/uploads-mobile.png' });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
} finally {
    releaseList();
    await page.waitForTimeout(350);
    await page.goto('about:blank');
    await api('/settings', 'PUT', original);
    if (session) await api(`/terminals/${session}`, 'DELETE');
    await browser.close();
    for (const path of published) await rm(path, { force: true, recursive: true });
    await rm(source, { recursive: true, force: true });
}
