import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

assert.equal(process.getuid(), 0, 'requires disposable Linux accounts');
const container = process.env.TUXEE_TEST_CONTAINER;
if (container) assert.match(container, /^tuxee-security-(test|poc)/);
const run = (command, args = [], input) => {
    const result = spawnSync(container ? 'docker' : command, container ? ['exec', '-i', container, command, ...args] : args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
const totp = (secret, seconds = Date.now() / 1000) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
    for (const letter of secret) bits += alphabet.indexOf(letter).toString(2).padStart(5, '0');
    const bytes = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    const step = Buffer.alloc(8); step.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
    const mac = createHmac('sha1', bytes).update(step).digest(), offset = mac.at(-1) & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
};
const directory = await mkdtemp('/tmp/tuxee-security-test-'); await chmod(directory, 0o755);
const executable = container ? '/usr/local/bin/tuxee' : directory + '/tuxee';
const users = []; let service, browser, base = process.env.TUXEE_TEST_URL, stopped;
try {
    for (const admin of [false, true]) {
        const name = `tuxee-security-${admin ? 'admin' : 'user'}-${process.pid}`, home = container ? '/home/' + name : directory + '/' + name;
        run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', ...(admin ? ['-o', '-u', '0', '-g', '0'] : []), name]);
        const fields = run('getent', ['passwd', name]).split(':');
        const user = { name, home, uid: Number(fields[2]), gid: Number(fields[3]), password: randomBytes(24).toString('base64url'), admin };
        users.push(user);
        run('mkdir', ['-p', home]); run('chown', [`${user.uid}:${user.gid}`, home]);
        run('chpasswd', [], `${name}:${user.password}\n`);
    }
    if (!container) {
        await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', executable); await chmod(executable, 0o755);
        const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
        service = spawn(executable, ['serve', '--http', '--bind', '127.0.0.1:0', '--state', directory + '/state'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        stopped = new Promise(resolve => service.once('exit', resolve));
        base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('startup timed out')), 15000);
            service.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
            service.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
        });
    }
    assert.ok(base);
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
    const contexts = await Promise.all(users.map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })));
    const login = async index => {
        const response = await contexts[index].request.post(base + '/api/login', { data: { username: users[index].name, password: users[index].password }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(response.status(), 200); const value = await response.json();
        assert.ok(value.csrf, 'password-only login should succeed when 2FA is disabled'); return value.csrf;
    };
    const csrf = [await login(0), await login(1)];
    const api = (index, path, method = 'GET', data) => contexts[index].request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf[index], 'X-Tuxee-Client': 'web' } });
    for (const [path, method, data] of [
        ['/security', 'GET'], ['/security/setup', 'POST', {}], ['/security/disable', 'POST', {}],
        ['/security/network', 'POST', { ip: '127.0.0.1' }], ['/security/network', 'PUT', { confirmDisconnect: true }],
    ]) {
        const response = await api(1, path, method, data);
        assert.equal(response.status(), 403);
        assert.deepEqual(Object.keys(await response.json()).sort(), ['error', 'text']);
    }
    const deniedCLI = container
        ? spawnSync('docker', ['exec', '--user', `${users[0].uid}:${users[0].gid}`, container, executable, 'security', 'network', '--clear'], { encoding: 'utf8' })
        : spawnSync(executable, ['security', 'network', '--clear'], { uid: users[0].uid, gid: users[0].gid, encoding: 'utf8' });
    assert.notEqual(deniedCLI.status, 0, 'ordinary account changed global security through the CLI');
    for (const [index, user] of users.entries()) {
        assert.equal((await api(index, '/settings', 'PUT', { theme: 'dark', howToSeen: true, current: 'security', workspaces: [{ id: 'security', name: 'Security', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: user.home, x: 0, y: 0, w: 4, h: 2 }] }] })).status(), 200);
    }
    const old = await browser.newContext();
    assert.equal((await old.request.post(base + '/api/login', { data: { username: users[0].name, password: users[0].password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const page = await appPage(contexts[0]), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.locator('.topbar').waitFor();
    const prompt = async target => {
        await target.getByRole('button', { name: 'Tuxee menu', exact: true }).click();
        await target.getByRole('menuitem', { name: 'Security', exact: true }).click();
        const dialog = target.getByRole('dialog', { name: 'Security', exact: true }); await dialog.waitFor(); return dialog;
    };
    const open = async (target, index) => {
        const dialog = await prompt(target);
        await dialog.locator('[name=password]').fill(users[index].password);
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
        await dialog.getByRole('tab', { name: 'User', exact: true }).waitFor();
        return dialog;
    };
    const locked = await prompt(page);
    assert.equal(await locked.getByRole('tab').count(), 0);
    await locked.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await api(0, '/security')).status(), 403);
    let dialog = await open(page, 0);
    const ordinary = await (await api(0, '/security')).json();
    assert.equal(ordinary.canAdmin, false); assert.equal(ordinary.network, undefined);
    assert.equal((await api(0, '/security/network', 'PUT', { allowedNetworks: [], trustedProxies: [] })).status(), 403);
    assert.equal(await dialog.getByRole('tab', { name: 'Global', exact: true }).count(), 0);
    await mkdir('test-results/security', { recursive: true });
    await dialog.screenshot({ path: 'test-results/security/user-disabled.png' });
    assert.equal(await dialog.locator('input').count(), 0);
    assert.equal(await dialog.locator('.security-status-row svg').count(), 1);
    await dialog.getByRole('button', { name: 'Enable 2FA', exact: true }).click();
    const enrollment = page.getByRole('dialog', { name: 'Enable 2FA', exact: true });
    assert.equal(await enrollment.locator('[name=password]').count(), 0);
    const setupKey = enrollment.locator('input[readonly]'); await setupKey.waitFor();
    for (const name of ['Google Authenticator', 'Microsoft Authenticator'])
        assert.equal(await enrollment.getByRole('link', { name, exact: true }).getAttribute('rel'), 'noopener noreferrer');
    const secret = await setupKey.inputValue();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok((await enrollment.locator('img').getAttribute('src')).startsWith('data:image/png;base64,'));
    const enrollmentCode = totp(secret);
    await enrollment.locator('[name=code]').fill(enrollmentCode);
    await enrollment.getByRole('button', { name: 'Enable 2FA', exact: true }).click();
    await enrollment.locator('.security-recovery').waitFor();
    const codes = (await enrollment.locator('.security-recovery').innerText()).trim().split('\n'); assert.equal(codes.length, 8);
    assert.equal((await (await old.request.get(base + '/api/connection')).json()).authenticated, false, 'enrollment revokes other sessions');
    await enrollment.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await api(0, '/security')).status(), 403, 'changing a factor clears the grant');
    assert.equal((await api(0, '/files', 'POST', { operation: 'security-clear' })).status(), 400, 'internal recovery leaked through the files API');
    assert.equal((await api(0, '/logout', 'POST', {})).status(), 200);
    await page.goto(base);
    await page.locator('[name=username]').fill(users[0].name); await page.locator('[name=password]').fill(users[0].password);
    await page.locator('.login-submit').click(); await page.locator('[name=code]').waitFor({ state: 'visible' });
    assert.equal((await (await contexts[0].request.get(base + '/api/connection')).json()).authenticated, false, 'first factor must not authenticate');
    assert.equal(await page.locator('[name=password]').inputValue(), '');
    await page.locator('[name=code]').fill('bad-code'); await page.locator('.login-submit').click(); await page.locator('.login-error').filter({ hasText: 'Invalid' }).waitFor();
    assert.equal(await page.locator('.login-cancel').evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)');
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 700 }); await page.locator('.login-cancel').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/security/login-code-${width}.png` });
    }
    await page.locator('[name=code]').fill(codes[0]); await page.locator('.login-submit').click(); await page.locator('.topbar').waitFor();
    csrf[0] = (await (await contexts[0].request.get(base + '/api/connection')).json()).csrf;
    assert.equal((await api(0, '/security')).status(), 403, 'sign-in does not unlock Security');
    const replay = await browser.newContext();
    const challenge = await (await replay.request.post(base + '/api/login', { data: { username: users[0].name, password: users[0].password }, headers: { 'X-Tuxee-Client': 'web' } })).json();
    assert.ok(challenge.challenge);
    assert.equal((await replay.request.post(base + '/api/login', { data: { challenge: challenge.challenge, code: codes[0] }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 401);
    while (totp(secret) === enrollmentCode) await new Promise(resolve => setTimeout(resolve, 250));
    const appCodeLogin = await browser.newContext();
    const appChallenge = await (await appCodeLogin.request.post(base + '/api/login', { data: { username: users[0].name, password: users[0].password }, headers: { 'X-Tuxee-Client': 'web' } })).json();
    assert.ok(appChallenge.challenge);
    const verified = await appCodeLogin.request.post(base + '/api/login', { data: { challenge: appChallenge.challenge, code: totp(secret) }, headers: { 'X-Tuxee-Client': 'web' } });
    assert.equal(verified.status(), 200); assert.ok((await verified.json()).csrf, 'authenticator code completes login');
    run(executable, ['security', 'unlock', '--user', users[0].name]);
    assert.equal((await api(0, '/security/unlock', 'POST', { password: users[0].password })).status(), 200);
    assert.equal((await (await api(0, '/security')).json()).user.enabled, false, 'CLI unlock applies live');
    const adminPage = await appPage(contexts[1]); await adminPage.goto(base); await adminPage.locator('.topbar').waitFor();
    dialog = await open(adminPage, 1); await dialog.getByRole('tab', { name: 'Global', exact: true }).click();
    const global = await (await api(1, '/security')).json();
    assert.equal(global.canAdmin, true);
    for (const width of [1440, 390, 320]) {
        await adminPage.setViewportSize({ width, height: 900 }); await dialog.screenshot({ path: `test-results/security/global-${width}.png` });
        const bounds = await dialog.boundingBox(); assert.ok(bounds.width <= width && bounds.x >= 0);
    }
    await dialog.locator('[name=allowedNetworks]').fill('invalid-network'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.locator('[role=alert]').filter({ hasText: 'valid IP' }).waitFor();
    await dialog.locator('[name=allowedNetworks]').fill('198.51.100.0/24\n2001:db8::/64');
    const testIP = dialog.locator('[name=testIP]');
    await testIP.fill('2001:db8::1');
    await testIP.press('Enter');
    await dialog.getByRole('status').filter({ hasText: 'This IP would be allowed.' }).waitFor();
    await testIP.fill('203.0.113.1');
    await dialog.getByRole('button', { name: 'Test', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'This IP would be blocked.' }).waitFor();
    assert.deepEqual((await (await api(1, '/security')).json()).network, global.network, 'tester persisted the draft');

    const proxyPreview = await contexts[1].request.put(base + '/api/security/network', {
        data: { allowedNetworks: [global.clientIP], trustedProxies: [global.clientIP] },
        headers: { 'X-Tuxee-CSRF': csrf[1], 'X-Forwarded-For': '198.51.100.10' },
    });
    assert.deepEqual(await proxyPreview.json(), { saved: false }, 'save must resolve the current request using draft proxy settings');

    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    const warning = adminPage.getByRole('dialog', { name: 'Network filter', exact: true });
    await save.click();
    await warning.getByText('These settings would disconnect you. Save anyway?').waitFor();
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
    await warning.waitFor({ state: 'hidden' });
    assert.deepEqual((await (await api(1, '/security')).json()).network, global.network, 'cancel persisted the draft');
    await save.click();
    await warning.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await contexts[0].request.get(base)).status(), 403);
    assert.equal((await contexts[0].request.get(base + '/health')).status(), 200);
    assert.equal((await contexts[0].request.get(base, { headers: { 'X-Forwarded-For': '198.51.100.10' } })).status(), 403, 'untrusted forwarding header bypassed filter');
    run(executable, ['security', 'network', '--clear']);
    assert.equal((await contexts[0].request.get(base)).status(), 200);
    assert.equal((await (await contexts[0].request.get(base + '/api/connection')).json()).authenticated, false, 'network update revokes excluded sessions');
    const peerIP = global.clientIP;
    run(executable, ['security', 'network', '--allow', '198.51.100.10', '--trusted-proxies', peerIP]);
    assert.equal((await contexts[0].request.get(base, { headers: { 'X-Forwarded-For': '198.51.100.10' } })).status(), 200);
    assert.equal((await contexts[0].request.get(base, { headers: { 'X-Forwarded-For': '198.51.100.10, 203.0.113.1' } })).status(), 403, 'spoofed leftmost proxy address accepted');
    run(executable, ['security', 'network', '--clear']);
    const rtl = await browser.newContext({ viewport: { width: 320, height: 740 } });
    const rtlLogin = await rtl.request.post(base + '/api/login', { data: { username: users[1].name, password: users[1].password, language: 'ar' }, headers: { 'X-Tuxee-Client': 'web' } });
    assert.equal(rtlLogin.status(), 200);
    const rtlPage = await appPage(rtl); await rtlPage.goto(base); await rtlPage.locator('.topbar').waitFor();
    await rtlPage.locator('.brand-button').click(); await rtlPage.locator('.start-menu [data-action=ShieldCheck]').click();
    const rtlDialog = rtlPage.locator('dialog[open]');
    await rtlDialog.locator('[name=password]').fill(users[1].password);
    await rtlDialog.locator('button[type=submit]').click();
    await rtlDialog.locator('[data-tab=global]').click();
    assert.equal(await rtlPage.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await rtlDialog.locator('.update-command').getAttribute('dir'), 'ltr');
    assert.ok((await rtlDialog.locator('.update-command').textContent()).includes('security network --clear --state'));
    await rtlDialog.screenshot({ path: 'test-results/security/global-ar-320.png' });
    const rtlCSRF = (await rtlLogin.json()).csrf;
    const rtlAPI = (path, method, data) => rtl.request.fetch(base + '/api/security' + path, {
        method, data, headers: { 'X-Tuxee-CSRF': rtlCSRF },
    });
    const policy = { allowedNetworks: [], trustedProxies: [] };
    const savePolicy = async () => rtlAPI('/network', 'PUT', policy);
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await savePolicy()).json(), { saved: true });
    const setup = await (await rtlAPI('/setup', 'POST', {})).json();
    const usedCode = totp(setup.secret, Date.now() / 1000 - 30);
    const enrolled = await rtlAPI('/enable', 'POST', { code: usedCode });
    assert.equal(enrolled.status(), 200);
    const backup = (await enrolled.json()).recoveryCodes[0];
    assert.equal((await savePolicy()).status(), 403);
    assert.equal((await rtlAPI('/unlock', 'POST', { password: 'wrong' })).status(), 401);
    const unlock = await (await rtlAPI('/unlock', 'POST', { password: users[1].password })).json();
    assert.deepEqual(Object.keys(unlock), ['challenge']);
    assert.equal((await rtlAPI('', 'GET')).status(), 403);
    for (const code of [usedCode, backup])
        assert.equal((await rtlAPI('/unlock', 'POST', { challenge: unlock.challenge, code })).status(), 401);
    assert.equal((await rtlAPI('/unlock', 'POST', { challenge: unlock.challenge, code: totp(setup.secret) })).status(), 200);
    assert.deepEqual(await (await savePolicy()).json(), { saved: true });
    assert.equal((await rtlAPI('/unlock', 'POST', { challenge: unlock.challenge, code: totp(setup.secret) })).status(), 401);
    assert.equal((await rtlAPI('/disable', 'POST', {})).status(), 200);
    assert.equal((await rtlAPI('', 'GET')).status(), 403);
    await rtl.close();
    assert.deepEqual(errors, []);
    console.log('Security: real PAM, authenticator and recovery-code login, enrollment, single-use recovery, permission gating, CLI unlock, network lockout/recovery, trusted proxies and mobile layouts passed' + (container ? ' in Docker.' : '.'));
} finally {
    if (service || container) { try { run(executable, ['security', 'network', '--clear']); } catch {} }
    await browser?.close();
    if (service) { service.kill('SIGTERM'); await stopped; }
    for (const user of users.reverse()) {
        run('userdel', [...(user.uid === 0 ? ['--force'] : []), user.name]);
        if (container) run('rm', ['-rf', user.home]);
    }
    await rm(directory, { recursive: true, force: true });
}
