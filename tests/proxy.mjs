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
async function freePort() {
    const listener = http.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
}
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
    const httpPort = await freePort(), httpsPort = await freePort();
    const plain = `http://127.0.0.1:${httpPort}`, secure = `https://127.0.0.1:${httpsPort}`;
    service = spawn('./bin/tuxee', ['serve', '--http-port', String(httpPort), '--https-port', String(httpsPort), '--acme', 'off', '--state', state], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        let output = '';
        service.stdout.on('data', data => {
            output += data;
            if (output.includes('listening at http://') && output.includes('listening at https://')) { clearTimeout(timer); resolve(); }
        });
        service.once('exit', () => { clearTimeout(timer); reject(Error('server stopped')); });
    });
    let backend = plain;
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${state}/key.pem`, '-out', `${state}/cert.pem`, '-days', '1', '-subj', '/CN=localhost']);
    const headers = request => {
        const result = { ...request.headers };
        delete result['x-forwarded-proto'];
        if (forwarded) result['x-forwarded-proto'] = 'https';
        return result;
    };
    proxy = https.createServer({ key: await readFile(`${state}/key.pem`), cert: await readFile(`${state}/cert.pem`) }, (request, response) => {
        const transport = backend.startsWith('https:') ? https : http;
        const upstream = transport.request(new URL(request.url, backend), { method: request.method, headers: headers(request), rejectUnauthorized: false }, remote => {
            response.writeHead(remote.statusCode, remote.headers); remote.pipe(response);
        });
        upstream.on('error', error => response.destroy(error));
        request.pipe(upstream);
    });
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('upgrade', (request, socket, head) => {
        const transport = backend.startsWith('https:') ? https : http;
        const upstream = transport.request(new URL(request.url, backend), { headers: headers(request), rejectUnauthorized: false });
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
    for (const test of [
        { name: 'direct-http', base: plain, label: 'Plain HTTP', source: 'http' },
        { name: 'direct-https', base: secure, label: 'Encrypted with a local certificate', source: 'local' },
        { name: 'forwarded', host: '127.0.0.1', forwarded: true, source: 'http' },
        { name: 'origin-only', host: 'localhost', source: 'http' },
        { name: 'reencrypted', host: '127.0.0.1', forwarded: true, tlsBackend: true, source: 'https' },
    ]) {
        forwarded = !!test.forwarded;
        backend = test.tlsBackend ? secure : plain;
        const base = test.base || `https://${test.host}:${proxy.address().port}`;
        const encrypted = base.startsWith('https:');
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
        const page = await context.newPage(), errors = [], connected = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('websocket', socket => { assert.ok(socket.url().startsWith(encrypted ? 'wss://' : 'ws://')); socket.on('framereceived', () => connected.push(socket.url())); });
        await page.goto(base);
        if (forwarded) assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), base + '/');
        await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
        const login = page.waitForResponse(response => response.url().endsWith('/api/login'));
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        const loginResponse = await login;
        assert.equal(loginResponse.status(), 200);
        assert.equal((await loginResponse.request().allHeaders()).origin, base);
        const cookieName = `tuxee_session_${(await readFile(`${state}/instance-id`, 'utf8')).trim()}`;
        const cookie = (await context.cookies()).find(cookie => cookie.name === cookieName);
        assert.ok(cookie && cookie.secure === encrypted && cookie.httpOnly && cookie.sameSite === 'Strict');
        const terminal = page.locator('.terminal-view[data-state=connected]');
        await terminal.waitFor(); await page.locator('.file-view').waitFor();
        const tls = await (await context.request.get(base + '/api/tls')).json();
        assert.equal(tls.source, test.source);
        if (test.source !== 'local') assert.deepEqual(Object.keys(tls), ['source']);
        async function checkConnection() {
            await page.getByRole('button', { name: 'User menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
            await dialog.waitFor();
            assert.deepEqual(await dialog.locator('.tls-status p').allTextContents(), [test.label || 'Encrypted HTTPS']);
            assert.equal(await dialog.getByRole('link', { name: 'Download local CA certificate' }).count(), test.source === 'local' ? 1 : 0);
            await page.screenshot({ path: `test-results/proxy-${test.name}-settings.png` });
            await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        }
        await checkConnection();
        if (!encrypted) {
            assert.equal(await page.evaluate(() => window.isSecureContext), true, 'HTTP localhost is a secure context, but not TLS');
            await page.route('**/api/tls', route => route.fulfill({ json: { source: 'local', error: 'Unrelated local CA error' } }));
            await checkConnection();
            await page.unroute('**/api/tls');
        }
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
        await page.screenshot({ path: `test-results/proxy-${test.name}.png` });
        for (const path of ['/api/login', `/api/terminals/${id}/ws`, `/api/terminals/${id}/display/ws`]) {
            const response = await context.request.fetch(base + path, { method: path.endsWith('login') ? 'POST' : 'GET', headers: { Origin: 'https://evil.test' } });
            assert.equal(response.status(), 403, 'foreign origin was accepted');
        }
        assert.equal((await context.request.post(base + '/api/logout', { headers: { Origin: base } })).status(), 403, 'CSRF token was not required');
        await page.getByRole('button', { name: 'User menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
        await page.locator('[name=username]').waitFor();
        assert.ok(!(await context.cookies()).some(cookie => cookie.name === cookieName));
        assert.deepEqual(await (await context.request.get(base + '/api/connection')).json(), { authenticated: false });
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`PASS ${test.name}: connection label/CA visibility, browser Origin, cookies, files, terminal input, GUI WebSocket, origin/CSRF rejection and logout`);
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
