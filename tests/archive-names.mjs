import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = `tuxee-poc-arc-${randomBytes(4).toString('hex')}`;
const state = await mkdtemp('/tmp/tuxee-archive-names-');
let server, stopped, browser, createdUser = false;
try {
    assert.equal(spawnSync('useradd', ['-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]).status, 0);
    createdUser = true;
    const password = randomBytes(24).toString('base64url');
    assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
    const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
    const dir = await mkdtemp(fields[5] + '/archives-');
    const cases = [
        ['Heroes 3 Complete.rar', 'Heroes 3 Complete'], ['release.v1.RAR', 'release.v1'],
        ...['zip', '7z', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tgz', 'tbz2', 'txz', 'TAR.GZ'].map(ext => [`release.v1.${ext}`, 'release.v1']),
        ['.rar', 'Archive'],
    ];
    for (const [name] of cases) await writeFile(`${dir}/${name}`, 'dialog naming fixture');
    await writeFile(`${dir}/payload.txt`, 'archive round trip\n');
    assert.equal(spawnSync('tar', ['-czf', `${dir}/round.trip.tar.gz`, '-C', dir, 'payload.txt']).status, 0);
    assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
    await chmod(state, 0o755);
    await copyFile('bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
    const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/data'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => server.once('exit', resolve));
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf, settings } = await (await context.request.get(base + '/api/me')).json();
    assert.equal((await context.request.put(base + '/api/settings', {
        headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
        data: { ...settings, current: 'archives', workspaces: [{ id: 'archives', name: 'Archives', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }] },
    })).status(), 200);
    const page = await appPage(context), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const file = page.locator('.file-view'), dialog = page.getByRole('dialog');
    const row = name => file.locator('.file-entry').filter({ has: page.getByText(name, { exact: true }) });
    await file.getByRole('checkbox', { name: 'Hidden', exact: true }).check();
    for (const [name, expected] of cases) {
        await row(name).dblclick();
        const folder = dialog.getByRole('textbox', { name: 'Extract folder', exact: true });
        await folder.waitFor();
        assert.equal(await folder.inputValue(), expected, name);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await row('Heroes 3 Complete.rar').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Extract…', exact: true }).click();
    assert.equal(await dialog.getByRole('textbox', { name: 'Extract folder', exact: true }).inputValue(), 'Heroes 3 Complete');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row('round.trip.tar.gz').dblclick();
    assert.equal(await dialog.getByRole('textbox', { name: 'Extract folder', exact: true }).inputValue(), 'round.trip');
    await dialog.getByRole('button', { name: 'Extract', exact: true }).click();
    await row('round.trip').waitFor();
    assert.equal(await readFile(`${dir}/round.trip/payload.txt`, 'utf8'), 'archive round trip\n');
    assert.deepEqual(errors, []);
    console.log('PASS archive defaults: RAR, ZIP, 7z, tar/compressed tar, uppercase, dotted/empty stems, context menu and real extraction without editing the destination');
} finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await stopped; }
    if (createdUser) assert.equal(spawnSync('userdel', ['-r', user]).status, 0);
    await rm(state, { recursive: true, force: true });
}
