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
    await page.goto(base);
    const view = page.locator('[data-panel=shell]'), canvas = view.locator('.terminal-display canvas');
    await view.locator('.terminal-view[data-state=connected]').waitFor();
    await view.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText(`/usr/bin/python3 ${home}/fixture.py ${home}/input.json &`); await page.keyboard.press('Enter');
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    const record = async () => JSON.parse(await readFile(home + '/input.json', 'utf8'));
    const initial = await until(record);
    const env = { PATH: '/usr/bin:/usr/local/bin:/bin', HOME: home, DISPLAY: initial.display, XAUTHORITY: initial.auth };
    const remoteClip = (text, selection = 'clipboard') => {
        const child = spawn('xclip', ['-quiet', '-selection', selection], { uid, gid, env, stdio: ['pipe', 'ignore', 'ignore'] }); child.stdin.end(text);
    };
    const write = text => page.evaluate(text => navigator.clipboard.writeText(text), text);
    const read = () => page.evaluate(() => navigator.clipboard.readText());
    const paste = async text => { await write(text); await canvas.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+V'); await until(async () => assert.equal((await record()).text, text)); };
    await paste('Device → GTK: café 日本語 🦊');
    assert.equal(run('xclip', ['-o', '-selection', 'clipboard'], { uid, gid, env }), 'Device → GTK: café 日本語 🦊');
    await write('keep local'); await page.keyboard.press('Control+a'); await pause(250); assert.equal(await read(), 'keep local');
    await page.keyboard.press('Control+C'); await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await write('changed locally'); await page.keyboard.press('Control+C'); await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await page.keyboard.down('Control'); await page.keyboard.press('c');
    await until(async () => assert.equal(await read(), 'Device → GTK: café 日本語 🦊'));
    await page.keyboard.press('a'); await page.keyboard.press('v'); await page.keyboard.up('Control');
    await until(async () => assert.equal((await record()).text, 'Device → GTK: café 日本語 🦊'));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+X'); await until(async () => assert.equal((await record()).text, ''));
    assert.equal(await read(), 'Device → GTK: café 日本語 🦊');
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

    await page.evaluate(async () => {
        const image = document.createElement('canvas'); image.width = image.height = 1;
        const blob = await new Promise(resolve => image.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    await canvas.focus(); await page.keyboard.press('Control+V');
    await view.getByText('GUI clipboard supports text only.', { exact: true }).waitFor();
    assert.deepEqual(uploads, []); assert.equal((await record()).text, 'Command modifiers!');
    await write('x'.repeat(256 * 1024)); await page.keyboard.press('Control+V');
    await view.getByText('GUI clipboard text is too large (maximum 256 KB).', { exact: true }).waitFor();
    assert.equal((await record()).text, 'Command modifiers!');
    await view.getByRole('button', { name: 'Clipboard proof', exact: true }).click();
    await view.getByRole('button', { name: 'GUI clipboard proof', exact: true }).click();
    await view.locator('.terminal-display[data-state=connected]').waitFor();
    await paste('after reconnect');
    await page.screenshot({ path: 'test-results/gui-clipboard.png' });
    console.log('PASS text-only and size admission without terminal uploads; reconnect installs one working bridge');

    const app = spawn('/usr/bin/chromium', ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + home + '/chrome', 'data:text/html,<textarea autofocus></textarea>'], { uid, gid, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let cdpURL; app.stderr.on('data', data => { const match = String(data).match(/DevTools listening on (ws:\/\/\S+)/); if (match) cdpURL = match[1]; });
    await until(async () => assert.ok(cdpURL));
    const remoteBrowser = await chromium.connectOverCDP(cdpURL), remotePage = remoteBrowser.contexts()[0].pages()[0];
    await remotePage.locator('textarea').waitFor(); await canvas.focus(); await write('Device → remote Chromium 🦊'); await page.keyboard.press('Control+V');
    await until(async () => assert.equal(await remotePage.locator('textarea').inputValue(), 'Device → remote Chromium 🦊'));
    await page.keyboard.press('Control+a'); await write('old local'); await page.keyboard.press('Control+C');
    await until(async () => assert.equal(await read(), 'Device → remote Chromium 🦊'));
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
