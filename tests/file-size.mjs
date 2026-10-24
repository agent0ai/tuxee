import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires root for an isolated test account');
const home = await mkdtemp('/tmp/tuxee-size-user-'), user = `tuxee-size-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const dir = await mkdtemp(fields[5] + '/tuxee-size-'), state = await mkdtemp('/tmp/tuxee-size-');
run('python3', ['-c', `import os,sys
p=sys.argv[1]
os.mkdir(p+'/many')
with open(p+'/source', 'wb') as f: f.truncate(262144)
for i in range(24000): os.link(p+'/source', p+'/many/'+str(i))
os.mkdir(p+'/empty')
with open(p+'/single', 'wb') as f: f.truncate(1536)
os.symlink('many', p+'/link')
`, dir]);
run('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]);
await mkdir(dir + '/locked', { mode: 0o700 });
await writeFile(dir + '/locked/secret', 'unreadable');
const server = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, api, settings;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function workers() {
    return spawnSync('ps', ['-o', 'pid=,args=', '--ppid', String(server.pid)], { encoding: 'utf8' }).stdout
        .split('\n').filter(line => /\s__files(?:\s|$)/.test(line)).map(line => line.trim().split(/\s+/)[0]);
}
async function noWorkers() {
    for (let i = 0; i < 150; i++) { if (!(await workers()).length) return; await pause(20); }
    assert.deepEqual(await workers(), [], 'file worker leaked');
}
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const meResponse = await context.request.get(base + '/api/me');
    assert.equal(meResponse.status(), 200, await meResponse.text());
    const me = await meResponse.json(); settings = me.settings;
    api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const saved = await api('/settings', 'PUT', { ...settings, current: 'size', workspaces: [{ id: 'size', name: 'Size', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }] });
    assert.equal(saved.status(), 200, saved.ok() ? '' : await saved.text());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
    await page.goto(base);
    const row = name => page.locator('.file-entry').filter({ has: page.locator('.file-name', { hasText: new RegExp(`^${name}$`) }) });
    const dialog = page.getByRole('dialog', { name: 'Properties', exact: true });
    const size = dialog.locator('.property-size > span:first-child');
    async function open(names) {
        for (let i = 0; i < names.length; i++) await row(names[i]).locator('.file-name').click({ modifiers: i ? ['Control'] : [] });
        await page.getByRole('button', { name: 'Properties', exact: true }).click(); await dialog.waitFor();
    }
    async function close() { await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); await noWorkers(); }
    await open(['single']);
    assert.equal(await row('single').locator('.file-size').textContent(), '1.5K');
    assert.equal(await row('single').locator('.file-size').getAttribute('title'), (1536).toLocaleString() + ' bytes');
    assert.equal(await dialog.locator('dt').filter({ hasText: /^Total size$/ }).evaluate(node => node.nextElementSibling.textContent), '1.5 KiB');
    assert.equal(await dialog.getByRole('button', { name: 'Calculate', exact: true }).count(), 0); await close();
    await open(['many', 'single']);
    await page.waitForFunction(() => document.querySelector('.property-size > span')?.textContent !== '~0 B');
    assert.equal(await dialog.getByRole('button', { name: 'Stop', exact: true }).evaluate(node => node.previousElementSibling?.textContent), 'Calculating…');
    const [worker] = await workers(); assert.ok(worker);
    const threadStats = await Promise.all((await readdir(`/proc/${worker}/task`)).map(tid => readFile(`/proc/${worker}/task/${tid}/stat`, 'utf8')));
    assert.ok(threadStats.some(stats => Number(stats.slice(stats.lastIndexOf(')') + 2).split(' ')[16]) === 19), 'filesystem thread has low priority');
    const memory = await readFile(`/proc/${worker}/status`, 'utf8');
    assert.ok(Number(memory.match(/VmRSS:\s+(\d+)/)[1]) < 65536, 'bounded worker memory');
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click(); await noWorkers();
    const partial = await size.textContent(); assert.match(partial, /^~/);
    await pause(600); assert.equal(await size.textContent(), partial);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/file-size-stopped.png' });
    await dialog.getByRole('button', { name: 'Calculate', exact: true }).click();
    await size.evaluate(node => {
        window.sizeUpdates = [];
        window.sizeObserver = new MutationObserver(() => window.sizeUpdates.push({ time: performance.now(), value: node.textContent }));
        window.sizeObserver.observe(node, { childList: true, characterData: true, subtree: true });
    });
    await dialog.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await size.textContent(), '5.9 GiB');
    assert.equal(await size.getAttribute('title'), (24000 * 262144 + 1536).toLocaleString() + ' bytes');
    const updates = await page.evaluate(() => { window.sizeObserver.disconnect(); return window.sizeUpdates; });
    const intermediate = updates.filter(p => p.value.startsWith('~') && p.value !== '~0 B');
    assert.ok(intermediate.length >= 2, 'live progress');
    for (let i = 1; i < intermediate.length; i++) assert.ok(intermediate[i].time - intermediate[i - 1].time >= 430, JSON.stringify(updates));
    assert.equal(await dialog.getByRole('button', { name: 'Calculate', exact: true }).count(), 0);
    await page.screenshot({ path: 'test-results/file-size-complete.png' }); await close();
    await open(['empty']); await page.waitForFunction(() => document.querySelector('.property-size > span')?.textContent === '0 B'); await close();
    await open(['locked']); await dialog.getByText('1 skipped', { exact: true }).waitFor(); assert.equal(await size.textContent(), '~0 B'); await close();
    await open(['link']); assert.equal(await dialog.locator('.property-size').count(), 0); await close();
    await open(['many']); await dialog.getByRole('button', { name: 'Stop', exact: true }).waitFor(); await close();
    await page.setViewportSize({ width: 390, height: 844 });
    await open(['many']); await dialog.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: 'test-results/file-size-mobile.png' });
    await context.setOffline(true); await noWorkers();
    assert.equal(await dialog.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    await context.setOffline(false); await page.locator('.connection-overlay').waitFor({ state: 'hidden' }); await close();
    // Two live streams exhaust the global limit; aborting either releases its real worker.
    await page.evaluate(async ({ path, csrf }) => {
        window.sizeRequests = [];
        for (let i = 0; i < 2; i++) {
            const controller = new AbortController(); window.sizeRequests.push(controller);
            const response = await fetch('/api/file-size', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tuxee-CSRF': csrf }, body: JSON.stringify({ paths: [path] }), signal: controller.signal });
            if (response.status !== 200) throw Error('scan did not start');
        }
    }, { path: dir + '/many', csrf: me.csrf });
    assert.equal((await api('/file-size', 'POST', { paths: [dir] })).status(), 429);
    await page.evaluate(() => window.sizeRequests.forEach(c => c.abort())); await noWorkers();
    const invalid = await api('/file-size', 'POST', { paths: ['relative'] }); assert.equal(invalid.status(), 400);
    await open(['many']);
    assert.equal((await api('/logout', 'POST')).status(), 200); await noWorkers();
    assert.deepEqual(errors, []);
    console.log('PASS: live 500 ms updates, exact mixed totals, sparse/hardlink sizes, permissions, Stop/Calculate, close/offline/logout cleanup, admission limits and mobile layout.');
    // Restore through a fresh session after testing logout cancellation.
    await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
    const restored = await (await context.request.get(base + '/api/me')).json(); me.csrf = restored.csrf;
} finally {
    try { if (api && settings) await api('/settings', 'PUT', settings); }
    finally {
        await browser?.close(); server.kill('SIGTERM'); await stopped;
        run('userdel', [user]);
        await rm(state, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
    }
}
