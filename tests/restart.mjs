import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires root for isolated test accounts');
const dir = await mkdtemp('/tmp/tuxee-restart-'), users = [];
await chmod(dir, 0o755);
const executable = `${dir}/tuxee`, boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
const gui = spawnSync('sh', ['-c', 'command -v tuxee-Xvnc >/dev/null && command -v xterm >/dev/null']).status === 0;
let service, stopped, browser, unrelated;
try {
    for (const root of [true, false]) {
        const name = `tuxee-restart-${root ? 'root' : 'user'}-${process.pid}`, home = `${dir}/${root ? 'root' : 'user'}`;
        run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', ...(root ? ['-o', '-u', '0', '-g', '0'] : []), name]);
        const fields = run('getent', ['passwd', name]).split(':');
        const user = { name, home, uid: Number(fields[2]), gid: Number(fields[3]), password: randomBytes(24).toString('base64url') };
        users.push(user);
        await mkdir(home); await chown(home, user.uid, user.gid);
        run('chpasswd', [], `${name}:${user.password}\n`);
    }
    await copyFile('bin/tuxee', executable);
    const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn(executable, ['serve', '--http', '--bind', '127.0.0.1:0', '--state', `${dir}/state`, '--'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    let starts = 0;
    const addresses = [];
    service.stdout.on('data', data => {
        for (const match of String(data).matchAll(/listening at (http:\/\/\S+)/g)) { starts++; addresses.push(match[1]); }
    });
    for (let i = 0; starts === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(starts, 1, 'server did not start');
    const base = addresses[0];
    unrelated = spawn('sleep', ['300']);
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const contexts = await Promise.all(users.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })));
    const login = async i => {
        assert.equal((await contexts[i].request.post(base + '/api/login', { data: { username: users[i].name, password: users[i].password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
        return (await contexts[i].request.get(base + '/api/me')).json();
    };
    const identities = [await login(0), await login(1)];
    assert.equal(identities[0].user.uid, 0);
    const api = (i, path, method = 'GET', data) => contexts[i].request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': identities[i].csrf, 'X-Tuxee-Client': 'web' } });
    const terminals = [];
    for (let i = 0; i < users.length; i++) {
        const command = gui && i === 0
            ? "trap '' HUP; xterm -title Tuxee-restart-test & echo $! > gui-pid; printf ready > ready; wait"
            : "trap '' HUP; printf ready > ready; exec sleep 300";
        const response = await api(i, '/terminals', 'POST', { name: 'Restart test', directory: users[i].home, columns: 80, rows: 24, command });
        assert.equal(response.status(), 201, await response.text()); terminals.push(await response.json());
        assert.equal((await api(i, '/settings', 'PUT', { theme: 'dark', current: 'restart', workspaces: [{ id: 'restart', name: 'Restart test', columns: 4, rows: 2, active: 'files', panels: [
            { id: 'files', kind: 'files', path: users[i].home, x: 0, y: 0, w: 2, h: 2 },
            { id: 'terminal', kind: 'terminal', terminal: terminals[i].id, x: 2, y: 0, w: 2, h: 2 },
        ] }] })).status(), 200);
    }
    await writeFile(`${users[0].home}/draft.txt`, 'original\n');
    const pages = await Promise.all(contexts.map(context => context.newPage())), [page, other] = pages, errors = [];
    for (const p of pages) p.on('pageerror', error => errors.push(error.message));
    await Promise.all(pages.map(p => p.goto(base)));
    for (const p of pages) await p.locator('.terminal-view[data-state=connected]').waitFor();
    if (gui) await page.locator('.terminal-display[data-state=connected]').waitFor({ timeout: 15000 });
    const guiPID = gui ? Number(await readFile(`${users[0].home}/gui-pid`, 'utf8')) : 0;
    for (const mobile of [false, true]) {
        if (mobile) await other.setViewportSize({ width: 390, height: 844 });
        await other.getByRole('button', { name: 'User menu', exact: true }).click();
        assert.deepEqual(await other.locator('.account-menu [role=menuitem]').allTextContents().then(items => items.slice(-2)), ['Restart Tuxee', 'Log out']);
        await other.getByRole('menuitem', { name: 'Restart Tuxee', exact: true }).click();
        const denied = other.waitForResponse(base + '/api/restart');
        await other.getByRole('dialog', { name: 'Restart Tuxee?', exact: true }).getByRole('button', { name: 'Restart Tuxee', exact: true }).click();
        assert.equal((await denied).status(), 403);
        const deniedDialog = other.getByRole('dialog', { name: 'Cannot restart Tuxee', exact: true });
        await deniedDialog.getByText('Cannot restart Tuxee: operation not permitted', { exact: false }).waitFor();
        assert.match(await deniedDialog.textContent(), /If you have sudo access, run this command in a terminal/);
        assert.equal(await deniedDialog.locator('.update-command').textContent(), `sudo '${executable}' restart`);
        await deniedDialog.locator('.update-command').click();
        assert.equal(await other.evaluate(() => window.getSelection().toString()), `sudo '${executable}' restart`);
        assert.equal(await other.locator('.connection-overlay').count(), 0);
        assert.deepEqual(await (await api(1, '/connection')).json(), { authenticated: true, uid: identities[1].user.uid, csrf: identities[1].csrf, language: 'en' });
        for (const terminal of terminals) process.kill(terminal.pid, 0);
        assert.equal(starts, 1);
        await deniedDialog.getByRole('button', { name: 'Close dialog' }).click();
    }
    const anonymous = await browser.newContext();
    assert.equal((await anonymous.request.post(base + '/api/restart')).status(), 401); await anonymous.close();
    assert.equal((await contexts[0].request.post(base + '/api/restart')).status(), 403);
    assert.equal((await contexts[0].request.post(base + '/api/restart', { headers: { 'Origin': 'http://evil.test', 'X-Tuxee-CSRF': identities[0].csrf } })).status(), 403);
    assert.equal(starts, 1);
    const openRestart = async () => {
        await page.getByRole('button', { name: 'User menu', exact: true }).click();
        assert.deepEqual(await page.locator('.account-menu [role=menuitem]').allTextContents().then(items => items.slice(-2)), ['Restart Tuxee', 'Log out']);
        await page.getByRole('menuitem', { name: 'Restart Tuxee', exact: true }).click();
    };
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = page.locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved');
    await openRestart();
    await page.getByRole('dialog', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.match(await editor.textContent(), /unsaved/); assert.equal(starts, 1);
    await editor.click(); await page.keyboard.press('Control+z');
    const confirmation = page.getByRole('dialog', { name: 'Restart Tuxee?', exact: true });
    await mkdir('test-results', { recursive: true });
    for (const mobile of [false, true]) {
        if (mobile) {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
        }
        await openRestart(); await confirmation.waitFor();
        assert.match(await confirmation.textContent(), /ends all running terminals.*every user/);
        assert.match(await confirmation.textContent(), /Linux and other services keep running/);
        assert.match(await confirmation.textContent(), /reboot.*PID 1/);
        assert.ok(await confirmation.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
        await page.screenshot({ path: `test-results/restart-${mobile ? 'mobile-light' : 'desktop-dark'}.png` });
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(starts, 1); assert.equal((await api(0, '/connection')).status(), 200);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // A new inode at the installed path must be used after cleanup, as with an update.
    await copyFile('bin/tuxee', `${dir}/runtime`);
    await writeFile(`${dir}/next`, `#!/bin/sh\nprintf restarted > '${dir}/executed'\nexec '${dir}/runtime' "$@"\n`, { mode: 0o755 });
    await rename(`${dir}/next`, executable);
    const overlay = page.getByRole('dialog', { name: 'Connection lost, reconnecting...', exact: true });
    await openRestart();
    const accepted = page.waitForResponse(base + '/api/restart');
    await confirmation.getByRole('button', { name: 'Restart Tuxee', exact: true }).click();
    assert.equal((await accepted).status(), 202); await overlay.waitFor();
    await page.waitForFunction(() => {
        const dialog = document.querySelector('.connection-overlay');
        return dialog && getComputedStyle(dialog).opacity === '1' && getComputedStyle(dialog, '::backdrop').opacity === '1';
    });
    await page.screenshot({ path: 'test-results/restart-disconnected.png' });
    for (const p of pages) await p.locator('[name=username]').waitFor({ timeout: 20000 });
    await overlay.waitFor({ state: 'detached' });
    assert.equal(starts, 2); assert.equal(service.exitCode, null);
    assert.deepEqual(addresses, [base, base], 'restart must preserve an initially ephemeral port');
    assert.equal(await readFile(`${dir}/executed`, 'utf8'), 'restarted');
    assert.equal(await readFile('/proc/sys/kernel/random/boot_id', 'utf8'), boot);
    assert.equal(unrelated.exitCode, null);
    for (const terminal of terminals) assert.throws(() => process.kill(terminal.pid, 0), { code: 'ESRCH' });
    if (gui) assert.throws(() => process.kill(guiPID, 0), { code: 'ESRCH' });
    for (let i = 0; i < users.length; i++) {
        assert.deepEqual(await (await api(i, '/connection')).json(), { authenticated: false });
        assert.equal((await api(i, '/me')).status(), 401);
        identities[i] = await login(i);
        assert.equal(identities[i].settings.workspaces[0].panels[1].terminal, terminals[i].id);
        const inventory = await (await api(i, '/terminals')).json();
        assert.ok(inventory.some(info => info.id === terminals[i].id && info.exited && !info.closedAt));
        assert.ok(inventory.every(info => info.exited));
    }
    await page.reload(); await page.getByText('Post mortem', { exact: true }).waitFor();
    assert.deepEqual(errors, []);

    const deniedCLI = spawnSync(`${dir}/runtime`, ['restart'], { encoding: 'utf8', uid: users[1].uid, gid: users[1].gid });
    assert.equal(deniedCLI.status, 1);
    assert.match(deniedCLI.stderr, /Restart failed: operation not permitted/);
    assert.equal((await api(0, '/connection')).status(), 200);

    const cliTerminals = [];
    for (let i = 0; i < users.length; i++) {
        const response = await api(i, '/terminals', 'POST', { name: 'CLI restart', directory: users[i].home, columns: 80, rows: 24, command: 'exec sleep 300' });
        assert.equal(response.status(), 201); cliTerminals.push(await response.json());
    }
    await copyFile('bin/tuxee', `${dir}/next`);
    await rename(`${dir}/next`, `${dir}/runtime`);
    const cli = spawnSync(`${dir}/runtime`, ['restart'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, '\nRestarting Tuxee kills all running terminals and GUI applications and signs everyone out.\n\nRestart requested.\n');
    await writeFile('test-results/cli-restart-output.txt', cli.stdout);
    for (const p of pages) await p.locator('[name=username]').waitFor({ timeout: 20000 });
    assert.equal(starts, 3); assert.equal(service.exitCode, null);
    assert.equal(addresses[2], base);
    for (const terminal of cliTerminals) assert.throws(() => process.kill(terminal.pid, 0), { code: 'ESRCH' });
    for (let i = 0; i < users.length; i++) {
        assert.deepEqual(await (await api(i, '/connection')).json(), { authenticated: false });
        identities[i] = await login(i);
    }

    const selfRestart = await api(0, '/terminals', 'POST', { name: 'Restart from own terminal', directory: users[0].home, columns: 80, rows: 24,
        command: `while [ ! -e '${dir}/restart-now' ]; do sleep 0.05; done; exec '${dir}/runtime' restart` });
    assert.equal(selfRestart.status(), 201);
    const ownTerminal = await selfRestart.json();
    await writeFile(`${dir}/restart-now`, 'go');
    for (let i = 0; starts < 4 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(starts, 4); assert.equal(service.exitCode, null);
    assert.equal(addresses[3], base);
    assert.throws(() => process.kill(ownTerminal.pid, 0), { code: 'ESRCH' });
    for (let i = 0; i < users.length; i++) identities[i] = await login(i);
    assert.equal(unrelated.exitCode, null);
    console.log('PASS CLI restart after binary replacement, Linux permission denial, all-user cleanup, same PID/port, and restart from its own terminal');

    await api(0, '/terminals', 'POST', { name: 'Shutdown race', directory: users[0].home, columns: 80, rows: 24, command: "trap '' HUP; printf ready > shutdown-ready; exec sleep 300" });
    for (let i = 0; i < 100 && await readFile(`${users[0].home}/shutdown-ready`, 'utf8').catch(() => '') !== 'ready'; i++) await page.waitForTimeout(20);
    assert.equal(await readFile(`${users[0].home}/shutdown-ready`, 'utf8'), 'ready');
    assert.equal((await api(0, '/restart', 'POST', {})).status(), 202);
    service.kill('SIGTERM'); await stopped;
    assert.equal(starts, 4, 'shutdown during terminal cleanup must cancel the pending restart');
    assert.equal(service.exitCode, 0);
    console.log(`PASS restart menu for all users, Linux permission denial without interruption, CSRF/origin admission, cancellation/draft protection, desktop/mobile confirmation, real re-exec of updated binary, all-user terminal cleanup${gui ? ' including GUI' : ' (GUI unavailable)'}, loader → login, preserved settings, unrelated Linux processes and shutdown during restart`);
} finally {
    await browser?.close();
    if (service?.exitCode === null) { service.kill('SIGTERM'); await stopped; }
    unrelated?.kill();
    for (const user of users.reverse()) run('userdel', [...(user.uid === 0 ? ['--force'] : []), user.name]);
    await rm(dir, { recursive: true, force: true });
}
