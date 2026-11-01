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
assert.equal(process.getuid(), 0, 'requires a disposable Linux account');
const state = await mkdtemp('/tmp/tuxee-login-security-'), home = state + '/home', user = `tuxee-login-${process.pid}`;
await chmod(state, 0o755); await mkdir(home);
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
let server, browser;
try {
    await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
    server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto(base); await page.locator('.login-form').waitFor();
    assert.equal(await page.title(), 'Tuxee');
    assert.equal(await page.locator('meta[name=tuxee-hostname], meta[name=tuxee-version], .login-metadata').count(), 0);
    const publicHTML = await (await context.request.get(base)).text();
    const publicCatalog = await (await context.request.get(base + '/api/language')).json();
    assert.equal(publicCatalog.texts['app.serverName'], undefined);
    assert.equal(publicCatalog.texts['app.version'], undefined);
    assert.ok(Object.keys(publicCatalog.texts).length < 30);
    await page.waitForTimeout(5500);
    assert.ok(requests.every(path => ['/', '/favicon.png', '/login-logo.webp', '/api/connection'].includes(path)), requests);
    assert.ok(requests.filter(path => path === '/api/connection').length <= 1, 'login does not poll the application');
    for (const path of ['/sw.js', '/script-csp.txt', '/login-csp.txt', '/login.html', '/assets/', '/licenses/', '/missing']) {
        const response = await context.request.get(base + path);
        assert.equal(response.status(), 404, path);
        assert.equal(await response.text(), '404 page not found\n');
    }
    for (const path of ['/api/system', '/api/update', '/api/me', '/api/metrics', '/api/future']) assert.equal((await context.request.get(base + path)).status(), 401, path);
    assert.deepEqual(await (await context.request.get(base + '/api/connection')).json(), { authenticated: false });
    await mkdir('test-results', { recursive: true });
    for (const [width, height] of [[1440, 900], [390, 844], [320, 300]]) {
        await page.setViewportSize({ width, height });
        await page.screenshot({ path: `test-results/login-security-${width}.png` });
        const box = await page.locator('.login-form').boundingBox();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill('incorrect');
    await page.locator('.login-submit').click();
    await page.locator('.login-error').filter({ hasText: 'invalid' }).waitFor();
    assert.equal(await page.locator('[name=password]').inputValue(), '');
    assert.equal(await page.title(), 'Tuxee');

    // Seed only this disposable account, then exercise the real browser login.
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    let me = await (await context.request.get(base + '/api/me')).json();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf } });
    const settings = { ...me.settings, theme: 'light', howToSeen: true, serverName: 'Boundary <&> 東京', serverColor: '#ea580c', current: 'login', workspaces: [
        { id: 'login', name: 'Login test', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 2, h: 2 }] }
    ] };
    assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
    assert.equal((await api('/logout', 'POST', {})).status(), 200);
    const login = async () => {
        await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
        await page.locator('.login-submit').click(); await page.locator('.topbar').waitFor();
        me = await (await context.request.get(base + '/api/me')).json();
    };
    await login();
    const checkPrivate = async () => {
        assert.equal(await page.title(), 'Tuxee Boundary <&> 東京');
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
        assert.equal(await page.locator('.topbar').evaluate(node => getComputedStyle(node).borderBottomColor), 'rgb(234, 88, 12)');
        await page.waitForFunction(() => document.querySelector('link[rel=icon]').href.startsWith('data:image/png'));
    };
    await checkPrivate();
    const system = await (await api('/system')).json();
    assert.equal(await page.locator('meta[name=tuxee-hostname]').getAttribute('content'), system.hostname);
    await page.getByRole('button', { name: 'About Tuxee', exact: true }).click();
    const about = page.getByRole('dialog', { name: 'About Tuxee', exact: true });
    await about.getByRole('cell', { name: system.version, exact: true }).waitFor();
    await about.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.evaluate(() => { window.authenticatedPage = true; });
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.locator('.login-form').waitFor();
    assert.equal(await page.evaluate(() => window.authenticatedPage), undefined, 'logout replaces the private document');
    assert.equal(await page.title(), 'Tuxee');
    assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/favicon.png');
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--server-marker-border')), '');
    assert.equal(await (await context.request.get(base)).text(), publicHTML, 'anonymous HTML stays identical after authenticated use');
    await login(); await checkPrivate();
    assert.equal((await api('/settings', 'PUT', { ...settings, serverName: '' })).status(), 200);
    await page.reload(); await page.locator('.topbar').waitFor();
    assert.equal(await page.title(), 'Tuxee ' + system.hostname);
    assert.deepEqual(errors, []);
    console.log('Anonymous isolation, stable login, desktop/mobile form, real PAM login and authenticated UI passed.');
} finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) { const ended = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await ended; }
    run('userdel', [user]); await rm(state, { recursive: true, force: true });
}
