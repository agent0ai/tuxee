import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const accounts = [];
for (let i = 0; i < 2; i++) {
    const home = await mkdtemp('/tmp/tuxee-draft-user-'), user = `tuxee-draft-${process.pid}-${i}`;
    run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
    const fields = run('getent', ['passwd', user]).split(':');
    await chown(home, Number(fields[2]), Number(fields[3]));
    const password = randomBytes(24).toString('base64url'); run('chpasswd', [], `${user}:${password}\n`);
    accounts.push({ home, user, password, uid: Number(fields[2]) });
}
const state = await mkdtemp('/tmp/tuxee-draft-state-');
await chmod(state, 0o755);
await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee');
await chmod(state + '/tuxee', 0o755);
let server, stopped, browser;
const start = async () => {
    server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => server.once('exit', resolve));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
};
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('condition timed out'); };
try {
    let base = await start();
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    let csrf;
    const login = async (ctx = context, account = accounts[0]) => {
        const response = await ctx.request.post(base + '/api/login', { data: { username: account.user, password: account.password }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(response.status(), 200); return (await response.json()).csrf;
    };
    csrf = await login();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const response = await api('/terminals', 'POST', { directory: accounts[0].home, columns: 80, rows: 24 });
    assert.equal(response.status(), 201, await response.text());
    let terminal = (await response.json()).id;
    const settings = { howToSeen: true, theme: 'dark', current: 'draft', workspaces: [{ id: 'draft', name: 'Draft', columns: 4, rows: 2, active: 'terminal', panels: [
        { id: 'terminal', kind: 'terminal', terminal, path: accounts[0].home, x: 0, y: 0, w: 4, h: 2 }
    ] }] };
    assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
    const page = await appPage(context), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const drawer = page.locator('.terminal-input');
    const toggle = page.getByRole('button', { name: 'Toggle terminal input', exact: true });
    const connected = () => page.locator('.terminal-view[data-state=connected]').waitFor();
    const saved = async () => { const r = await api(`/terminals/${terminal}/input-draft`); assert.equal(r.status(), 200); return r.json(); };
    const waitSaved = (text, open = true) => until(async () => { const value = await saved(); return value.text === text && value.open === open; });
    await page.goto(base); await connected();
    assert.equal(await drawer.isVisible(), false);
    await toggle.click();
    const long = `touch '${accounts[0].home}/should-not-execute'\n` + 'Long instruction 日本語 🦊\n'.repeat(3000);
    await drawer.fill(long); await waitSaved(long);
    const path = `${accounts[0].home}/.local/state/tuxee/terminals/${terminal}/input-draft.json`;
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(disk.text, long); assert.equal(disk.open, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(path)).uid, accounts[0].uid);
    await assert.rejects(stat(accounts[0].home + '/should-not-execute'), { code: 'ENOENT' });
    await page.reload(); await connected();
    assert.equal(await drawer.isVisible(), true); assert.equal(await drawer.inputValue(), long);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click(); await waitSaved(long, false); await page.reload(); await connected();
    assert.equal(await drawer.isVisible(), false); assert.equal(await drawer.inputValue(), long);
    await toggle.click(); await waitSaved(long);

    // The same server draft restores in a fresh mobile browser context.
    const mobile = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const second = await appPage(mobile); await second.goto(base);
    await second.locator('.terminal-view[data-state=viewing]').waitFor();
    assert.equal(await second.locator('.terminal-input').inputValue(), long);
    assert.equal(await second.locator('.terminal-input').isVisible(), true);
    await drawer.fill('newer draft'); await waitSaved('newer draft');
    const conflict = second.waitForResponse(r => r.url().endsWith('/input-draft') && r.request().method() === 'PUT');
    await second.locator('.terminal-input').fill('conflicting draft');
    assert.equal((await conflict).status(), 409);
    assert.equal(await second.locator('.terminal-input').inputValue(), 'conflicting draft');
    assert.equal((await saved()).text, 'newer draft');
    await mobile.close();

    // A delayed save protects reload; subsequent edits are saved in order.
    let release, arrived;
    const held = new Promise(r => { release = r; }), requested = new Promise(r => { arrived = r; });
    await page.route('**/input-draft', async route => {
        if (route.request().method() === 'PUT') { arrived(); await held; }
        await route.continue();
    });
    await drawer.fill('pending draft'); await requested;
    await drawer.fill('latest pending draft');
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    release(); await waitSaved('latest pending draft'); await page.unroute('**/input-draft');
    await page.reload(); await connected(); assert.equal(await drawer.inputValue(), 'latest pending draft');

    // Accepted submissions clear the draft; history recall never displaces a live draft.
    if (await page.getByRole('button', { name: 'Take control', exact: true }).isVisible()) await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await drawer.fill("printf 'draft-send-ok\\n'"); await drawer.press('Enter');
    await waitSaved('');
    await drawer.fill('unfinished instruction'); await waitSaved('unfinished instruction');
    await page.getByRole('button', { name: 'Previous input', exact: true }).click();
    assert.equal(await drawer.inputValue(), "printf 'draft-send-ok\\n'");
    await page.reload(); await connected(); assert.equal(await drawer.inputValue(), 'unfinished instruction');
    await drawer.fill('undo this change'); await waitSaved('undo this change');
    await drawer.press('Control+z'); await waitSaved('unfinished instruction');
    await drawer.press('Control+Shift+z'); await waitSaved('undo this change');

    // Continuous typing also saves periodically, without needing an idle pause.
    await drawer.fill(''); await waitSaved('');
    const continuous = 'continuous typing keeps saving while the user writes a long instruction';
    const duringTyping = page.waitForResponse(r => r.url().endsWith('/input-draft') && r.request().method() === 'PUT' && r.request().postDataJSON().text.startsWith('continuous'));
    let typingDone = false;
    const typing = drawer.pressSequentially(continuous, { delay: 40 }).then(() => { typingDone = true; });
    assert.equal((await duringTyping).status(), 200); assert.equal(typingDone, false);
    await typing; await waitSaved(continuous);
    await drawer.fill('undo this change'); await waitSaved('undo this change');

    // Reset flushes pending edits and retains the draft under the replacement terminal ID.
    await drawer.fill('pending reset draft');
    await page.getByRole('button', { name: 'Reset terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Kill and reset', exact: true }).click();
    await until(async () => { const id = await page.locator('.terminal-view').getAttribute('data-terminal'); if (id && id !== terminal) { terminal = id; return true; } return false; });
    await connected(); await waitSaved('pending reset draft');
    await page.reload(); await connected(); assert.equal(await drawer.inputValue(), 'pending reset draft');

    // Logout waits for the debounced draft and restores it on the next login.
    await drawer.fill('draft before logout');
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.locator('input[name=username]').waitFor();
    csrf = await login(); await page.goto(base); await connected();
    assert.equal(await drawer.inputValue(), 'draft before logout');

    const other = await browser.newContext(); const otherCSRF = await login(other, accounts[1]);
    for (const method of ['GET', 'PUT']) {
        const result = await other.request.fetch(base + `/api/terminals/${terminal}/input-draft`, { method, data: method === 'PUT' ? { text: 'foreign', open: true, revision: '' } : undefined, headers: { 'X-Tuxee-CSRF': otherCSRF, 'X-Tuxee-Client': 'web' } });
        assert.equal(result.status(), 404);
    }
    assert.equal((await context.request.put(base + `/api/terminals/${terminal}/input-draft`, { data: { text: 'csrf', open: true, revision: '' }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 403);
    assert.equal((await api(`/terminals/${terminal}/input-draft`, 'PUT', null)).status(), 400);
    assert.equal((await api(`/terminals/${terminal}/input-draft`, 'PUT', { text: 'x'.repeat(256 * 1024 + 1), open: true, revision: '' })).status(), 400);
    await other.close();
    assert.equal((await saved()).text, 'draft before logout');

    // Persisted drafts also survive server restart and archived-terminal replacement.
    await page.close(); server.kill('SIGTERM'); await stopped;
    base = await start(); csrf = await login();
    assert.equal((await saved()).text, 'draft before logout');
    const restored = await appPage(context); await restored.goto(base);
    await restored.locator('.terminal-archive').waitFor();
    await restored.locator('.restart-terminal').click();
    await restored.locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal(await restored.locator('.terminal-input').inputValue(), 'draft before logout');
    assert.equal(await restored.locator('.terminal-input').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('Terminal draft persistence: reload, hidden drawer, Unicode, permissions, mobile, conflicts, pending saves, history, undo, reset, logout, ownership, CSRF and restart passed.');
} finally {
    await browser?.close(); server?.kill('SIGTERM'); await stopped;
    for (const account of accounts) { run('userdel', [account.user]); await rm(account.home, { recursive: true, force: true }); }
    await rm(state, { recursive: true, force: true });
}
