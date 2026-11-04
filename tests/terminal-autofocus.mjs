import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const home = await mkdtemp('/tmp/tuxee-autofocus-user-'), state = await mkdtemp('/tmp/tuxee-autofocus-server-');
const user = `tuxee-focus-${process.pid}`, password = randomBytes(24).toString('base64url');
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const [, , uid, gid] = run('getent', ['passwd', user]).split(':');
await chown(home, Number(uid), Number(gid)); run('chpasswd', [], `${user}:${password}\n`);
await writeFile(home + '/focus.txt', 'Focus fixture\n'); await chown(home + '/focus.txt', Number(uid), Number(gid));
await chmod(state, 0o755); await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, api, serverError = '';
server.stderr.on('data', data => serverError += data);
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited: ' + serverError)); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf } = await (await context.request.get(base + '/api/me')).json();
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', howToSeen: true, current: 'focus', workspaces: ['focus', 'other'].map(id => ({
        id, name: id, columns: 4, rows: 2, active: id + '-files', panels: [{ id: id + '-files', kind: 'files', path: home, x: 0, y: 0, w: 1, h: 2 }],
    })) })).status(), 200);
    const page = await appPage(context), errors = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.locator('[data-panel=focus-files] .file-entry').waitFor();
    const addTerminal = page.getByRole('button', { name: 'Add terminal', exact: true }).and(page.locator('.add-panel'));
    const files = page.locator('[data-panel=focus-files]');
    const terminal = page.locator('[data-panel]').filter({ has: page.locator('.terminal-view') });
    const menuAdd = () => page.getByRole('menuitem', { name: 'Add terminal', exact: true }).click();
    const gap = async () => {
        const box = await page.locator('.board .grid-stack').boundingBox();
        return { x: box.x + box.width * .875, y: box.y + box.height * .75 };
    };
    async function connected() { await terminal.locator('.terminal-view[data-state=connected]').waitFor({ state: 'attached' }); }
    async function typed(label) {
        await connected();
        assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => node === document.activeElement), label + ': new terminal owns keyboard focus');
        await page.keyboard.type(`printf '${label}' > '${home}/typed'`); await page.keyboard.press('Enter');
        for (let i = 0; i < 100 && await readFile(home + '/typed', 'utf8').catch(() => '') !== label; i++) await page.waitForTimeout(50);
        assert.equal(await readFile(home + '/typed', 'utf8'), label, label + ': typing reaches the real PTY without another click');
        console.log('PASS ' + label + ' autofocus and immediate PTY input');
    }
    async function closeTerminal() {
        const id = await terminal.locator('[data-terminal]').getAttribute('data-terminal');
        const deleted = page.waitForResponse(response => response.url().endsWith('/api/terminals/' + id) && response.request().method() === 'DELETE');
        await page.keyboard.press('Alt+Shift+w'); await deleted; await terminal.waitFor({ state: 'detached' });
    }
    for (const [label, create] of [
        ['keyboard', () => page.keyboard.press('Alt+Shift+Enter')],
        ['toolbar', () => addTerminal.click()],
        ['blank-menu', async () => { const p = await gap(); await page.mouse.click(p.x, p.y, { button: 'right' }); await menuAdd(); }],
        ['split-menu', async () => { await files.locator('.panel-header').click({ button: 'right', position: { x: 20, y: 10 } }); await menuAdd(); }],
        ['file-toolbar', () => files.getByRole('button', { name: 'Open terminal here', exact: true }).click()],
        ['drag-add', async () => { const from = await addTerminal.boundingBox(), to = await gap(); await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up(); }],
    ]) { await create(); await typed(label); await closeTerminal(); }

    // Delay the real creation response to exercise the existing asynchronous focus/lifecycle boundary.
    for (const destination of ['unchanged', 'file-input', 'workspace', 'closed', 'keyboard-closed', 'compact-hidden']) {
        if (destination === 'compact-hidden') await page.setViewportSize({ width: 390, height: 844 });
        let release, created;
        const held = new Promise(resolve => release = resolve), pending = new Promise(resolve => created = resolve);
        const intercept = async route => {
            if (route.request().method() !== 'POST') return route.continue();
            const response = await route.fetch(); assert.equal(response.status(), 201);
            created((await response.json()).id); await held; await route.fulfill({ response });
        };
        await page.route('**/api/terminals', intercept);
        await addTerminal.click(); const id = await pending;
        const panelID = await terminal.getAttribute('data-panel');
        if (destination === 'file-input') await files.locator('.file-entry').first().click();
        if (destination === 'workspace') await page.locator('.workspace-tab').getByText('other', { exact: true }).click();
        let deleted;
        if (destination === 'closed' || destination === 'keyboard-closed') {
            await terminal.locator('.xterm-helper-textarea').evaluate(node => {
                window.closedTerminalFocused = false;
                node.addEventListener('focus', () => window.closedTerminalFocused = true, { once: true });
            });
            deleted = page.waitForResponse(response => response.url().endsWith('/api/terminals/' + id) && response.request().method() === 'DELETE');
            if (destination === 'keyboard-closed') await page.keyboard.press('Alt+Shift+w');
            else await terminal.getByRole('button', { name: 'Close panel', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-closing]'));
        }
        if (destination === 'compact-hidden') await page.locator('[data-component-name=focus-files]').click();
        const focus = await page.evaluateHandle(() => document.activeElement);
        release();
        if (deleted) {
            assert.ok((await deleted).ok()); await terminal.waitFor({ state: 'detached' });
            assert.equal((await api('/terminals/' + id)).status(), 404, 'closed pending terminal is terminated');
            assert.equal(await page.evaluate(() => window.closedTerminalFocused), false, 'closing terminal never receives late input focus');
        } else if (destination === 'workspace') {
            await page.waitForFunction(() => document.querySelectorAll('.board').length === 1 && document.querySelector('.board')?.dataset.workspace === 'other');
            // The warm view is detached: wait for its real socket, rather than querying the active board.
            for (let i = 0; i < 100 && !(await (await api('/terminals/' + id)).json()).attached; i++) await page.waitForTimeout(50);
            assert.ok((await (await api('/terminals/' + id)).json()).attached);
        } else await connected();
        await page.unroute('**/api/terminals', intercept);
        if (destination === 'unchanged') await typed('delayed-toolbar');
        else {
            if (!deleted) assert.ok(await focus.evaluate(node => node === document.activeElement || !node.isConnected && document.activeElement === document.body), destination + ': late creation does not steal focus');
            console.log('PASS late creation preserves ' + destination);
        }
        await focus.dispose();
        if (destination === 'workspace') await page.locator('.workspace-tab').getByText('focus', { exact: true }).click();
        if (destination === 'compact-hidden') await page.locator(`[data-component-name="${panelID}"]`).click();
        if (!deleted) {
            // Select the terminal for cleanup without adding another autofocus expectation.
            await terminal.locator('.xterm-helper-textarea').focus(); await closeTerminal();
        }
    }
    await addTerminal.tap(); await typed('compact-touch'); await closeTerminal();
    assert.deepEqual(errors, []);
} finally {
    if (api) for (const terminal of await (await api('/terminals')).json()) await api('/terminals/' + terminal.id, 'DELETE');
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    spawnSync('pkill', ['-KILL', '-u', uid]); run('userdel', [user]);
    await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
