import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const state = await mkdtemp('/tmp/tuxee-connection-server-');
let base, service, stopped;
async function startService() {
    service = spawn('./bin/tuxee', ['serve', '--http', '--bind', base ? new URL(base).host : '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    base = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('server startup timed out')), 10000);
        service.stdout.on('data', data => {
            const match = String(data).match(/listening at (http:\/\/\S+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        service.once('exit', () => { clearTimeout(timeout); reject(Error('server stopped')); });
    });
}
await startService();
const dir = await mkdtemp('/tmp/tuxee-connection-');
await chown(dir, Number(fields[2]), Number(fields[3]));
await writeFile(`${dir}/draft.txt`, 'original\n', { mode: 0o600 });
await chown(`${dir}/draft.txt`, Number(fields[2]), Number(fields[3]));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
let me = await (await context.request.get(base + '/api/me')).json();
const originalSettings = me.settings;
const api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), errors = [];
let connectionRequests = 0, documentRequests = 0;
let releaseConnection = () => {};
let releaseSession = () => {};
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (request.url() === base + '/api/connection') connectionRequests++;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
});
const overlay = page.getByRole('dialog', { name: 'Connection lost, reconnecting...', exact: true });
async function about() {
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'About', exact: true }).click();
    await page.getByRole('dialog', { name: 'About Tuxee', exact: true }).waitFor();
}
try {
    assert.equal((await api('/settings', 'PUT', {
        theme: 'dark', current: 'connection',
        monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: ['/'], networks: [], interval: 2 },
        workspaces: [{ id: 'connection', name: 'Connection', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }],
    })).status(), 200);
    await page.goto(base);
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = page.locator('.cm-content');
    await editor.waitFor(); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('draft');
    const originalEditor = await editor.elementHandle(), draft = await editor.textContent();
    await page.route(base + '/api/system', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable operation"}' }), { times: 1 });
    const healthy = page.waitForResponse(base + '/api/connection');
    await about(); await healthy; await page.getByText('Unavailable operation', { exact: true }).waitFor();
    assert.equal(await overlay.count(), 0, 'an operation error with a healthy backend must not block the app');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await mkdir('test-results', { recursive: true });
    for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme)
            await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
        await about();
        await context.setOffline(true); await overlay.waitFor();
        assert.ok(await overlay.evaluate(node => node.matches(':modal')));
        assert.equal(await overlay.getByRole('button', { name: 'Processes', exact: true }).count(), 0);
        const motion = await overlay.locator('.connection-progress').evaluate(node => {
            const animations = node.getAnimations({ subtree: true });
            animations.forEach(animation => animation.pause());
            const samples = Array.from({ length: 241 }, (_, index) => index * 10).map(time => {
                animations.forEach(animation => animation.currentTime = time);
                const style = getComputedStyle(node, '::after');
                return { x: parseFloat(style.left), right: parseFloat(style.right), width: parseFloat(style.width), color: style.backgroundColor, image: style.backgroundImage, transform: style.transform };
            });
            const track = node.getBoundingClientRect(), marker = getComputedStyle(node, '::after');
            const belowText = track.top > node.previousElementSibling.getBoundingClientRect().bottom;
            animations.forEach(animation => animation.play());
            return { samples, width: track.width, height: track.height, markerHeight: parseFloat(marker.height), belowText };
        });
        assert.ok(motion.belowText, 'loading line belongs below the status');
        assert.ok(motion.width > motion.height * 20 && motion.markerHeight > motion.height);
        for (const sample of motion.samples) {
            assert.ok(sample.x >= 0 && sample.right >= 0, 'loading segment must remain within the track');
            assert.ok(sample.width >= motion.width * .2 - 1 && sample.width <= motion.width * .4 + 1);
            assert.equal(sample.color, theme === 'dark' ? 'rgb(173, 148, 247)' : 'rgb(121, 83, 191)');
            assert.equal(sample.image, 'none'); assert.equal(sample.transform, 'none');
        }
        assert.ok(Math.abs(Math.max(...motion.samples.map(sample => sample.width)) - motion.width * .4) < 2);
        for (const index of [0, 120, 240]) assert.ok(Math.abs(motion.samples[index].width - motion.width * .2) < 1);
        for (const [leading, trailing, start] of [['right', 'x', 0], ['x', 'right', 120]]) {
            const contact = motion.samples.findIndex((sample, index) => index > start && sample[leading] < .001);
            assert.ok(contact > start && contact < motion.samples.length - 1);
            const before = motion.samples[contact][trailing] - motion.samples[contact - 1][trailing];
            const after = motion.samples[contact + 1][trailing] - motion.samples[contact][trailing];
            assert.ok(before > motion.width * .001 && after > motion.width * .001, 'tail must keep moving through contact');
            assert.ok(Math.abs(before - after) < Math.max(before, after) * .2, 'tail speed must remain continuous at contact');
        }
        assert.ok(await overlay.evaluate(node => getComputedStyle(node, '::backdrop').backdropFilter.includes('blur')));
        await page.keyboard.press('Escape'); assert.ok(await overlay.isVisible());
        await page.keyboard.type('must not reach draft'); assert.equal(await editor.textContent(), draft);
        await page.screenshot({ path: `test-results/connection-${theme}.png`, animations: 'disabled' });
        await context.setOffline(false); await overlay.waitFor({ state: 'detached' });
        assert.ok(await originalEditor.evaluate(node => node.isConnected), 'recovery must preserve mounted drafts');
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    }
    const stalled = new Promise(resolve => { releaseConnection = resolve; });
    await page.route(base + '/api/connection', async route => { await stalled; await route.continue().catch(() => {}); });
    await overlay.waitFor({ timeout: 12000 });
    releaseConnection(); await page.unroute(base + '/api/connection'); await overlay.waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(base + '/api/connection', route => route.fulfill({ status: 502, body: 'Bad Gateway' }));
    await overlay.waitFor({ timeout: 12000 });
    assert.ok(await page.evaluate(() => navigator.onLine), 'server outages also occur while the browser is online');
    assert.equal(await overlay.locator('.connection-progress').evaluate(node => getComputedStyle(node, '::after').animationName), 'none');
    assert.ok(await overlay.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: 'test-results/connection-mobile.png' });
    await page.unroute(base + '/api/connection'); await overlay.waitFor({ state: 'detached' });
    await page.route(base + '/api/terminals', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Session ended"}' }), { times: 1 });
    const confirmed = page.waitForResponse(base + '/api/connection');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal((await confirmed).status(), 200);
    assert.ok(await originalEditor.evaluate(node => node.isConnected), 'an unrelated 401 must first confirm session expiry');
    assert.equal(await page.locator('[name=username]').count(), 0);
    for (const response of [
        { status: 404, contentType: 'text/plain', body: '404 page not found' },
        { status: 200, contentType: 'application/json', body: '404 page not found' },
        { status: 401, contentType: 'text/html', body: '<h1>Proxy unavailable</h1>' },
        { status: 401, contentType: 'application/json', body: '{"error":"Session ended"}' },
        { status: 200, contentType: 'application/json', body: '{}' },
        { status: 200, contentType: 'application/json', body: '{"authenticated":true}' },
        { status: 200, contentType: 'application/json', body: '{"authenticated":true,"uid":0,"csrf":""}' },
    ]) {
        await page.route(base + '/api/connection', route => route.fulfill(response));
        await context.setOffline(true); await overlay.waitFor();
        const unavailable = page.waitForResponse(base + '/api/connection');
        await context.setOffline(false); await unavailable;
        const retry = page.waitForResponse(base + '/api/connection');
        await retry;
        assert.ok(await overlay.isVisible(), 'an invalid readiness response must not dismiss recovery');
        assert.equal(await page.locator('[name=username]').count(), 0);
        assert.ok(await originalEditor.evaluate(node => node.isConnected));
        assert.equal(await editor.textContent(), draft);
        await page.unroute(base + '/api/connection'); await overlay.waitFor({ state: 'detached' });
    }
    // A response from a check interrupted by a newer disconnect cannot revoke the UI.
    const delayedSession = new Promise(resolve => { releaseSession = resolve; });
    await page.route(base + '/api/connection', async route => {
        await delayedSession;
        await route.fulfill({ json: { authenticated: false } }).catch(() => {});
    });
    await context.setOffline(true); await overlay.waitFor();
    const checkingSession = page.waitForRequest(base + '/api/connection');
    await context.setOffline(false); await checkingSession;
    await context.setOffline(true);
    releaseSession(); await page.waitForTimeout(100);
    assert.ok(await originalEditor.evaluate(node => node.isConnected), 'an interrupted session check must not destroy the dashboard');
    assert.ok(await overlay.isVisible());
    assert.equal(await page.locator('[name=username]').count(), 0);
    await page.unroute(base + '/api/connection');
    await context.setOffline(false); await overlay.waitFor({ state: 'detached' });
    // A real SIGTERM revokes the cookie; simulate the proxy's gap before the replacement is ready.
    service.kill('SIGTERM'); await stopped; await overlay.waitFor({ timeout: 12000 });
    await page.route(base + '/api/connection', route => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 page not found' }));
    const restarting = page.waitForResponse(base + '/api/connection');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await restarting;
    assert.ok(await originalEditor.evaluate(node => node.isConnected));
    assert.equal(await page.locator('[name=username]').count(), 0);
    await startService();
    const warming = page.waitForResponse(base + '/api/connection');
    await warming;
    assert.ok(await overlay.isVisible());
    assert.equal(await page.locator('[name=username]').count(), 0);
    assert.equal(documentRequests, 1, 'outages and invalid or interrupted session checks must not reload');
    const reloaded = page.waitForEvent('domcontentloaded', { timeout: 10000 });
    await page.unroute(base + '/api/connection');
    await reloaded;
    await page.locator('[name=username]').waitFor();
    await overlay.waitFor({ state: 'detached' });
    assert.equal(documentRequests, 2, 'confirmed session loss must fetch a fresh document exactly once');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type), 'reload');
    for (let i = 0; i < 2; i++) {
        const anonymous = page.waitForResponse(base + '/api/connection');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        assert.deepEqual(await (await anonymous).json(), { authenticated: false });
    }
    assert.equal(documentRequests, 2, 'anonymous readiness checks must not create a reload loop');
    const beforeLogin = new Promise(resolve => { releaseSession = resolve; });
    await page.route(base + '/api/connection', async route => {
        await beforeLogin;
        await route.fulfill({ json: { authenticated: false } }).catch(() => {});
    });
    const anonymousProbe = page.waitForRequest(base + '/api/connection');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await anonymousProbe;
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'User menu', exact: true }).waitFor();
    releaseSession(); await page.unroute(base + '/api/connection'); await page.waitForTimeout(100);
    assert.ok(await page.getByRole('button', { name: 'User menu', exact: true }).isVisible(), 'a pre-login probe cannot undo successful login');
    assert.equal(documentRequests, 2, 'a stale anonymous response after login must not reload');
    assert.equal(await page.locator('.login-error').count(), 0, 'first sign-in after readiness must work');
    // Reload while readiness is unavailable must not turn a temporary bootstrap failure into login.
    await page.route(base + '/api/connection', route => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 page not found' }));
    await page.reload(); await overlay.waitFor();
    assert.equal(await page.locator('[name=username]').count(), 0);
    await page.unroute(base + '/api/connection'); await overlay.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'User menu', exact: true }).waitFor();
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.locator('[name=username]').waitFor();
    const checked = connectionRequests;
    await context.setOffline(true); await overlay.waitFor();
    await context.setOffline(false); await overlay.waitFor({ state: 'detached' });
    assert.ok(connectionRequests > checked, 'login screen must keep monitoring readiness');
    let attempts = 0;
    await page.route(base + '/api/login', async route => {
        attempts++;
        await route.fulfill({ status: 404, contentType: 'text/plain', body: '404 page not found' });
    });
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Connection lost. Try again when reconnected.', { exact: true }).waitFor();
    await overlay.waitFor({ state: 'detached' });
    assert.equal(attempts, 1, 'recovery must not replay credentials');
    assert.equal(await page.locator('[name=password]').inputValue(), '');
    assert.equal(await overlay.count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS connection overlay: outage/draft recovery, themes/modal blocking, invalid readiness, interrupted session checks, shutdown/proxy/JSON errors, one fresh document after confirmed expiry without anonymous reload loops, and first login after restart');
} finally {
    releaseConnection();
    releaseSession();
    try {
        await context.setOffline(false);
        await page.close();
        if (service.exitCode !== null) await startService();
        await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
        me = await (await context.request.get(base + '/api/me')).json();
        await api('/settings', 'PUT', originalSettings);
    } finally {
        await browser.close();
        service.kill('SIGTERM'); await stopped;
        await rm(state, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
    }
}
