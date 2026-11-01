import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'isolated PAM accounts require root');
const dir = await mkdtemp('/tmp/tuxee-update-restart-'), users = [], terminals = [];
await chmod(dir, 0o755);
let service, stopped, browser, contexts, identities, base, unrelated, cleanup;
try {
    const go = process.env.TUXEE_GO || (await import('node:fs')).existsSync('.tools/go/bin/go') && resolve('.tools/go/bin/go') || 'go';
    for (const version of ['1.0.0', '1.1.0']) {
        run(go, ['test', '-c', '-ldflags', `-X tuxee/cmd/tuxee.version=${version}`, '-o', `${dir}/${version}`, './cmd/tuxee']);
        assert.equal(run(`${dir}/${version}`, ['version']), `Tuxee ${version}`);
    }
    const executable = `${dir}/tuxee`;
    await copyFile(`${dir}/1.0.0`, executable);
    for (const root of [true, false]) {
        const name = `tuxee-update-${root ? 'root' : 'user'}-${process.pid}`, home = `${dir}/${root ? 'root' : 'user'}`;
        run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', ...(root ? ['-o', '-u', '0', '-g', '0'] : []), name]);
        const fields = run('getent', ['passwd', name]).split(':');
        const user = { name, home, uid: Number(fields[2]), gid: Number(fields[3]), password: randomBytes(24).toString('base64url') };
        users.push(user); await mkdir(home); await chown(home, user.uid, user.gid);
        await writeFile(`${home}/update-browser-fixture.json`, JSON.stringify({ Binary: `${dir}/1.1.0` }));
        run('chpasswd', [], `${name}:${user.password}\n`);
    }
    await writeFile(`${users[0].home}/draft.txt`, 'original\n');
    const env = { ...process.env, HOME: users[0].home }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn(executable, ['serve', '--http', '--bind', '127.0.0.1:0', '--state', `${dir}/state`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    let starts = 0, log = '';
    const addresses = [];
    service.stdout.on('data', data => { log += data; for (const match of String(data).matchAll(/listening at (http:\/\/\S+)/g)) { starts++; addresses.push(match[1]); } });
    service.stderr.on('data', data => { log += data; });
    for (let i = 0; starts === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(starts, 1, log); base = addresses[0];
    unrelated = spawn('sleep', ['300']);
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    contexts = await Promise.all(users.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })));
    const login = async i => {
        assert.equal((await contexts[i].request.post(base + '/api/login', { data: { username: users[i].name, password: users[i].password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
        return (await contexts[i].request.get(base + '/api/me')).json();
    };
    identities = [await login(0), await login(1)];
    const api = (i, path, method = 'GET', data) => contexts[i].request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': identities[i].csrf, 'X-Tuxee-Client': 'web' } });
    cleanup = async () => {
        for (let i = 0; i < contexts.length; i++) {
            identities[i] = await login(i);
            if (terminals[i]) await api(i, '/terminals/' + terminals[i].id, 'DELETE');
        }
    };
    for (let i = 0; i < users.length; i++) {
        const response = await api(i, '/terminals', 'POST', { name: 'Update survival', directory: users[i].home, columns: 80, rows: 24, command: 'printf "before automatic update\\n"; exec sleep 300' });
        assert.equal(response.status(), 201); terminals.push(await response.json());
        assert.equal((await api(i, '/settings', 'PUT', { howToSeen: true, theme: 'dark', current: 'update', workspaces: [{ id: 'update', name: 'Update', columns: 4, rows: 2, active: 'files', panels: [
            { id: 'files', kind: 'files', path: users[i].home, x: 0, y: 0, w: 2, h: 2 },
            { id: 'terminal', kind: 'terminal', terminal: terminals[i].id, x: 2, y: 0, w: 2, h: 2 },
        ] }] })).status(), 200);
    }
    assert.equal((await (await api(1, '/update')).json()).canApply, false);
    assert.equal((await api(1, '/update/apply', 'POST')).status(), 403);
    const pages = await Promise.all(contexts.map(context => appPage(context))), [page] = pages, errors = [];
    pages.forEach(p => p.on('pageerror', error => errors.push(error.message)));
    await Promise.all(pages.map(p => p.goto(base)));
    for (const p of pages) await p.locator('.terminal-view[data-state=connected]').waitFor();
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = page.locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved');
    await page.locator('.brand-button').click();
    const install = page.locator('.update-install'); await install.waitFor();
    let reloads = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads++; });
    const accepted = page.waitForResponse(base + '/api/update/apply');
    await install.click(); assert.equal((await accepted).status(), 202);
    for (const p of pages) await p.locator('[name=username]').waitFor({ timeout: 20000 });
    assert.equal(starts, 2, 'Update must restart immediately without another click');
    assert.equal(service.exitCode, null); assert.equal(addresses[1], base); assert.ok(reloads >= 1, 'new frontend fetched');
    assert.equal(run(executable, ['version']), 'Tuxee 1.1.0');
    assert.equal(unrelated.exitCode, null);
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/update-restart-login.png' });
    for (let i = 0; i < users.length; i++) {
        assert.equal((await (await api(i, '/connection')).json()).authenticated, false, 'all old sessions revoked');
        identities[i] = await login(i);
        const retained = await (await api(i, '/terminals/' + terminals[i].id)).json();
        assert.equal(retained.pid, terminals[i].pid); assert.equal(retained.exited, false); process.kill(retained.pid, 0);
        const status = await (await api(i, '/update')).json();
        assert.equal(status.current, '1.1.0'); assert.equal(status.available, false); assert.equal(status.restartNeeded, false);
    }
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await editor.waitFor(); assert.match(await editor.textContent(), /unsaved/, 'update restores editor drafts');
    await page.locator('.brand-button').click(); await page.getByText('Up to date', { exact: true }).waitFor();
    await page.screenshot({ path: 'test-results/update-restart-installed.png' });
    assert.deepEqual(errors, []);
    console.log('PASS real verified 1.0.0 → 1.1.0 install, immediate same-PID/port re-exec, fresh frontend/login, all-user terminal survival, permissions and editor-draft restoration');
} finally {
    if (cleanup && service?.exitCode === null) await cleanup().catch(error => console.error('cleanup:', error.message));
    await browser?.close(); unrelated?.kill('SIGKILL');
    if (service?.exitCode === null) { service.kill('SIGTERM'); await stopped; }
    for (const user of users.reverse()) {
        if (user.uid !== 0) { spawnSync('pkill', ['-KILL', '-u', String(user.uid)]); spawnSync('userdel', [user.name]); }
        else spawnSync('userdel', ['-f', user.name]);
    }
    await rm(dir, { recursive: true, force: true });
}
