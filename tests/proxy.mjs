import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, chown, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed`);
    return result.stdout.trim();
};
const user = 'tuxee-poc-proxy';
if (spawnSync('getent', ['passwd', user]).status !== 0)
    run('useradd', ['-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':'), home = fields[5];
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-proxy-');
const settingsPath = `${home}/.config/tuxee/settings.json`;
const original = await readFile(settingsPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
let service, browser, proxy;
const sockets = new Set();
let forwarded = true, stopped;
try {
    await mkdir(`${home}/.config/tuxee`, { recursive: true });
    await chown(`${home}/.config`, Number(fields[2]), Number(fields[3]));
    await chown(`${home}/.config/tuxee`, Number(fields[2]), Number(fields[3]));
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark', current: 'proxy', workspaces: [
        { id: 'proxy', name: 'Proxy test', columns: 4, rows: 2, panels: [
            { id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 2, h: 2 },
            { id: 'shell', kind: 'terminal', path: home, x: 2, y: 0, w: 2, h: 2 },
        ] },
    ] }), { mode: 0o600 });
    await chown(settingsPath, Number(fields[2]), Number(fields[3]));
    const env = { ...process.env };
    delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    const backend = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        service.stdout.on('data', data => {
            const match = String(data).match(/listening at (http:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        service.once('exit', () => { clearTimeout(timer); reject(Error('server stopped')); });
    });
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${state}/key.pem`, '-out', `${state}/cert.pem`, '-days', '1', '-subj', '/CN=localhost']);
    const headers = request => {
        const result = { ...request.headers };
        delete result['x-forwarded-proto'];
        if (forwarded) result['x-forwarded-proto'] = 'https';
        return result;
    };
    proxy = https.createServer({ key: await readFile(`${state}/key.pem`), cert: await readFile(`${state}/cert.pem`) }, (request, response) => {
        const upstream = http.request(new URL(request.url, backend), { method: request.method, headers: headers(request) }, remote => {
            response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
        });
        upstream.on('error', error => response.destroy(error));
        request.pipe(upstream);
    });
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('upgrade', (request, socket, head) => {
        const upstream = http.request(new URL(request.url, backend), { headers: headers(request) });
        upstream.on('upgrade', (response, remote, remoteHead) => {
            socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
            if (remoteHead.length) socket.write(remoteHead);
            if (head.length) remote.write(head);
            socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
            socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
            socket.pipe(remote).pipe(socket);
        });
        upstream.on('response', response => { response.resume(); socket.destroy(); });
        upstream.on('error', () => socket.destroy()); upstream.end();
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    await mkdir('test-results', { recursive: true });
    let terminalID;
    for (const host of ['127.0.0.1', 'localhost']) {
        forwarded = host === '127.0.0.1';
        const base = `https://${host}:${proxy.address().port}`;
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
        const page = await context.newPage(), errors = [], connected = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('websocket', socket => { assert.ok(socket.url().startsWith('wss://')); socket.on('framereceived', () => connected.push(socket.url())); });
        await page.goto(base);
        if (forwarded) assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), base + '/');
        await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
        const login = page.waitForResponse(response => response.url().endsWith('/api/login'));
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        const loginResponse = await login;
        assert.equal(loginResponse.status(), 200);
        assert.equal((await loginResponse.request().allHeaders()).origin, base);
        const cookie = (await context.cookies()).find(cookie => cookie.name === 'tuxee_session');
        assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
        const terminal = page.locator('.terminal-view[data-state=connected]');
        await terminal.waitFor(); await page.locator('.file-view').waitFor();
        if (await terminal.locator('.terminal-display').isVisible()) await page.locator('.terminal-tab').click();
        const me = await (await context.request.get(base + '/api/me')).json();
        const id = me.settings.workspaces[0].panels.find(panel => panel.kind === 'terminal').terminal;
        if (terminalID) assert.equal(id, terminalID, 'logout/domain change lost the retained terminal');
        terminalID = id;
        const inputPath = `${home}/tuxee-proxy-input.txt`;
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type(`printf proxy-input-ok > ${inputPath}`); await page.keyboard.press('Enter');
        for (let i = 0; i < 100 && await readFile(inputPath, 'utf8').catch(() => '') !== 'proxy-input-ok'; i++) await page.waitForTimeout(100);
        assert.equal(await readFile(inputPath, 'utf8'), 'proxy-input-ok');
        await rm(inputPath);
        await terminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.type('xterm -title Proxy-GUI &'); await page.keyboard.press('Enter');
        await terminal.locator('.terminal-display[data-state=connected]').waitFor({ timeout: 15000 });
        assert.ok(connected.some(url => url.endsWith('/display/ws')), 'GUI WebSocket delivered no frames');
        await page.screenshot({ path: `test-results/proxy-${forwarded ? 'forwarded' : 'origin-only'}.png` });
        for (const path of ['/api/login', `/api/terminals/${id}/ws`, `/api/terminals/${id}/display/ws`]) {
            const response = await context.request.fetch(base + path, { method: path.endsWith('login') ? 'POST' : 'GET', headers: { Origin: 'https://evil.test' } });
            assert.equal(response.status(), 403, 'foreign origin was accepted');
        }
        assert.equal((await context.request.post(base + '/api/logout', { headers: { Origin: base } })).status(), 403, 'CSRF token was not required');
        await page.getByRole('button', { name: 'User menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
        await page.locator('[name=username]').waitFor();
        assert.ok(!(await context.cookies()).some(cookie => cookie.name === 'tuxee_session'));
        assert.deepEqual(await (await context.request.get(base + '/api/connection')).json(), { authenticated: false });
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`PASS HTTPS proxy ${host}: real browser Origin, Secure cookie, files, terminal input, GUI WSS, origin/CSRF rejection and logout; forwarded headers ${forwarded ? 'on' : 'off'}`);
    }
} finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    service?.kill('SIGTERM'); if (stopped) await stopped;
    if (original) { await writeFile(settingsPath, original); await chown(settingsPath, Number(fields[2]), Number(fields[3])); }
    else await rm(settingsPath, { force: true });
    await rm(`${home}/tuxee-proxy-input.txt`, { force: true });
    await rm(state, { recursive: true, force: true });
}
