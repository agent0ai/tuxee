import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-background-user-'), user = `tuxee-bg-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-background-');
await chmod(state, 0o755);
await copyFile('./bin/tuxee', state + '/tuxee');
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
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
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
    const settings = { theme: 'dark', current: 'ws-a', workspaces: ['a', 'b'].map((id, i) => ({ id: `ws-${id}`, name: id.toUpperCase(), columns: 4, rows: 2, active: id,
        panels: [{ id, kind: 'terminal', terminal: terminals[i].id, path: home, x: 0, y: 0, w: 4, h: 2 }] })) };
    const fixture = await api('/settings', 'PUT', settings);
    assert.equal(fixture.status(), 200, await fixture.text());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const surface = color => page.waitForFunction(color => [...document.querySelectorAll('.xterm')].length > 0 && [...document.querySelectorAll('.xterm')].every(node => getComputedStyle(node).backgroundColor === color), color);
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const picker = dialog.getByLabel('Dark terminal background', { exact: true });
    const reset = dialog.getByRole('button', { name: 'Reset dark terminal background', exact: true });
    const open = async () => {
        await page.getByRole('button', { name: 'User menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        await picker.waitFor();
    };
    const choose = color => picker.evaluate((node, color) => { node.value = color; node.dispatchEvent(new Event('input', { bubbles: true })); }, color);
    const save = async (status = 200) => {
        const response = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        assert.equal((await response).status(), status);
        if (status === 200) await dialog.waitFor({ state: 'hidden' });
    };
    const snapshotBackground = id => page.evaluate(id => new Promise((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/terminals/${id}/ws`);
        const timer = setTimeout(() => { ws.close(); reject(Error('snapshot timed out')); }, 10000);
        ws.onmessage = event => { clearTimeout(timer); const value = JSON.parse(event.data); ws.close(); resolve(value.snapshot.palette); };
        ws.onerror = () => { clearTimeout(timer); reject(Error('snapshot failed')); };
    }), id);
    await page.goto(base);
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    await surface('rgb(27, 34, 48)');
    await page.locator('[data-workspace=ws-b] .workspace-tab').click();
    await page.locator('[data-panel=b] .terminal-view[data-state=connected]').waitFor();
    const warmNode = await page.locator('[data-panel=b] .xterm').elementHandle();
    await page.locator('[data-workspace=ws-a] .workspace-tab').click();
    const activeNode = await page.locator('[data-panel=a] .xterm').elementHandle();
    await open(); assert.equal(await picker.inputValue(), '#1b2230'); assert.ok(await reset.isDisabled());
    assert.ok(await dialog.locator('.terminal-color-columns .settings-color').evaluateAll(rows => rows.every(row => {
        const label = row.querySelector('label').getBoundingClientRect(), picker = row.querySelector('input').getBoundingClientRect();
        return label.right <= picker.left && Math.abs((label.top + label.bottom) / 2 - (picker.top + picker.bottom) / 2) < 1;
    })), 'theme labels sit immediately left of their pickers');
    await choose('#14283c'); await surface('rgb(27, 34, 48)');
    assert.equal((await saved()).terminalBackground, undefined);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await open(); assert.equal(await picker.inputValue(), '#1b2230');
    await choose('#14283c');
    await page.route(base + '/api/settings', route => route.fulfill({ status: 400, json: { error: 'save rejected' } }));
    await save(400); await surface('rgb(27, 34, 48)');
    await page.unroute(base + '/api/settings');
    await save(); await surface('rgb(20, 40, 60)');
    assert.equal((await saved()).terminalBackground, '#14283c');
    assert.ok(await activeNode.evaluate(node => node === document.querySelector('[data-panel=a] .xterm')), 'saving must preserve xterm DOM');
    assert.equal(await warmNode.evaluate(node => node.style.backgroundColor), 'rgb(20, 40, 60)', 'detached warm view receives the color event');
    await page.locator('[data-workspace=ws-b] .workspace-tab').click();
    assert.ok(await warmNode.evaluate(node => node === document.querySelector('[data-panel=b] .xterm')), 'returning reuses the warm view');
    await page.locator('[data-workspace=ws-a] .workspace-tab').click();
    for (const terminal of terminals) assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    for (const terminal of [terminals[2], await create()]) {
        const palette = await snapshotBackground(terminal.id);
        assert.equal(palette.colors[257], 0x14283cff); assert.equal(palette.defaults[257], 0x14283cff);
    }
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await surface('rgb(248, 249, 252)');
    const lightPicker = dialog.getByLabel('Light terminal background', { exact: true });
    await open(); assert.equal(await lightPicker.inputValue(), '#f8f9fc');
    assert.ok(await picker.evaluate((node, light) => node.getBoundingClientRect().left < light.getBoundingClientRect().left, await lightPicker.elementHandle()));
    await lightPicker.evaluate(node => { node.value = '#fff5e6'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await save(); await surface('rgb(255, 245, 230)');
    assert.equal((await saved()).terminalBackgroundLight, '#fff5e6');
    for (const terminal of [terminals[2], await create()]) {
        const palette = await snapshotBackground(terminal.id);
        assert.equal(palette.colors[257], 0xfff5e6ff); assert.equal(palette.defaults[257], 0xfff5e6ff);
        assert.equal(palette.colors[256], 0x1c2638ff); assert.equal(palette.defaults[256], 0x1c2638ff);
    }
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/terminal-background-light.png' });
    await open();
    const resetLight = dialog.getByRole('button', { name: 'Reset light terminal background', exact: true });
    await resetLight.click(); assert.equal(await lightPicker.inputValue(), '#f8f9fc');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await surface('rgb(255, 245, 230)');
    await open(); await resetLight.click(); await save(); await surface('rgb(248, 249, 252)');
    assert.equal((await saved()).terminalBackgroundLight, undefined);
    assert.equal((await saved()).terminalBackground, '#14283c');
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await surface('rgb(20, 40, 60)');
    assert.equal((await snapshotBackground(terminals[0].id)).colors[256], 0xe6edf3ff);
    await mkdir('test-results', { recursive: true });
    await open(); await page.screenshot({ path: 'test-results/terminal-background-settings.png' });
    await reset.click(); assert.equal(await picker.inputValue(), '#1b2230');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await surface('rgb(20, 40, 60)');
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').waitFor(); await surface('rgb(20, 40, 60)');
    await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click();
    await page.locator('.terminal-rendering').waitFor({ state: 'hidden' }); await surface('rgb(20, 40, 60)');
    const input = page.locator('[data-panel=a] .xterm-helper-textarea');
    await input.focus(); await page.keyboard.insertText("printf '\\033]11;#36213e\\007'"); await page.keyboard.press('Enter');
    await surface('rgb(54, 33, 62)');
    await open(); await save(); await surface('rgb(54, 33, 62)');
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').waitFor(); await surface('rgb(54, 33, 62)');
    await open(); await choose('#234567'); await save(); await surface('rgb(35, 69, 103)');
    await page.goto('about:blank');
    assert.equal((await api('/logout', 'POST')).status(), 200); csrf = await login();
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor(); await surface('rgb(35, 69, 103)');
    await page.setViewportSize({ width: 390, height: 844 });
    await open(); assert.equal(await picker.inputValue(), '#234567');
    assert.ok(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    await page.screenshot({ path: 'test-results/terminal-background-mobile.png' });
    await reset.click(); await save(); await surface('rgb(27, 34, 48)');
    assert.equal((await saved()).terminalBackground, undefined);
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').waitFor(); await surface('rgb(27, 34, 48)');
    assert.deepEqual(errors, []);
    console.log('PASS terminal background defaults, save/cancel/failure/reset, warm/detached/new terminals, live DOM/PID retention, themes, mobile, reconnect, login and application palette preservation');
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]);
    await rm(state, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
}
