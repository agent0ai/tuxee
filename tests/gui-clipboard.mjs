import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, ...options });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    let error;
    for (let i = 0; i < 100; i++) { try { return await check(); } catch (value) { error = value; await pause(100); } }
    throw error;
}
const home = await mkdtemp('/tmp/tuxee-guiclip-user-'), state = await mkdtemp('/tmp/tuxee-guiclip-server-');
const user = `tuxee-guiclip-${process.pid}`, password = randomBytes(24).toString('base64url');
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const account = run('getent', ['passwd', user]).trim().split(':');
assert.equal(account[4], 'Tuxee prototype test');
const uid = +account[2], gid = +account[3];
await chown(home, uid, gid); run('chpasswd', [], { input: `${user}:${password}\n` });
await copyFile('tests/gui-clipboard-fixture.py', home + '/fixture.py'); await chown(home + '/fixture.py', uid, gid);
await chmod(state, 0o755); await copyFile('bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
await mkdir('test-results', { recursive: true });
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, logs = '';
server.stderr.on('data', data => logs = (logs + data).slice(-5000));
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server stopped')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP tuxee-guiclip.test 127.0.0.1'] });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const login = async origin => assert.equal((await context.request.post(origin + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    await login(base);
    const me = await (await context.request.get(base + '/api/me')).json();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const created = await api('/terminals', 'POST', { directory: home, name: 'Clipboard proof', columns: 80, rows: 24 });
    assert.equal(created.status(), 201); const terminal = await created.json();
    assert.equal((await api('/settings', 'PUT', { ...me.settings, current: 'proof', workspaces: [{ id: 'proof', name: 'Clipboard', columns: 4, rows: 2, active: 'shell', panels: [
        { id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 1, h: 2 },
        { id: 'shell', kind: 'terminal', terminal: terminal.id, path: home, x: 1, y: 0, w: 3, h: 2 },
    ] }] })).status(), 200);
    const page = await context.newPage(), errors = [], uploads = [];
    page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/upload')) uploads.push(request.url()); });
    const viewer = { connections: [], reject: 0, stall: 0 }, clipboardEvents = { connections: [], reject: 0, stall: 0 };
    await page.routeWebSocket('**/api/terminals/*/display/**', socket => {
        const channel = socket.url().endsWith('/clipboard/events') ? clipboardEvents : viewer;
        const connection = { socket, at: Date.now() }; channel.connections.push(connection);
        if (channel.reject) { channel.reject--; socket.close({ code: 1013 }); }
        else if (channel.stall) channel.stall--;
        else connection.server = socket.connectToServer();
    });
    await page.addInitScript(() => {
        // noVNC checks the direct prototype; Playwright adds a subclass above its socket implementation.
        const prototype = WebSocket.prototype, parent = Object.getPrototypeOf(prototype);
        for (const name of ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen']) {
            if (!Object.hasOwn(prototype, name)) Object.defineProperty(prototype, name, Object.getOwnPropertyDescriptor(parent, name));
        }
    });
    await page.goto(base);
    const view = page.locator('[data-panel=shell]'), canvas = view.locator('.terminal-display canvas');
    await view.locator('.terminal-view[data-state=connected]').waitFor();
    await view.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(`/usr/bin/python3 ${home}/fixture.py ${home}/input.json &`); await page.keyboard.press('Enter');
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    const record = async () => JSON.parse(await readFile(home + '/input.json', 'utf8'));
    const initial = await until(record);
    const env = { PATH: '/usr/bin:/usr/local/bin:/bin', HOME: home, DISPLAY: initial.display, XAUTHORITY: initial.auth };
    const remoteClip = (text, selection = 'clipboard', type) => {
        const child = spawn('xclip', ['-quiet', '-selection', selection, ...(type ? ['-target', type] : [])], { uid, gid, env, stdio: ['pipe', 'ignore', 'ignore'] }); child.stdin.end(text);
    };
    const write = text => page.evaluate(text => navigator.clipboard.writeText(text), text);
    const read = () => page.evaluate(() => navigator.clipboard.readText());
    const paste = async text => { await write(text); await canvas.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+V'); await until(async () => assert.equal((await record()).text, text)); };
    await paste('Device → GTK: café 日本語 🦊');
    assert.equal(run('xclip', ['-o', '-selection', 'clipboard'], { uid, gid, env }), 'Device → GTK: café 日本語 🦊');
    await write('keep local'); await page.keyboard.press('Control+a'); await pause(250); assert.equal(await read(), 'keep local');
    await page.keyboard.press('Control+C'); await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await write('changed locally'); await page.keyboard.press('Control+C'); await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await write('before held modifier copy'); await page.keyboard.down('Control'); await page.keyboard.press('c');
    await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await page.keyboard.press('a'); await page.keyboard.press('Backspace');
    await until(async () => assert.equal((await record()).text, ''));
    await page.keyboard.press('v'); await page.keyboard.up('Control');
    await until(async () => assert.equal((await record()).text, 'Device → GTK: café 日本語 🦊'));
    await page.keyboard.press('Control+a');
    await write('before GTK cut'); await page.keyboard.press('Control+X'); await until(async () => assert.equal((await record()).text, ''));
    await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    console.log('PASS native paste, Unicode, real GTK copy/cut, repeated copy and independent PRIMARY selection');

    await paste('Command modifiers'); await page.keyboard.press('Control+a');
    await page.evaluate(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel', configurable: true }));
    for (const key of ['MetaLeft', 'MetaRight']) {
        await write('old'); await page.keyboard.down(key); await page.keyboard.press('c'); await page.keyboard.up(key);
        await until(async () => assert.equal(await read(), 'Command modifiers'));
    }
    await page.evaluate(() => { delete navigator.platform; });
    await page.keyboard.press('ArrowRight'); await page.keyboard.type('!');
    await until(async () => assert.equal((await record()).text, 'Command modifiers!'));
    await page.keyboard.press('Control+a'); await context.clearPermissions(); await page.keyboard.press('Control+C'); await pause(300);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']); assert.equal(await read(), 'Command modifiers!');
    console.log('PASS simulated Mac Command keys, normal typing afterward and clipboard write without pregranted permission');

    await writeFile(home + '/input.json.delay', '');
    await write('keep on lost focus'); await page.keyboard.press('Control+C');
    await page.getByRole('textbox', { name: 'File or directory path' }).focus();
    await pause(800); await rm(home + '/input.json.delay');
    assert.equal(await read(), 'keep on lost focus');
    remoteClip('background clipboard'); await pause(300); assert.equal(await read(), 'keep on lost focus');
    await canvas.focus(); await pause(150); assert.equal(await read(), 'keep on lost focus');
    console.log('PASS delayed clipboard cancellation and background/focus-return isolation');

    await page.evaluate(() => {
        window.clipboardWrite = navigator.clipboard.write.bind(navigator.clipboard);
        window.clipboardWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.write = navigator.clipboard.writeText = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
    });
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
    await view.getByRole('button', { name: 'Copy to device', exact: true }).click();
    assert.equal(await read(), 'Command modifiers!');
    await page.evaluate(() => { navigator.clipboard.write = clipboardWrite; navigator.clipboard.writeText = clipboardWriteText; });
    await canvas.click(); remoteClip('remote menu copy'); await until(async () => assert.equal(await read(), 'remote menu copy'));
    await write('preserve for primary'); remoteClip('primary alone', 'primary'); await pause(300); assert.equal(await read(), 'preserve for primary');
    console.log('PASS denied-write fallback, remote-menu clipboard changes and PRIMARY isolation');

    const displayReady = () => view.locator('.terminal-display[data-state=connected]').waitFor({ timeout: 60000 });
    const clipboardReady = () => view.locator('[data-clipboard-ready=true]').waitFor({ timeout: 60000 });
    const disconnect = (channel, reject = 0) => {
        channel.reject = reject;
        const connection = channel.connections.at(-1), start = { at: Date.now(), index: channel.connections.length };
        connection.socket.close({ code: 1013 }); connection.server?.close({ code: 1013 }); return start;
    };
    const cadence = (channel, start, delays) => {
        const connections = channel.connections.slice(start.index);
        assert.equal(connections.length, delays.length, 'unexpected reconnect count');
        const gaps = connections.map((value, i) => value.at - (i ? connections[i - 1].at : start.at));
        gaps.forEach((gap, i) => assert.ok(gap >= delays[i] - 100 && gap < delays[i] + 3000, `retry ${i}: ${gap} ms, expected ${delays[i]} ms`));
        return gaps;
    };
    await clipboardReady();
    const originalCanvas = await canvas.elementHandle(), viewerCount = viewer.connections.length;
    await write('preserve across clipboard reconnect');
    const clipStart = disconnect(clipboardEvents, 5);
    await view.locator('[data-clipboard-ready=true]').waitFor({ state: 'detached' });
    await canvas.focus(); await page.keyboard.press('Control+a'); await page.keyboard.type('draft survives clipboard loss');
    await until(async () => assert.equal((await record()).text, 'draft survives clipboard loss'));
    await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
    await until(async () => assert.equal(run('xclip', ['-o', '-selection', 'clipboard'], { uid, gid, env }), 'draft survives clipboard loss'));
    await clipboardReady();
    console.log('PASS independent clipboard retry cadence (ms)', cadence(clipboardEvents, clipStart, [1000, 2000, 4000, 8000, 15000, 15000]));
    assert.equal(viewer.connections.length, viewerCount);
    assert.ok(await originalCanvas.evaluate(node => node === document.querySelector('.terminal-display canvas')));
    assert.equal(await read(), 'preserve across clipboard reconnect', 'initial snapshot must not overwrite device clipboard');
    await page.keyboard.press('Control+c'); await until(async () => assert.equal(await read(), 'draft survives clipboard loss'));

    const clipCount = clipboardEvents.connections.length, displayStart = disconnect(viewer, 5);
    await view.locator('.terminal-display[data-state=disconnected]').waitFor();
    const pathInput = page.locator('[data-panel=files] .path-input'); await pathInput.focus();
    await displayReady(); await clipboardReady();
    console.log('PASS viewer retry cadence (ms)', cadence(viewer, displayStart, [1000, 2000, 4000, 8000, 15000, 15000]));
    assert.ok(await pathInput.evaluate(node => document.activeElement === node), 'automatic reconnect stole focus');
    assert.equal(clipboardEvents.connections.length, clipCount + 1);
    assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    assert.equal((await record()).text, 'draft survives clipboard loss');
    await paste('after automatic recovery');

    // Manual recovery bypasses backoff and cancels the old scheduled attempt.
    const manual = disconnect(viewer, 2);
    await until(async () => assert.equal(viewer.connections.length, manual.index + 2));
    await view.locator('.display-status button').click(); await displayReady(); await clipboardReady();
    assert.equal(viewer.connections.length, manual.index + 3);
    await pause(4500); assert.equal(viewer.connections.length, manual.index + 3);
    // Switching to the shell deliberately cancels recovery on both channels.
    disconnect(clipboardEvents); disconnect(viewer);
    await view.locator('.terminal-tab').click();
    const hiddenCounts = [viewer.connections.length, clipboardEvents.connections.length];
    await pause(1500); assert.deepEqual([viewer.connections.length, clipboardEvents.connections.length], hiddenCounts);
    await view.locator('.display-window').click(); await displayReady(); await clipboardReady();
    console.log('PASS manual recovery, cancelled hidden-view retries and retained application/PID');

    // An open socket without a protocol handshake must also recover.
    for (const [channel, ready] of [[viewer, displayReady], [clipboardEvents, clipboardReady]]) {
        channel.stall = 1; const start = disconnect(channel);
        await until(async () => assert.equal(channel.connections.length, start.index + 1));
        await ready(); await clipboardReady();
        cadence(channel, start, [1000, 17000]);
    }
    await paste('after stalled handshake');
    console.log('PASS bounded VNC/clipboard handshakes and recovered native paste');
    await paste('Command modifiers!');

    await page.evaluate(async () => {
        const image = document.createElement('canvas'); image.width = image.height = 1;
        const blob = await new Promise(resolve => image.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    await canvas.focus(); await page.keyboard.press('Control+V');
    await until(async () => assert.deepEqual((await record()).received.image, [1, 1]));
    assert.deepEqual(uploads, []); assert.equal((await record()).text, 'Command modifiers!');
    await write('x'.repeat(256 * 1024)); await page.keyboard.press('Control+V');
    await view.getByText('GUI clipboard text is too large (maximum 256 KiB).', { exact: true }).waitFor();
    assert.equal((await record()).text, 'Command modifiers!');
    await view.getByRole('button', { name: 'Clipboard proof', exact: true }).click();
    await view.getByRole('button', { name: 'GUI clipboard proof', exact: true }).click();
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    await paste('after reconnect');
    await page.screenshot({ path: 'test-results/gui-clipboard.png' });
    console.log('PASS native PNG paste and text size admission without terminal uploads; reconnect installs one working bridge');

    // A larger, incompressible image exercises X11 INCR in both directions.
    const imageBytes = await page.evaluate(async () => {
        const image = document.createElement('canvas'); image.width = image.height = 512;
        const painter = image.getContext('2d'), pixels = painter.createImageData(512, 512);
        let seed = 7;
        for (let i = 0; i < pixels.data.length; i += 4) {
            seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
            pixels.data[i] = seed & 255; pixels.data[i+1] = seed >>> 8 & 255; pixels.data[i+2] = seed >>> 16 & 255; pixels.data[i+3] = 255;
        }
        painter.putImageData(pixels, 0, 0);
        const blob = await new Promise(resolve => image.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const item = (await navigator.clipboard.read())[0], png = await item.getType('image/png');
        return Array.from(new Uint8Array(await png.arrayBuffer()));
    });
    assert.ok(imageBytes.length > 64 * 1024);
    await canvas.focus(); await page.keyboard.press('Control+v');
    await until(async () => assert.deepEqual((await record()).received.image, [512, 512]));
    const exported = spawnSync('xclip', ['-o', '-selection', 'clipboard', '-target', 'image/png'], { uid, gid, env, timeout: 5000 });
    assert.equal(exported.status, 0); assert.deepEqual(exported.stdout, Buffer.from(imageBytes));
    await write('before image copy'); await canvas.click(); remoteClip(Buffer.from(imageBytes), 'clipboard', 'image/png');
    await until(async () => assert.ok(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png'))));
    const copiedDimensions = await page.evaluate(async () => { const item = (await navigator.clipboard.read())[0], bitmap = await createImageBitmap(await item.getType('image/png')); const size = [bitmap.width, bitmap.height]; bitmap.close(); return size; });
    assert.deepEqual(copiedDimensions, [512, 512]);
    await page.evaluate(async original => {
        const item = (await navigator.clipboard.read())[0];
        const pixels = async blob => { const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close(); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; };
        const expected = await pixels(new Blob([Uint8Array.from(original)], { type: 'image/png' })), actual = await pixels(await item.getType('image/png'));
        if (actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) throw Error('Copied image pixels changed');
    }, imageBytes);
    await writeFile(home + '/input.json.copy-image', '');
    await write('before actual image shortcut'); await page.keyboard.press('Control+c');
    await until(async () => assert.ok(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png'))));
    await page.evaluate(() => { window.clipboardWrite = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
    await page.keyboard.press('Control+c'); await view.getByRole('button', { name: 'Download image', exact: true }).waitFor();
    await page.evaluate(() => { navigator.clipboard.write = clipboardWrite; });
    await view.getByRole('button', { name: 'Copy to device', exact: true }).click();
    assert.ok(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('image/png')));
    await rm(home + '/input.json.copy-image');
    assert.deepEqual(uploads, []);
    console.log('PASS real GTK image paste, PNG copy back to the device, and incremental X11 transfers');

    // Browser-exposed files upload once and become native Linux file references.
    const pasteFiles = async () => canvas.evaluate(node => {
        const data = new DataTransfer(); data.items.add(new File(['from device'], "device spaced 日本語.txt", { type: 'text/plain' }));
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await canvas.focus(); await pasteFiles();
    const uploadedPath = home + '/uploads/device spaced 日本語.txt';
    await until(async () => assert.deepEqual((await record()).received.files, [new URL('file://' + uploadedPath).href]));
    assert.equal(await readFile(uploadedPath, 'utf8'), 'from device');
    assert.equal(uploads.length, 1);
    await canvas.click(); remoteClip('copy\n' + new URL('file://' + uploadedPath).href, 'clipboard', 'x-special/gnome-copied-files');
    await until(async () => assert.ok((await read()).includes('device spaced 日本語.txt')));
    const outgoingHTML = await page.evaluate(async () => { const item = (await navigator.clipboard.read())[0]; return (await item.getType('text/html')).text(); });
    assert.ok(outgoingHTML.includes('data-tuxee-files'));
    await view.getByRole('button', { name: 'Download files', exact: true }).waitFor();
    // Reuse the actual exported metadata in a GUI paste; it must not upload again.
    await canvas.focus(); await page.keyboard.press('Control+v');
    await until(async () => assert.deepEqual((await record()).received.files, [new URL('file://' + uploadedPath).href]));
    assert.equal(uploads.length, 1);
    await page.locator('[data-panel=files] .file-list').focus(); await page.keyboard.press('Control+v');
    await until(async () => assert.equal(await readFile(home + '/device spaced 日本語.txt', 'utf8'), 'from device'));
    await canvas.focus();
    console.log('PASS uploaded file clipboard, GUI file copy metadata and same-server file paste without upload');

    // A second view may own the shell while the first still controls its GUI.
    const other = await context.newPage(); await other.goto(base);
    await other.locator('[data-panel=shell] .terminal-view[data-state=viewing]').waitFor();
    await other.locator('[data-panel=shell]').getByRole('button', { name: 'Take control', exact: true }).click();
    await other.locator('[data-panel=shell] .terminal-view[data-state=connected]').waitFor();
    await page.bringToFront(); await view.locator('.terminal-view[data-state=viewing]').waitFor();
    // A native browser drop must reach the X11 app, never the hidden PTY.
    const box = await canvas.boundingBox();
    await canvas.evaluate((node, point) => {
        const data = new DataTransfer(); data.items.add(new File(['native drop'], 'dropped.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: point.x + point.width / 2, clientY: point.y + point.height / 2 }));
    }, box);
    await until(async () => assert.deepEqual((await record()).received.drop, ['file://' + home + '/uploads/dropped.txt']));
    assert.equal(await readFile(home + '/uploads/dropped.txt', 'utf8'), 'native drop');
    await other.close(); await view.getByRole('button', { name: 'Take control', exact: true }).click();
    await view.locator('.terminal-view[data-state=connected]').waitFor();
    await view.getByRole('button', { name: 'Clipboard proof', exact: true }).click();
    await page.keyboard.type("printf 'DROP_SHELL_CLEAN\\n'"); await page.keyboard.press('Enter');
    await until(async () => { const text = await view.locator('.xterm-screen').innerText(); assert.ok(text.includes('DROP_SHELL_CLEAN')); assert.ok(!text.includes('uploads/dropped.txt')); assert.ok(!text.includes('device spaced')); });
    await view.getByRole('button', { name: 'GUI clipboard proof', exact: true }).click();
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    console.log('PASS uploaded native GUI file drop and hidden terminal isolation');
    // Actual Chromium drag negotiation, using a browser-local file, reaches XDND.
    const localDrop = state + '/native-drag.txt'; await writeFile(localDrop, 'real browser drag');
    const cdp = await context.newCDPSession(page), dragBox = await canvas.boundingBox();
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', {
        type, x: dragBox.x + dragBox.width / 2, y: dragBox.y + dragBox.height / 2,
        data: { items: [], files: [localDrop], dragOperationsMask: 1 }
    });
    await until(async () => assert.deepEqual((await record()).received.drop, ['file://' + home + '/uploads/native-drag.txt']));
    const internalRow = page.locator('[data-panel=files] .file-entry').filter({ hasText: 'device spaced 日本語.txt' });
    await internalRow.waitFor(); const sourceBox = await internalRow.boundingBox();
    await internalRow.click();
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down(); await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2, { steps: 15 }); await page.mouse.up();
    await until(async () => assert.deepEqual((await record()).received.drop, [new URL('file://' + home + '/device spaced 日本語.txt').href]));
    // Disable the target's drop support: fallback requires an explicit user action.
    await canvas.focus(); await page.keyboard.press('F8'); await until(async () => assert.equal((await record()).received.drop_disabled, true));
    await canvas.evaluate(node => {
        const data = new DataTransfer(); data.items.add(new File(['fallback'], 'fallback.txt', { type: 'text/plain' }));
        const rect = node.getBoundingClientRect(); node.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    });
    await view.getByRole('button', { name: 'Paste paths', exact: true }).click();
    await until(async () => assert.ok((await record()).text.includes(home + '/uploads/fallback.txt')));
    console.log('PASS real Chromium file drag and explicit path-paste fallback for apps that reject drops');


    const app = spawn('/usr/bin/chromium', ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + home + '/chrome', 'data:text/html,<textarea autofocus></textarea>'], { uid, gid, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let cdpURL; app.stderr.on('data', data => { const match = String(data).match(/DevTools listening on (ws:\/\/\S+)/); if (match) cdpURL = match[1]; });
    await until(async () => assert.ok(cdpURL));
    const remoteBrowser = await chromium.connectOverCDP(cdpURL), remotePage = remoteBrowser.contexts()[0].pages()[0];
    await remotePage.locator('textarea').waitFor(); await canvas.focus(); await write('Device → remote Chromium 🦊'); await page.keyboard.press('Control+V');
    await until(async () => assert.equal(await remotePage.locator('textarea').inputValue(), 'Device → remote Chromium 🦊'));
    await page.keyboard.press('Control+a'); await write('old local'); await page.keyboard.press('Control+C');
    await until(async () => assert.equal(await read(), 'Device → remote Chromium 🦊'));
    await remotePage.evaluate(() => document.addEventListener('paste', event => { window.receivedFiles = Array.from(event.clipboardData.files).map(file => ({ type: file.type, size: file.size })); }));
    await page.evaluate(async bytes => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(bytes)], { type: 'image/png' }) })]), imageBytes);
    await canvas.focus(); await page.keyboard.press('Control+v');
    await until(async () => { const files = await remotePage.evaluate(() => window.receivedFiles); assert.equal(files?.[0]?.type, 'image/png'); assert.ok(files[0].size > 64 * 1024); });

    // Run the production terminal inside the remote browser: Ctrl+C crosses both UIs.
    const outerSettings = (await (await api('/me')).json()).settings;
    const nestedResponse = await api('/terminals', 'POST', { directory: home, columns: 80, rows: 24,
        command: `exec python3 -c 'import os,tty; tty.setraw(0); print("NESTED_COPY_MARKER",flush=True)
with open("${home}/interrupts", "ab", buffering=0) as output:
 while True: output.write(os.read(0, 1))'` });
    assert.equal(nestedResponse.status(), 201); const nested = await nestedResponse.json();
    assert.equal((await api('/settings', 'PUT', { ...outerSettings, current: 'nested', workspaces: [
        { id: 'nested', name: 'Nested', columns: 4, rows: 2, active: 'inner', panels: [
            { id: 'inner', kind: 'terminal', terminal: nested.id, path: home, x: 0, y: 0, w: 4, h: 2 },
        ] },
    ] })).status(), 200);
    const remoteContext = remotePage.context();
    assert.equal((await remoteContext.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    await remotePage.goto(base); await remotePage.locator('.terminal-view[data-state=connected]').waitFor();
    await remotePage.locator('.xterm-helper-textarea').focus(); await canvas.focus();
    await write('preserve on interrupt');
    await page.keyboard.press('Control+Shift+c'); // No selection must not send an interrupt.
    await page.keyboard.press('Control+c'); await page.keyboard.press('Control+c');
    await until(async () => assert.deepEqual(await readFile(home + '/interrupts'), Buffer.from([3, 3])));
    await pause(10500);
    assert.equal(await read(), 'preserve on interrupt');
    assert.equal(await view.getByText(/Waiting for the clipboard|Nothing was copied/).count(), 0);
    const marker = remotePage.locator('.xterm-rows > div').filter({ hasText: 'NESTED_COPY_MARKER' });
    const markerBox = await marker.boundingBox();
    await remotePage.mouse.dblclick(markerBox.x + 70, markerBox.y + 8);
    await remotePage.locator('.xterm-selection > div').first().waitFor();
    await canvas.focus(); await page.keyboard.press('Control+Shift+c');
    await until(async () => assert.match(await read(), /NESTED_COPY_MARKER/));
    assert.deepEqual(await readFile(home + '/interrupts'), Buffer.from([3, 3]), 'copy must not send PTY input');
    await page.screenshot({ path: 'test-results/gui-nested-terminal-copy.png' });
    await pause(400); await remotePage.goto('about:blank');
    assert.equal((await api('/settings', 'PUT', outerSettings)).status(), 200);
    assert.equal((await api(`/terminals/${nested.id}`, 'DELETE')).status(), 200);
    console.log('PASS nested real terminal receives repeated Ctrl+C, preserves clipboard without toasts, and copies with Ctrl+Shift+C');
    await remoteBrowser.close(); app.kill('SIGTERM');
    console.log('PASS the same production clipboard integration in remote Chromium');

    await view.getByRole('button', { name: 'GUI clipboard proof', exact: true }).click();
    await paste('insecure copy');
    const insecure = base.replace('127.0.0.1', 'tuxee-guiclip.test');
    await page.goto(insecure);
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    assert.equal(await page.evaluate(() => !!navigator.clipboard), false);
    await canvas.focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
    await view.getByRole('button', { name: 'Copy to device', exact: true }).click();
    const clipboard = await context.newPage(); await clipboard.goto(base + '/health');
    assert.equal(await clipboard.evaluate(() => navigator.clipboard.readText()), 'insecure copy');
    await clipboard.evaluate(() => navigator.clipboard.writeText('insecure paste 🦊'));
    await page.bringToFront(); await canvas.focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+V');
    await until(async () => assert.equal((await record()).text, 'insecure paste 🦊'));
    await page.screenshot({ path: 'test-results/gui-clipboard-http.png' });
    assert.deepEqual(errors, []);
    console.log('PASS genuine insecure HTTP native paste and explicit device-copy fallback');
} catch (error) { console.error(logs); throw error; }
finally {
    await browser?.close(); server.kill('SIGTERM');
    let timer; await Promise.race([stopped, new Promise(resolve => timer = setTimeout(resolve, 10000))]); clearTimeout(timer);
    if (server.exitCode === null) { server.kill('SIGKILL'); await stopped; }
    spawnSync('pkill', ['-u', String(uid)]); await pause(100); run('userdel', [user]);
    await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
