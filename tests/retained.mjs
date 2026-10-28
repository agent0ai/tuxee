import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), sessions = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
async function create(name, command) {
    const response = await api('/terminals', 'POST', { name, command, columns: 80, rows: 24 });
    assert.equal(response.status(), 201);
    const info = await response.json(); sessions.push(info); return info;
}
const menu = page.getByRole('button', { name: 'User menu', exact: true });
const retained = page.getByRole('dialog', { name: 'Retained terminals', exact: true });
const row = name => retained.locator('.retained-row').filter({ has: page.getByText(name, { exact: true }) });
async function openRetained() {
    await menu.click();
    await page.getByRole('menuitem', { name: 'Retained terminals', exact: true }).click();
    await retained.waitFor();
}
async function warning(count) {
    await page.waitForFunction(count => {
        const control = document.querySelector('.user-menu-button');
        return count ? control?.getAttribute('aria-description')?.startsWith(`${count} running terminal`) : !control?.getAttribute('aria-description')?.includes('running terminal');
    }, count, { timeout: 15000 });
}
async function terminate(name, exited = false) {
    await row(name).getByRole('button', { name: 'Close', exact: true }).click();
    if (!exited) await page.getByRole('dialog', { name: 'Terminate terminal?', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await row(name).waitFor({ state: 'detached' });
}
try {
    const listed = await create('Inactive workspace');
    const lost = await create('Lost running service');
    const attached = await create('Attached outside layout');
    const ended = await create('Ended outside layout', 'printf DONE');
    const workspaces = [
        { id: 'work', name: 'Files', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: fields[5], x: 0, y: 0, w: 2, h: 2 }] },
        { id: 'inactive', name: 'Inactive', columns: 4, rows: 2, active: 'listed', panels: [{ id: 'listed', kind: 'terminal', terminal: listed.id, x: 0, y: 0, w: 4, h: 2 }] },
    ];
    const saved = await api('/settings', 'PUT', { theme: 'dark', idleHours: 1 / 3600, current: 'work', workspaces });
    assert.equal(saved.status(), 200, await saved.text()); assert.equal((await saved.json()).idleHours, undefined);
    await page.goto(base); await page.locator('.file-view').waitFor();
    // A live transport must not hide a session whose panel was lost.
    await page.evaluate(id => new Promise((resolve, reject) => {
        window.retainedTestSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/${id}/ws`);
        window.retainedTestSocket.binaryType = 'arraybuffer';
        window.retainedTestSocket.onmessage = event => {
            const sequence = typeof event.data === 'string' ? JSON.parse(event.data).sequence : Number(new DataView(event.data).getBigUint64(0));
            if (sequence) retainedTestSocket.send(JSON.stringify({ type: 'rendered', sequence }));
            resolve();
        };
        window.retainedTestSocket.onerror = reject;
    }), attached.id);
    await warning(2);
    await menu.click();
    const item = page.getByRole('menuitem', { name: 'Retained terminals', exact: true });
    assert.equal(await item.locator('.menu-warning').count(), 1);
    assert.ok((await menu.getAttribute('aria-description')).split('\n').includes(await item.getAttribute('aria-description')));
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    assert.equal(await page.locator('[name=closedTerminalHistoryHours]').inputValue(), String(me.settings.closedTerminalHistoryHours ?? 168));
    assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await openRetained();
    assert.equal(await row(listed.name).count(), 0, 'inactive workspace terminals are already represented');
    assert.equal(await row(lost.name).count(), 1);
    assert.ok((await row(attached.name).textContent()).includes('Attached'));
    assert.ok((await row(ended.name).textContent()).includes('Ended'));
    assert.equal(await retained.locator('code').count(), 0);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/retained-desktop.png' });
    const attachedSaved = page.waitForResponse(response => response.url() === base + '/api/settings' && response.request().method() === 'PUT');
    await row(lost.name).getByRole('button', { name: 'Attach', exact: true }).click();
    await page.locator(`.terminal-view[data-terminal="${lost.id}"][data-state=connected]`).waitFor();
    await warning(1);
    assert.equal((await attachedSaved).status(), 200);
    assert.equal((await (await api(`/terminals/${lost.id}`)).json()).pid, lost.pid, 'reattach preserves the process');
    await page.reload(); await page.locator('.topbar').waitFor(); await warning(1);
    assert.ok((await (await api('/me')).json()).settings.workspaces[0].panels.some(panel => panel.terminal === lost.id));
    await openRetained();
    assert.equal(await row(lost.name).count(), 0);
    await row(attached.name).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await api(`/terminals/${attached.id}`)).status(), 200);
    await terminate(attached.name); await warning(0);
    assert.ok((await (await api(`/terminals/${attached.id}`)).json()).closedAt);
    await terminate(ended.name, true);
    await retained.getByText('No retained terminals.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    console.log('PASS no timeout setting; warnings exclude inactive workspaces; attach preserves PID; confirmed termination and ended-session cleanup clear badges');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    const later = await create('Discovered while menu is closed');
    await warning(1);
    assert.ok(await menu.locator('.menu-warning').isVisible());
    assert.ok(await page.locator('.topbar').evaluate(node => node.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'test-results/retained-mobile-light.png' });
    await openRetained(); await terminate(later.name); await warning(0);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    // A failed inventory request must warn rather than clear the last known status.
    await page.route(base + '/api/terminals', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Inventory unavailable"}' }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('.user-menu-button')?.getAttribute('aria-description')?.split('\n').includes('Inventory unavailable'));
    await page.unroute(base + '/api/terminals');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await warning(0);
    await menu.click(); await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.locator('[name=username]').waitFor();
    assert.equal(await page.locator('.menu-warning').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS closed-menu discovery, mobile/light warning, inventory failure recovery and logout cleanup');
} catch (error) {
    await page.screenshot({ path: 'test-results/retained-failure.png' });
    throw error;
} finally {
    await page.goto('about:blank');
    // Login again if the test revoked this cookie.
    const login = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
    if (login.ok()) {
        const csrf = (await (await context.request.get(base + '/api/me')).json()).csrf;
        const cleanup = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
        for (const info of sessions) await cleanup(`/terminals/${info.id}`, 'DELETE');
        assert.equal((await cleanup('/settings', 'PUT', me.settings)).status(), 200);
    }
    await browser.close();
}
