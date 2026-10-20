import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const state = await mkdtemp('/tmp/tuxee-update-ui-');
const service = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => service.once('exit', resolve));
const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('server startup timed out')), 10000);
    service.stdout.on('data', data => {
        const match = String(data).match(/listening at (http:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    service.once('exit', () => { clearTimeout(timeout); reject(Error('server stopped')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Prague' });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const real = await (await api('/update')).json();
assert.match(real.command, /^sudo '.*' update$/);
const page = await context.newPage(), errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
let polls = 0, checks = 0;
let status = { ...real, latest: 'v1.0.0', available: false, checkedAt: '2026-10-20T19:12:59Z', error: '' };
await page.route(base + '/api/update', async route => {
    if (route.request().method() === 'POST') checks++; else polls++;
    await route.fulfill({ json: status });
});
const dialog = page.getByRole('dialog', { name: 'About Tuxee', exact: true });
const menu = page.getByRole('button', { name: 'User menu', exact: true });
const updateRow = dialog.locator('.about-details tr.about-update');
const checkNow = dialog.getByRole('button', { name: 'Check now', exact: true });
async function openAbout() {
    await menu.click();
    await page.getByRole('menuitem', { name: 'About', exact: true }).click();
    await checkNow.waitFor();
    assert.deepEqual(await dialog.locator('tr th').evaluateAll(headers => headers.slice(0, 2).map(header => header.textContent)), ['GitHub', 'Tuxee version']);
}
async function checkSummaryLine() {
    const centers = await updateRow.locator('.update-summary > *').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(); return box.y + box.height / 2;
    }));
    assert.ok(Math.max(...centers) - Math.min(...centers) < 1, 'desktop status, check time and refresh action share one line');
    const summaryBox = await updateRow.locator('.update-summary').boundingBox(), buttonBox = await checkNow.boundingBox();
    assert.ok(Math.abs(summaryBox.x + summaryBox.width - buttonBox.x - buttonBox.width) < 1, 'Check now aligns with the right edge of the row');
}
async function checkNotice() {
    await updateRow.locator('.menu-warning').waitFor();
    assert.ok(await updateRow.evaluate(node => node.classList.contains('update-available') && getComputedStyle(node).boxShadow !== 'none'));
    const rowBox = await updateRow.boundingBox(), dialogBox = await dialog.boundingBox();
    assert.ok(rowBox.y > dialogBox.y && rowBox.y + rowBox.height < dialogBox.y + dialogBox.height, 'update notice is visible immediately without scrolling');
}
try {
    assert.equal((await api('/settings', 'PUT', {
        theme: 'dark', current: 'updates', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: ['/'], networks: [], interval: 2 },
        workspaces: [{ id: 'updates', name: 'Updates', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: '/', x: 0, y: 0, w: 4, h: 2 }] }],
    })).status(), 200);
    await page.clock.install();
    const firstStatus = page.waitForResponse(base + '/api/update');
    await page.goto(base);
    await menu.waitFor();
    await firstStatus;
    await openAbout();
    await dialog.getByRole('rowheader', { name: 'Shell', exact: true }).waitFor();
    await dialog.getByText('Up to date', { exact: true }).waitFor();
    assert.ok(await updateRow.evaluate(node => node.previousElementSibling?.querySelector('th')?.textContent === 'Tuxee version'));
    assert.equal(await updateRow.locator('.update-checked').textContent(), 'checked 20.10.2026 21:12');
    assert.equal(await checkNow.locator('svg').count(), 1);
    assert.equal(await updateRow.locator('.menu-warning').count(), 0);
    assert.ok(await updateRow.evaluate(node => !node.classList.contains('update-available')));
    const github = dialog.getByRole('link', { name: 'agent0ai/tuxee', exact: true });
    assert.equal(await github.getAttribute('href'), 'https://github.com/agent0ai/tuxee');
    assert.equal(await github.getAttribute('target'), '_blank');
    assert.match(await github.getAttribute('rel'), /noopener/);
    await checkSummaryLine();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/updates-current.png' });
    assert.equal(await dialog.locator('.update-command:visible').count(), 0);
    status = { ...status, latest: 'v99.0.0', available: true, checkedAt: '2026-10-20T19:13:00Z' };
    await checkNow.click();
    await dialog.getByText('v99.0.0 available', { exact: true }).waitFor();
    assert.equal(await updateRow.locator('.update-checked').textContent(), 'checked 20.10.2026 21:13');
    await checkSummaryLine(); await checkNotice();
    assert.equal(await dialog.locator('.update-command').textContent(), real.command);
    assert.equal(checks, 1);
    await dialog.getByText('The update takes effect on restart. Restarting ends all terminal sessions.', { exact: true }).waitFor();
    await page.screenshot({ path: 'test-results/updates-desktop.png' });
    await page.keyboard.press('Escape');
    assert.equal(await menu.locator('.menu-warning').count(), 1);
    await menu.click();
    assert.equal(await page.getByRole('menuitem', { name: 'About', exact: true }).locator('.menu-warning').count(), 1);
    await page.getByRole('menuitem', { name: 'About', exact: true }).click();
    await checkNotice();
    await page.keyboard.press('Escape');
    console.log('PASS GitHub link, inline update row, local check time, immediate highlighted notice and shared menu warning');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await openAbout();
    await checkNotice();
    status = { ...status, checkedAt: '2026-10-20T19:14:00Z', error: 'GitHub download returned HTTP 503' };
    await checkNow.click();
    await dialog.getByText('Check failed: GitHub download returned HTTP 503', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.update-command').textContent(), real.command);
    assert.equal(await updateRow.locator('.update-checked').textContent(), 'checked 20.10.2026 21:14');
    await checkNotice();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: 'test-results/updates-mobile.png' });
    await page.keyboard.press('Escape');
    console.log('PASS mobile/light layout and failed checks retain known updates');

    status = { ...status, available: false, error: '' };
    const refresh = page.waitForResponse(base + '/api/update');
    await page.clock.fastForward(61000); await refresh;
    await page.waitForFunction(() => !document.querySelector('.user-menu-button .menu-warning'));
    await openAbout();
    await updateRow.getByText('Up to date', { exact: true }).waitFor();
    assert.ok(await updateRow.evaluate(node => !node.classList.contains('update-available')));
    assert.equal(await updateRow.locator('.menu-warning, .update-command:visible, .update-error:visible').count(), 0);
    await page.keyboard.press('Escape');
    status = { ...status, available: true };
    const automatic = page.waitForResponse(base + '/api/update');
    await page.clock.fastForward(61000); await automatic;
    await menu.locator('.menu-warning').waitFor();
    assert.equal(checks, 2, 'background refresh must read cached server status, not force GitHub checks');
    await menu.click(); await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    const afterLogout = polls;
    await page.clock.fastForward(120000);
    assert.equal(polls, afterLogout);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('PASS periodic notice refresh and logout cleanup; browser makes no external requests');
} catch (error) {
    await page.screenshot({ path: 'test-results/updates-failure.png' });
    throw error;
} finally {
    await page.goto('about:blank');
    // Log in again if the logout case revoked the original cookie.
    await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
    const latest = await (await context.request.get(base + '/api/me')).json();
    await context.request.put(base + '/api/settings', { data: me.settings, headers: { 'X-Tuxee-CSRF': latest.csrf, 'X-Tuxee-Client': 'web' } });
    await browser.close();
    service.kill('SIGTERM'); await stopped;
    await rm(state, { recursive: true, force: true });
}
