import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
const until = async (check, message, attempts = 200) => {
    for (let attempt = 0; ; attempt++) {
        if (await check()) return;
        if (attempt === attempts) assert.fail(message);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-reset-user-'), user = `tuxee-reset-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const [, , uid, gid] = run('getent', ['passwd', user]).split(':').map((value, index) => index === 2 || index === 3 ? Number(value) : value);
await chown(home, uid, gid);
await writeFile(home + '/notes.txt', 'user file'); await chown(home + '/notes.txt', uid, gid);
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-reset-server-');
await chmod(state, 0o755); await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, page;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const signIn = async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const login = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(login.status(), 200);
        let csrf = (await login.json()).csrf;
        const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
        return { context, api, refresh: async () => { csrf = (await (await api('/connection')).json()).csrf; } };
    };
    const main = await signIn(), other = await signIn();
    assert.equal((await main.api('/reset')).status(), 200);
    assert.equal((await main.context.request.get(base + '/reset')).status(), 200);
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.get(base + '/reset')).status(), 404, 'anonymous reset page must stay hidden');
    await anonymous.close();

    // A live terminal with a child process, a customized layout and a stale workspace tab.
    const created = await main.api('/terminals', 'POST', { columns: 80, rows: 24, command: 'sleep 7777' });
    assert.equal(created.status(), 201);
    const terminal = await created.json();
    const settings = { theme: 'dark', serverName: 'Before reset', current: 'custom', workspaces: [{ id: 'custom', name: 'Before reset', columns: 4, rows: 2, active: 'shell', panels: [{ id: 'shell', kind: 'terminal', terminal: terminal.id, path: home, x: 0, y: 0, w: 2, h: 2 }] }] };
    assert.equal((await main.api('/settings', 'PUT', settings)).status(), 200);
    const stale = await appPage(main.context); stale.setDefaultTimeout(15000);
    await stale.goto(base); await stale.locator('[data-panel=shell] .terminal-view[data-state=connected]').waitFor();
    let staleLoads = 0; stale.on('load', () => staleLoads++);
    const sleeper = () => spawnSync('pgrep', ['-u', String(uid), '-f', 'sleep 7777'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.ok(sleeper().length > 0, 'terminal command must be running');

    // Break the saved configuration so the workspace can no longer load.
    const broken = '{"workspaces": [ broken';
    await writeFile(home + '/.config/tuxee/settings.json', broken); await chown(home + '/.config/tuxee/settings.json', uid, gid);
    assert.equal((await main.api('/me')).status(), 500, 'fixture must break the regular workspace');

    page = await main.context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const sockets = []; page.on('websocket', socket => sockets.push(socket.url()));
    await page.goto(base + '/reset');
    const dialog = page.getByRole('dialog', { name: 'Reset Tuxee' });
    await dialog.waitFor();
    for (const text of ['Restore Tuxee for ' + user, 'GUI applications are closed', '~/tuxee-backups', 'files and uploads stay unchanged', 'must sign in again'])
        assert.ok((await dialog.innerText()).includes(text), text);
    await mkdir('test-results/config-reset', { recursive: true });
    await page.screenshot({ path: 'test-results/config-reset/confirm-desktop.png' });
    await page.setViewportSize({ width: 390, height: 760 });
    const box = await dialog.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390, 'dialog fits phones');
    await page.screenshot({ path: 'test-results/config-reset/confirm-phone.png' });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Cancel returns to the workspace without changing anything.
    assert.equal(await dialog.getByRole('link', { name: 'Cancel' }).getAttribute('href'), '/');

    // Hold the first status reply to capture the progress state.
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route(base + '/api/reset', async route => {
        if (route.request().method() === 'GET') await held;
        await route.continue();
    });
    const reloaded = page.waitForURL(base + '/', { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Reset Tuxee' }).click();
    await page.locator('body[data-state=running]').waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Reset Tuxee' }).isDisabled());
    assert.equal(await page.locator('#reset-status').innerText(), 'Backing up and resetting…');
    await page.screenshot({ path: 'test-results/config-reset/progress.png' });
    release();
    await page.locator('body[data-state=done]').waitFor();
    assert.match(await page.locator('#reset-status').innerText(), /^Backup saved in .*tuxee-backups\/.*Reloading…$/);
    await page.screenshot({ path: 'test-results/config-reset/complete.png' });
    assert.deepEqual(sockets, [], 'reset page must not use WebSockets');
    await reloaded;
    await page.locator('.terminal-view:is([data-state=connected], [data-state=viewing])').first().waitFor();
    assert.deepEqual(errors.filter(error => !/How to/.test(error)), []);

    // Defaults, backup contents, terminated processes and untouched files.
    await main.refresh();
    const after = await (await main.api('/me')).json();
    assert.notEqual(after.settings.serverName, 'Before reset');
    assert.ok(!after.settings.workspaces.some(workspace => workspace.name === 'Before reset'));
    await until(() => sleeper().length === 0, 'reset must terminate terminal processes');
    const inventory = await (await main.api('/terminals')).json();
    assert.ok(!inventory.some(item => item.id === terminal.id), 'old terminal archives move to the backup');
    const backups = await readdir(home + '/tuxee-backups');
    assert.equal(backups.length, 1);
    const backup = home + '/tuxee-backups/' + backups[0];
    assert.equal(await readFile(backup + '/config/settings.json', 'utf8'), broken);
    assert.ok(existsSync(`${backup}/state/terminals/${terminal.id}/meta.json`), 'terminal history is backed up');
    const meta = JSON.parse(await readFile(backup + '/backup.json', 'utf8'));
    assert.equal(meta.config, home + '/.config/tuxee'); assert.equal(meta.state, home + '/.local/state/tuxee');
    assert.equal(await readFile(home + '/notes.txt', 'utf8'), 'user file');
    assert.equal(run('stat', ['-c', '%u %a', backup]), `${uid} 700`);

    // Other browsers sign in again; stale tabs of this browser reload instead of saving old layouts.
    assert.equal((await (await other.api('/connection')).json()).authenticated, false);
    await stale.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => staleLoads > 0, 'stale workspace tab must reload', 400);
    await stale.locator('.terminal-view:is([data-state=connected], [data-state=viewing])').first().waitFor();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const final = await (await main.api('/me')).json();
    assert.ok(!final.settings.workspaces.some(workspace => workspace.name === 'Before reset'), 'stale tab saved its old layout');
    await stale.close();
    console.log('PASS standalone confirm page, CSP script, progress, broken settings recovery, backup contents, terminal termination, login replacement and stale-tab reload');
} catch (error) {
    if (page) { await mkdir('test-results/config-reset', { recursive: true }); await page.screenshot({ path: 'test-results/config-reset/failure.png' }); }
    throw error;
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    spawnSync('pkill', ['-KILL', '-u', user]);
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
