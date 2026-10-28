import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const home = await mkdtemp('/tmp/tuxee-focus-user-'), state = await mkdtemp('/tmp/tuxee-focus-state-'), user = `tuxee-focus-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url'); run('chpasswd', [], `${user}:${password}\n`);
await writeFile(home + '/focus.txt', 'Focus fixture\n');
await chown(home + '/focus.txt', Number(fields[2]), Number(fields[3]));
const server = spawn(process.env.TUXEE_TEST_BINARY || './bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf } = await (await context.request.get(base + '/api/me')).json();
    const settings = { theme: 'dark', current: 'focus', workspaces: [{ id: 'focus', name: 'Focus', columns: 4, rows: 2, active: 'terminal', panels: [
        { id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 2, h: 2 },
        { id: 'terminal', kind: 'terminal', path: home, x: 2, y: 0, w: 2, h: 2 }
    ] }] };
    assert.equal((await context.request.put(base + '/api/settings', { data: settings, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } })).status(), 200);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const terminal = page.locator('[data-panel="terminal"]'), files = page.locator('[data-panel="files"]');
    await terminal.locator('.terminal-view[data-state="connected"]').waitFor();
    await files.locator('.file-entry').waitFor();
    const input = terminal.locator('.xterm-helper-textarea'), drawer = terminal.locator('.terminal-input');
    const toggle = terminal.getByRole('button', { name: 'Toggle terminal input', exact: true });
    const focused = async target => assert.ok(await target.evaluate(node => node.contains(document.activeElement)), 'expected component input focus');
    const point = async (target, x = .5, y = .5) => { const box = await target.boundingBox(); return { x: box.x + box.width * x, y: box.y + box.height * y }; };
    const click = async (target, x, y) => { const p = await point(target, x, y); await page.mouse.click(p.x, p.y); };
    for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await files.locator('.file-list').focus();
        await click(terminal.locator('.panel-header'), .7); await focused(input);
        await files.locator('.file-list').focus();
        await click(terminal.locator('.terminal-footer'), .45); await focused(input);
        await toggle.click(); await focused(drawer);
        await drawer.fill('live draft'); await drawer.selectText();
        await click(terminal.locator('.terminal-footer'), .45); await focused(drawer);
        assert.equal(await drawer.inputValue(), 'live draft');
        assert.ok(await drawer.evaluate(node => node.selectionStart === 0 && node.selectionEnd === node.value.length));
        await files.locator('.file-list').focus();
        await click(terminal.locator('.panel-header'), .7); await focused(drawer);
        await files.locator('.file-list').focus();
        await click(terminal.getByRole('button', { name: 'Previous input', exact: true })); await focused(drawer);
        await click(terminal.getByRole('button', { name: 'Next input', exact: true })); await focused(drawer);
        await terminal.locator('.terminal-tab').click(); await focused(drawer);
        await click(files.locator('.panel-header'), .02); await focused(files.locator('.file-list'));
        await drawer.focus(); await files.locator('.file-status').click(); await focused(files.locator('.file-list'));
        const hidden = files.getByRole('checkbox', { name: 'Hidden', exact: true });
        await hidden.check(); await focused(hidden); await hidden.uncheck();
        const path = files.locator('.path-input');
        await path.click(); await page.waitForTimeout(350); await focused(path);
        await path.fill(home + '/focus.txt'); await path.press('Enter'); await files.locator('.cm-content').waitFor();
        await drawer.focus(); await click(files.locator('.panel-header'), .02); await focused(files.locator('.cm-content'));
        await drawer.focus(); await click(files.getByRole('button', { name: 'Undo', exact: true })); await focused(files.locator('.cm-content'));
        await files.getByRole('button', { name: 'Back to files', exact: true }).click();
        await files.locator('.file-entry').waitFor();
        await terminal.getByRole('button', { name: 'Rename terminal', exact: true }).click();
        await page.locator('dialog').waitFor(); assert.ok(await page.locator('dialog').evaluate(node => node.contains(document.activeElement)));
        await page.keyboard.press('Escape');
        await toggle.click(); await focused(input);
    }
    const geometry = await terminal.getAttribute('gs-x');
    const from = await point(terminal.locator('.panel-header'), .7);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x - 80, from.y + 80, { steps: 8 });
    await page.locator('.board.docking').waitFor();
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await terminal.getAttribute('gs-x'), geometry, 'header dragging/cancellation remains available');
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(350);
    await toggle.click(); await drawer.fill('touch draft');
    const down = await point(terminal.getByRole('button', { name: 'Next input', exact: true }));
    await page.touchscreen.tap(down.x, down.y); await focused(drawer);
    assert.equal(await drawer.inputValue(), 'touch draft');
    await page.locator('[data-component-name=files]').click();
    await click(files.locator('.file-nav'), .995, .995); await focused(files.locator('.file-list'));
    assert.deepEqual(errors, []);
    console.log('PASS panel chrome focus, disabled arrows, drawer priority, editor/list input, controls, menus, cancelled header drag and touch');
    await browser.close(); browser = undefined;
    // Reuse the disposable account/server for real transport, history, undo and paste checks.
    const transport = spawn(process.execPath, ['tests/terminal-transport.mjs'], { stdio: 'inherit', env: { ...process.env, TUXEE_TEST_URL: base, TUXEE_TEST_USER: user } });
    assert.equal(await new Promise(resolve => transport.once('exit', resolve)), 0);
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
