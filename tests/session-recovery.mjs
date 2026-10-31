import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed`);
    return result.stdout.trim();
};
const dir = await mkdtemp('/tmp/tuxee-session-recovery-'), users = [];
await chmod(dir, 0o755);
let service, stopped, browser;
try {
    for (let i = 0; i < 2; i++) {
        const name = `tuxee-session-${process.pid}-${i}`, home = `${dir}/user-${i}`;
        run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', name]);
        users.push({ name, home, password: randomBytes(24).toString('base64url') });
        const fields = run('getent', ['passwd', name]).split(':');
        users[i].uid = Number(fields[2]); users[i].gid = Number(fields[3]);
        await mkdir(home); await chown(home, Number(fields[2]), Number(fields[3]));
        run('chpasswd', [], `${name}:${users[i].password}\n`);
    }
    const draftFile = `${users[0].home}/draft.txt`;
    await writeFile(draftFile, 'original\n', { mode: 0o644 });
    await chown(draftFile, users[0].uid, users[0].gid);
    await copyFile('bin/tuxee', `${dir}/tuxee`);
    const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn(`${dir}/tuxee`, ['serve', '--http', '--bind', '127.0.0.1:0', '--state', `${dir}/state`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    service.stderr.resume();
    const base = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('server startup timed out')), 10000);
        service.stdout.on('data', data => {
            const match = String(data).match(/listening at (http:\/\/\S+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        service.once('exit', () => { clearTimeout(timeout); reject(Error('server stopped')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: users[0].name, password: users[0].password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    let me = await (await context.request.get(base + '/api/me')).json();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const response = await api('/terminals', 'POST', { name: 'Session recovery', directory: users[0].home, columns: 80, rows: 24 });
    assert.equal(response.status(), 201);
    const original = await response.json();
    assert.equal((await api('/settings', 'PUT', {
        theme: 'dark', current: 'recovery',
        monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: ['/'], networks: [], interval: 2 },
        workspaces: [{ id: 'recovery', name: 'Recovery', columns: 4, rows: 2, active: 'terminal', panels: [
            { id: 'files', kind: 'files', path: users[0].home, x: 0, y: 0, w: 2, h: 2 },
            { id: 'terminal', kind: 'terminal', terminal: original.id, path: users[0].home, x: 2, y: 0, w: 2, h: 2 },
        ] }],
    })).status(), 200);
    const page = await appPage(context), errors = [], saves = [];
    let documents = 0, creations = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
        if (request.url() === base + '/api/terminals' && request.method() === 'POST') creations++;
        if (request.url() === base + '/api/settings' && request.method() === 'PUT') saves.push(request.postDataJSON());
    });
    await page.goto(base);
    const terminal = page.locator('.terminal-view');
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    const originalTerminal = await terminal.elementHandle();
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = page.locator('.cm-content');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved');
    const originalEditor = await editor.elementHandle(), draft = await editor.textContent();
    const other = await appPage(context);
    await other.goto(base);
    const login = async user => {
        assert.equal(await other.evaluate(async ({ name, password }) => (await fetch('/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tuxee-Client': 'web' }, body: JSON.stringify({ username: name, password }),
        })).status, user), 200);
        me = await (await context.request.get(base + '/api/me')).json();
    };
    const check = async () => {
        const response = page.waitForResponse(base + '/api/connection');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await response;
    };
    await login(users[0]);
    await page.bringToFront(); await check();
    const saved = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    assert.equal((await saved).status(), 200, 'same-account login must refresh the old window token');
    assert.equal(documents, 1);
    assert.ok(await originalEditor.evaluate(node => node.isConnected));
    assert.ok(await originalTerminal.evaluate(node => node.isConnected));
    assert.equal(await editor.textContent(), draft);
    assert.equal((await (await api(`/terminals/${original.id}`)).json()).pid, original.pid);
    console.log('PASS same-account login refreshes the token without reloading, remounting drafts or replacing the shell');

    // Hold readiness at the previous session to exercise an action racing the next refresh.
    const oldState = await (await api('/connection')).json();
    await page.route(base + '/api/connection', route => route.fulfill({ json: oldState }));
    await login(users[0]);
    assert.equal((await api(`/terminals/${original.id}`, 'DELETE')).status(), 200);
    const restart = terminal.getByRole('button', { name: 'Restart', exact: true });
    await restart.waitFor();
    const denied = page.waitForResponse(r => r.url() === base + `/api/terminals/${original.id}` && r.request().method() === 'DELETE');
    await restart.click();
    assert.equal((await denied).status(), 403);
    await page.waitForFunction(() => !document.querySelector('.restart-terminal')?.disabled);
    assert.ok(await restart.isVisible());
    assert.equal(await terminal.locator('.terminal-host').isVisible(), false);
    assert.equal(creations, 0, 'failed archive closure must not create a replacement');
    await page.unroute(base + '/api/connection'); await check();

    await page.route(base + '/api/settings', route => route.fulfill({ status: 503, json: { error: 'Save fixture failure' } }), { times: 1 });
    const created = page.waitForResponse(r => r.url() === base + '/api/terminals' && r.request().method() === 'POST');
    const failedSave = page.waitForResponse(base + '/api/settings');
    await restart.click();
    const creation = await created;
    assert.equal(creation.status(), 201);
    const replacement = await creation.json();
    assert.equal((await failedSave).status(), 503);
    await page.waitForFunction(() => !document.querySelector('.restart-terminal')?.disabled);
    assert.ok(await restart.isVisible());
    assert.equal(await terminal.locator('.terminal-host').isVisible(), false);
    const attempts = creations;
    await restart.click();
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal(creations, attempts, 'retry a failed save using the already-created shell');
    assert.equal(await terminal.getAttribute('data-terminal'), replacement.id);
    assert.equal((await (await api('/me')).json()).settings.workspaces[0].panels[1].terminal, replacement.id);
    assert.equal((await (await api('/terminals')).json()).filter(terminal => !terminal.exited).length, 1);
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'SESSION_%s\\n' 'RECOVERED'"); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('SESSION_RECOVERED'));
    assert.equal(await editor.textContent(), draft);
    console.log('PASS rejected archive closure keeps recovery visible; a failed save retries the same shell and restores real input');

    const beforeSwitch = saves.length;
    await login(users[1]); await page.bringToFront();
    await page.waitForFunction(name => document.querySelector('[aria-label="User menu"]')?.textContent.includes(name), users[1].name);
    assert.equal(documents, 2, 'a different account must replace the previous account UI');
    assert.ok(saves.slice(beforeSwitch).every(settings => settings.workspaces.every(ws => ws.id !== 'recovery')), 'account switch must not replay the previous layout');
    assert.equal(await readFile(draftFile, 'utf8'), 'original\n');
    assert.equal((await (await api('/me')).json()).settings.workspaces.some(ws => ws.id === 'recovery'), false);
    assert.deepEqual(errors, []);
    console.log('PASS switching accounts replaces the old UI without saving its draft or layout into the new account');
} finally {
    await browser?.close();
    if (service && service.exitCode === null) {
        service.kill('SIGTERM');
        const timeout = setTimeout(() => service.kill('SIGKILL'), 10000);
        await stopped; clearTimeout(timeout);
    }
    for (const user of users) run('userdel', [user.name]);
    await rm(dir, { recursive: true, force: true });
}
