import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-font-user-'), user = `tuxee-font-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-font-');
await chmod(state, 0o755);
await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee');
await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    const env = { ...process.env }; for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete env[key];
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], env });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = async () => {
        const response = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(response.status(), 200);
        const token = (await response.json()).csrf;
        assert.equal(typeof token, 'string');
        return token;
    };
    let csrf = await login();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const saved = async () => (await (await api('/me')).json()).settings;
    const create = async () => {
        const response = await api('/terminals', 'POST', { directory: home, columns: 80, rows: 24 });
        assert.equal(response.status(), 201, await response.text());
        return response.json();
    };
    const terminals = [await create(), await create(), await create()];
    const settings = { theme: 'dark', current: 'ws-a', workspaces: ['a', 'b', 'c'].map((id, i) => ({ id: `ws-${id}`, name: id.toUpperCase(), columns: 4, rows: 2, active: id,
        panels: [{ id, kind: 'terminal', terminal: terminals[i].id, path: home, x: 0, y: 0, w: 4, h: 2 }] })) };
    const fixture = await api('/settings', 'PUT', settings);
    assert.equal(fixture.status(), 200, await fixture.text());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const sockets = [];
    let panelID = 'a';
    page.on('websocket', socket => { if (/\/terminals\/[^/]+\/ws$/.test(socket.url())) sockets.push(socket); });
    const font = size => page.waitForFunction(size => {
        const rows = [...document.querySelectorAll('.terminal-view .xterm-rows > div')];
        return rows.length && rows.every(row => parseFloat(getComputedStyle(row).fontSize) === size);
    }, size);
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const input = dialog.locator('[name=terminalFontSize]');
    const open = async () => {
        await page.getByRole('button', { name: 'User menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        await input.waitFor();
    };
    const save = async (status = 200) => {
        const response = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        assert.equal((await response).status(), status);
        if (status === 200) await dialog.waitFor({ state: 'hidden' });
    };
    const textView = async size => {
        const panel = page.locator(`[data-panel=${panelID}]`);
        await panel.getByRole('button', { name: 'Terminal contents as text', exact: true }).click();
        const text = page.locator('.terminal-text pre'); await text.waitFor();
        assert.equal(await text.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), size);
        const rows = await panel.locator('.xterm-rows > div').first().evaluate(node => ({ height: node.getBoundingClientRect().height, spacing: getComputedStyle(node).letterSpacing }));
        assert.equal(await text.evaluate(node => parseFloat(getComputedStyle(node).lineHeight)), rows.height);
        assert.equal(await text.evaluate(node => getComputedStyle(node).letterSpacing), rows.spacing);
        await page.keyboard.press('Escape');
    };
    const switchTo = async id => {
        await page.locator(`[data-workspace=ws-${id}] .workspace-tab`).click();
        panelID = id;
        await page.locator(`[data-panel=${id}] .terminal-view[data-state=connected]`).waitFor();
        await page.waitForFunction(() => !document.querySelector('.workspaces-sliding'));
    };
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor(); await font(13);
    await textView(13);
    await switchTo('b'); const warmNode = await page.locator('[data-panel=b] .xterm').elementHandle();
    await switchTo('a'); const activeNode = await page.locator('[data-panel=a] .xterm').elementHandle();
    const baselineSockets = sockets.length;
    await page.locator('.terminal-footer > div').first().locator('button').first().click();
    const drawer = page.locator('.terminal-input'); await drawer.fill('unsent\nfont size draft');
    await open(); assert.equal(await input.inputValue(), '13');
    assert.equal(await input.getAttribute('min'), '8'); assert.equal(await input.getAttribute('max'), '32');
    await input.fill('18'); await font(13);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal((await saved()).terminalFontSize, undefined);
    await open(); assert.equal(await input.inputValue(), '13');
    for (const invalid of ['', '7', '33', '13.5']) {
        await input.fill(invalid); assert.equal(await input.evaluate(node => node.checkValidity()), false);
    }
    await input.fill('18');
    await page.route(base + '/api/settings', route => route.fulfill({ status: 400, json: { error: 'save rejected' } }));
    await save(400); await font(13); assert.equal((await saved()).terminalFontSize, undefined);
    await page.unroute(base + '/api/settings');
    await save(); await font(18);
    assert.equal((await saved()).terminalFontSize, 18);
    assert.equal(await drawer.inputValue(), 'unsent\nfont size draft');
    assert.ok(await activeNode.evaluate(node => node === document.querySelector('[data-panel=a] .xterm')), 'font change preserves the renderer');
    assert.equal(sockets.length, baselineSockets, 'font change must not reconnect terminals');
    await textView(18);
    await switchTo('b'); await font(18); await textView(18);
    assert.ok(await warmNode.evaluate(node => node === document.querySelector('[data-panel=b] .xterm')), 'warm terminal stays mounted');
    await switchTo('c'); await font(18); await textView(18);
    await switchTo('a'); await font(18);
    // The real PTY must receive its new grid, rather than merely zooming browser text.
    const helper = page.locator('[data-panel=a] .xterm-helper-textarea'); await helper.focus();
    await page.keyboard.insertText(`stty size > '${home}/size.txt'`); await page.keyboard.press('Enter');
    let dimensions;
    for (let i = 0; i < 60; i++) { dimensions = await readFile(home + '/size.txt', 'utf8').catch(() => ''); if (dimensions.trim()) break; await page.waitForTimeout(50); }
    const [rows, columns] = dimensions.trim().split(/\s+/).map(Number);
    assert.ok(rows > 0 && columns > 0);
    assert.equal(await page.locator('[data-panel=a] .xterm-rows > div').count(), rows);
    for (const terminal of terminals) assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.terminal-view[data-state=connected]').length === 2); await font(18);
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').first().waitFor(); await font(18);
    await page.goto('about:blank'); assert.equal((await api('/logout', 'POST')).status(), 200); csrf = await login();
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').first().waitFor(); await font(18);
    await page.setViewportSize({ width: 390, height: 844 }); await open();
    assert.equal(await input.inputValue(), '18');
    assert.ok(await input.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/terminal-font-size-settings-mobile.png' });
    await input.fill('8'); await save(); await font(8);
    await open(); await input.fill('32'); await save(); await font(32);
    await open(); await input.fill('13'); await save(); await font(13);
    assert.equal((await saved()).terminalFontSize, 13);
    for (const invalid of [0, 7, 33, 13.5, '18']) {
        assert.equal((await api('/settings', 'PUT', { ...await saved(), terminalFontSize: invalid })).status(), 400);
        assert.equal((await saved()).terminalFontSize, 13, 'invalid API saves must not change preferences');
    }
    assert.deepEqual(errors, []);
    console.log('PASS terminal font size defaults, range, save/cancel/failure, live/warm/new terminals, text metrics, PTY resize, draft/PID/DOM retention, reload/login and mobile');
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]);
    await rm(state, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
}
