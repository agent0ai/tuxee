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
const terminalInputs = [];
page.on('websocket', socket => {
    if (/\/api\/terminals\/[^/]+\/ws$/.test(socket.url())) socket.on('framesent', frame => {
        if (Buffer.isBuffer(frame.payload)) terminalInputs.push(frame.payload);
    });
});
const activeUploads = new Set(); let maxUploads = 0;
page.on('request', request => { if (request.url().includes('/api/upload?')) { activeUploads.add(request); maxUploads = Math.max(maxUploads, activeUploads.size); } });
page.on('response', response => activeUploads.delete(response.request()));
page.on('requestfailed', request => activeUploads.delete(request));
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
    await file.getByRole('textbox', { name: 'File or directory path' }).fill(path);
    const response = page.waitForResponse(r => r.url().endsWith('/api/files') && r.request().postDataJSON()?.operation === 'list');
    await file.getByRole('textbox', { name: 'File or directory path' }).press('Enter'); await response;
}
async function uploadedRows(path) {
    for (const id of ['uploads-a', 'uploads-b'])
        await page.locator(`[data-panel="${id}"] .file-entry`).filter({ hasText: path.split('/').at(-1) }).waitFor();
    assert.deepEqual(lists, [home + '/uploads', home + '/uploads'], 'refresh each matching browser once and leave unrelated folders alone');
    assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => document.activeElement === node), 'automatic refresh preserves terminal focus');
}
async function openUploadSettings() {
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    return page.getByRole('combobox', { name: 'Parallel uploads', exact: true });
}
async function saveUploadSettings(count) {
    await (await openUploadSettings()).selectOption(String(count));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'detached' });
    assert.equal((await (await api('/me')).json()).settings.uploadConcurrency, count);
}
let session, releaseList = () => {}, releaseUploads = () => {};
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
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: -1, uploadThroughput: -1 });
    await drop(file.locator('.file-list'), [folder, loose]); await done(file);
    assert.equal(maxUploads, 4, 'folder uploads should fill four slots without exceeding the batch limit');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
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

    await saveUploadSettings(8);
    await (await openUploadSettings()).selectOption('1');
    const rejectSave = route => route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), uploadConcurrency: 9 }) });
    await page.route('**/api/settings', rejectSave);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('parallel uploads must be between 1 and 8', { exact: true }).waitFor();
    await page.unroute('**/api/settings', rejectSave);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal((await (await api('/me')).json()).settings.uploadConcurrency, 8);
    const configuredFiles = Array.from({ length: 24 }, (_, i) => ({ name: `configured-${i}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096, i) }));
    let arrivals = 0, firstWave;
    const ready = new Promise(resolve => { firstWave = resolve; });
    const held = new Promise(resolve => { releaseUploads = resolve; });
    const holdUploads = async route => {
        const response = await route.fetch();
        if (++arrivals <= 8) {
            if (arrivals === 8) firstWave();
            await held;
        } else await new Promise(resolve => setTimeout(resolve, 100));
        await route.fulfill({ response });
    };
    await page.route('**/api/upload?*', holdUploads);
    maxUploads = 0;
    await file.locator('input[type=file]').setInputFiles(configuredFiles);
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(Error('eight uploads did not start')), 10000))]);
    assert.equal(maxUploads, 8, 'failed save must preserve eight concurrent uploads');
    await saveUploadSettings(1);
    activeUploads.clear(); maxUploads = 0; releaseUploads();
    await done(file);
    assert.equal(maxUploads, 8, 'a running batch must keep the limit captured at its start');
    await page.unroute('**/api/upload?*', holdUploads);
    for (const item of configuredFiles) assert.deepEqual(await readFile(`${fixture}/${item.name}`), item.buffer);
    maxUploads = 0;
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: -1, uploadThroughput: -1 });
    await file.locator('input[type=file]').setInputFiles(configuredFiles.slice(0, 4).map(item => ({ ...item, name: 'serial-' + item.name })));
    await done(file);
    assert.equal(maxUploads, 1, 'the saved setting must apply to the next batch');
    for (const item of configuredFiles.slice(0, 4)) assert.deepEqual(await readFile(`${fixture}/serial-${item.name}`), item.buffer);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await saveUploadSettings(4);
    check('saved parallelism controls real uploads, failed saves preserve it, and running batches retain their starting limit');

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
    const fastTerminalFile = source + '/fast-terminal.txt';
    await writeFile(fastTerminalFile, 'finished first');
    const completionOrder = [];
    const recordCompletion = response => {
        if (response.url().includes('/api/upload?')) completionOrder.push(new URL(response.url()).searchParams.get('path').split('/').at(-1));
    };
    page.on('response', recordCompletion);
    const beforeSlowUpload = new Set(await readdir(home + '/uploads'));
    await navigate(home + '/uploads');
    await input.focus(); await page.keyboard.type(`printf '%s\\n' `);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await drop(terminal.locator('.terminal-host'), [slowTerminalFile, fastTerminalFile]);
    await transfer(terminal).getByRole('button', { name: 'Cancel transfer', disabled: false }).waitFor();
    await file.getByRole('button', { name: 'Filter files', exact: true }).click();
    await filter.fill('keep typing'); await done(terminal);
    assert.ok(await filter.evaluate(node => document.activeElement === node), 'terminal upload completion stole focus');
    assert.equal(await filter.inputValue(), 'keep typing');
    const addedSlowFiles = (await readdir(home + '/uploads')).filter(name => !beforeSlowUpload.has(name));
    page.off('response', recordCompletion);
    assert.deepEqual(completionOrder, ['fast-terminal.txt', 'slow-terminal.bin']);
    assert.equal(addedSlowFiles.length, 2);
    const slowPath = home + '/uploads/' + addedSlowFiles.find(name => name.startsWith('slow-terminal'));
    const fastPath = home + '/uploads/' + addedSlowFiles.find(name => name.startsWith('fast-terminal'));
    published.push(slowPath, fastPath);
    assert.deepEqual(await readFile(slowPath), Buffer.alloc(256 * 1024, 4));
    assert.equal(await readFile(fastPath, 'utf8'), 'finished first');
    await filter.press('Escape');
    await input.focus(); await page.keyboard.type(`> '${fixture}/slow-path'`); await page.keyboard.press('Enter');
    await expectFile(fixture + '/slow-path', slowPath + '\n' + fastPath + '\n');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await navigate(fixture);
    check('out-of-order uploads paste paths in source order without stealing focus from another field');

    const toggleDrawer = terminal.getByRole('button', { name: 'Toggle terminal input', exact: true });
    const drawer = terminal.getByRole('textbox', { name: 'Terminal input drawer', exact: true, includeHidden: true });
    const pathText = path => `'${path.replaceAll("'", "'\\''")}' `;
    const beforeDrawerInput = terminalInputs.length;
    await toggleDrawer.click(); await drawer.fill('before REMOVE after');
    await drawer.evaluate(node => node.setSelectionRange(7, 13));
    const drawerImage = await pasteImage(drawer); published.push(drawerImage); await done(terminal);
    assert.deepEqual(await readFile(drawerImage), png);
    assert.equal(await drawer.inputValue(), 'before ' + pathText(drawerImage) + ' after');
    assert.deepEqual(await drawer.evaluate(node => [node.selectionStart, node.selectionEnd, node === document.activeElement]),
        [7 + pathText(drawerImage).length, 7 + pathText(drawerImage).length, true]);

    await drawer.fill('file: ');
    const filePaste = page.waitForResponse(response => response.ok() && response.url().includes('/api/upload?'));
    assert.ok(await drawer.evaluate(node => {
        const data = new DataTransfer(); data.items.add(new File(['drawer file bytes'], "drawer's file.txt", { type: 'text/plain' }));
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        node.dispatchEvent(event); return event.defaultPrevented;
    }));
    const drawerFile = (await (await filePaste).json()).path; published.push(drawerFile); await done(terminal);
    assert.equal(await readFile(drawerFile, 'utf8'), 'drawer file bytes');
    assert.equal(await drawer.inputValue(), 'file: ' + pathText(drawerFile));

    const drawerUploads = new Set(await readdir(home + '/uploads'));
    await drawer.fill('drop: ');
    await drop(terminal.locator('.terminal-host'), [quoted, terminalFolder]); await done(terminal);
    const dropped = (await readdir(home + '/uploads')).filter(name => !drawerUploads.has(name));
    assert.equal(dropped.length, 2);
    const droppedFile = home + '/uploads/' + dropped.find(name => name.startsWith("host's file"));
    const droppedFolder = home + '/uploads/' + dropped.find(name => name.startsWith('terminal-bundle'));
    published.push(droppedFile, droppedFolder);
    assert.equal(await drawer.inputValue(), 'drop: ' + pathText(droppedFile) + pathText(droppedFolder));
    assert.equal(await readFile(droppedFolder + '/inside.txt', 'utf8'), 'folder to terminal');

    const copiedRow = file.locator('.file-entry').filter({ has: page.locator('.file-name > span', { hasText: /^loose\.txt$/ }) });
    await drawer.fill('copied: ');
    await copiedRow.click(); await page.keyboard.press('Control+c');
    const beforeCopied = await page.evaluate(() => window.batchCount);
    await input.focus(); await page.keyboard.press('Shift+Insert');
    assert.equal(await drawer.inputValue(), 'copied: ' + pathText(fixture + '/loose.txt'));
    assert.equal(await page.evaluate(() => window.batchCount), beforeCopied, 'Tuxee paths are reused without upload');
    await drawer.fill('dragged: ');
    const from = await copiedRow.boundingBox(), to = await terminal.locator('.terminal-host').boundingBox();
    await page.mouse.move(from.x + 35, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 }); await page.mouse.up();
    assert.equal(await drawer.inputValue(), 'dragged: ' + pathText(fixture + '/loose.txt'));
    assert.ok(await drawer.evaluate(node => document.activeElement === node));

    await drawer.fill('draft ');
    await page.evaluate(() => navigator.clipboard.writeText('ordinary text'));
    await page.keyboard.press('Control+v');
    assert.equal(await drawer.inputValue(), 'draft ordinary text');
    const rendererImage = await pasteImage(input); published.push(rendererImage); await done(terminal);
    assert.equal(await drawer.inputValue(), 'draft ordinary text' + pathText(rendererImage));
    check('drawer receives real clipboard images, file payloads, native file/folder drops and internal copies/drags at its selection');

    for (const startOpen of [true, false]) {
        if (!startOpen) await toggleDrawer.click();
        await drawer.evaluate(node => { node.value = 'delayed: '; node.setSelectionRange(node.value.length, node.value.length); });
        const delayedBefore = new Set(await readdir(home + '/uploads'));
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
        await drop(terminal.locator('.terminal-host'), [slowTerminalFile]);
        await transfer(terminal).getByRole('button', { name: 'Cancel transfer', disabled: false }).waitFor();
        await toggleDrawer.click();
        await file.getByRole('button', { name: 'Filter files', exact: true }).click(); await filter.fill('keep focus');
        await done(terminal);
        const delayedFiles = (await readdir(home + '/uploads')).filter(name => !delayedBefore.has(name));
        assert.equal(delayedFiles.length, 1);
        const delayedPath = home + '/uploads/' + delayedFiles[0]; published.push(delayedPath);
        assert.equal(await drawer.inputValue(), 'delayed: ' + pathText(delayedPath));
        assert.equal(await drawer.isVisible(), !startOpen);
        assert.ok(await filter.evaluate(node => document.activeElement === node), 'drawer upload completion stole focus');
        await filter.press('Escape');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        if (startOpen) await toggleDrawer.click();
    }
    await page.screenshot({ path: 'test-results/terminal-drawer-uploads.png' });
    await toggleDrawer.click();
    assert.equal(terminalInputs.length, beforeDrawerInput, 'drawer file pastes and drops must never send PTY input');
    check('drawer upload completion preserves focus and draft across opening/closing, with no terminal input');

    await mkdir(fixture + '/other'); await chown(fixture + '/other', uid, gid);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await file.locator('input[type=file]').setInputFiles([
        { name: 'snapshot.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(256 * 1024, 3) },
        { name: 'snapshot.txt', mimeType: 'text/plain', buffer: Buffer.from('original directory') },
    ]);
    await transfer(file).getByRole('button', { name: 'Cancel transfer', disabled: false }).waitFor();
    await navigate(fixture + '/other'); await done(file);
    assert.equal((await readFile(fixture + '/snapshot.bin')).length, 256 * 1024);
    assert.equal(await readFile(fixture + '/snapshot.txt', 'utf8'), 'original directory');
    assert.deepEqual(await readdir(fixture + '/other'), []);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await navigate(fixture);
    check('navigation during a batch keeps every file in the captured destination');

    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    const cancelled = Array.from({ length: 4 }, (_, i) => `cancel-${i}.bin`);
    await writeFile(source + '/kept.txt', 'completed before cancellation');
    await writeFile(source + '/never.txt', 'must not upload');
    for (const name of cancelled) await writeFile(`${source}/${name}`, Buffer.alloc(8 * 1024 * 1024, 7));
    await file.locator('input[type=file]').setInputFiles(['kept.txt', ...cancelled, 'never.txt'].map(name => `${source}/${name}`));
    await transfer(file).filter({ hasText: '1/6 files' }).waitFor();
    await transfer(file).getByRole('button', { name: 'Cancel transfer' }).click();
    await transfer(file).filter({ hasText: 'Cancelled' }).waitFor();
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForTimeout(300);
    for (const name of [...cancelled, 'never.txt']) await assert.rejects(stat(`${fixture}/${name}`));
    await file.locator('.file-entry').filter({ hasText: 'kept.txt' }).waitFor();
    assert.equal(await readFile(fixture + '/kept.txt', 'utf8'), 'completed before cancellation');
    assert.ok(!(await readdir(fixture)).some(name => name.startsWith('.tuxee-upload-')));
    check('cancelling a bundle aborts all four active requests, preserves completed files and stops queued files');

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: 1024 * 1024, uploadThroughput: 128 * 1024 });
    await writeFile(source + '/incomplete.txt', 'short');
    const failUpload = async route => {
        if (new URL(route.request().url()).searchParams.get('path')?.endsWith('/incomplete.txt')) {
            await route.continue({ headers: { ...route.request().headers(), 'x-tuxee-size': '100' } });
        } else await route.continue();
    };
    await page.route('**/api/upload?*', failUpload);
    await file.locator('input[type=file]').setInputFiles(['incomplete.txt', ...cancelled.slice(0, 3), 'never.txt'].map(name => `${source}/${name}`));
    await transfer(file).filter({ hasText: 'incomplete upload' }).waitFor();
    assert.doesNotMatch(await transfer(file).innerText(), /Cancelled|Done/);
    await page.unroute('**/api/upload?*', failUpload);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForTimeout(300);
    for (const name of ['incomplete.txt', ...cancelled, 'never.txt']) await assert.rejects(stat(`${fixture}/${name}`));
    assert.ok(!(await readdir(fixture)).some(name => name.startsWith('.tuxee-upload-')));
    check('a real server upload failure aborts sibling requests and the queue, cleans staging and retains the original error');
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
    releaseUploads();
    await page.waitForTimeout(350);
    await page.goto('about:blank');
    await api('/settings', 'PUT', original);
    if (session) await api(`/terminals/${session}`, 'DELETE');
    await browser.close();
    for (const path of published) await rm(path, { force: true, recursive: true });
    await rm(source, { recursive: true, force: true });
}
