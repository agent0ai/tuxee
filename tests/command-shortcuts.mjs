import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const container = process.env.TUXEE_TEST_CONTAINER;
const run = (command, args = [], input) => {
    const result = container ? spawnSync('docker', ['exec', '-i', container, command, ...args], { input, encoding: 'utf8' }) : spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const user = `tuxee-cmd-${process.pid}`, other = user + '-b', password = randomBytes(24).toString('base64url');
const home = run('mktemp', ['-d', '/tmp/tuxee-command-user-XXXXXX']);
const otherHome = run('mktemp', ['-d', '/tmp/tuxee-command-other-XXXXXX']);
const accounts = [];
let server, stopped, state, browser, api;
try {
    for (const [name, directory] of [[user, home], [other, otherHome]]) {
        run('useradd', ['-M', '-d', directory, '-s', '/bin/bash', '-c', 'Tuxee prototype test', name]);
        const [, , uid, gid] = run('getent', ['passwd', name]).split(':'); accounts.push([name, uid]);
        run('chown', [`${uid}:${gid}`, directory]); run('chpasswd', [], `${name}:${password}\n`);
    }
    run('mkdir', [home + '/cwd']); run('chown', [user, home + '/cwd']);
    let base = process.env.TUXEE_TEST_URL;
    if (!container) {
        state = await mkdtemp('/tmp/tuxee-command-server-'); await chmod(state, 0o755);
        await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
        const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
        server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        stopped = new Promise(resolve => server.once('exit', resolve));
        let logs = ''; server.stderr.on('data', data => logs = (logs + data).slice(-4000));
        base = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('startup timeout')), 10000);
            server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
            server.once('exit', () => { clearTimeout(timeout); reject(Error(logs)); });
        });
    }
    assert.ok(base, 'TUXEE_TEST_URL is required with a container');
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
    const login = async (context, name, language = 'en') => {
        assert.equal((await context.request.post(base + '/api/login', { data: { username: name, password, language }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
        return (await context.request.get(base + '/api/me')).json();
    };
    const { csrf } = await login(context, user);
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const preferences = {
        theme: 'dark', howToSeen: true, serverName: 'Shortcut fixture', shellCommand: 'bash', shortcuts: { 'app.about': [[], []] }, current: 'commands',
        workspaces: ['commands', 'other'].map(id => ({ id, name: id, defaultDirectory: home + '/cwd', columns: 4, rows: 2, active: id + '-files', panels: [{ id: id + '-files', kind: 'files', path: home, x: 0, y: 0, w: 1, h: 2 }] })),
    };
    assert.equal((await api('/settings', 'PUT', preferences)).status(), 200);
    const getSettings = async () => (await (await api('/me')).json()).settings;
    const page = await appPage(context), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(base); await page.locator('[data-panel=commands-files]').waitFor();
    const toggle = page.locator('.brand-button'), menu = page.locator('.start-menu:popover-open');
    const dialog = page.locator('dialog:has(.command-shortcut-form)');
    const rows = page.locator('.command-shortcut-row');
    const terminal = page.locator('[data-panel]').filter({ has: page.locator('.terminal-view') });
    for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.theme-toggle').click();
        const buttons = await page.locator('.panel-additions > button').evaluateAll(nodes => nodes.map(node => ({
            kind: node.dataset.kind || (node.classList.contains('layout-cycle') ? 'layout' : ''),
            color: getComputedStyle(node).color,
        })));
        assert.deepEqual(buttons.map(button => button.kind), ['files', 'terminal', 'layout']);
        assert.equal(new Set(buttons.map(button => button.color)).size, 1, `${theme} toolbar colors match`);
    }
    await page.locator('.theme-toggle').click();
    const poll = async (check, message) => { for (let i = 0; i < 160; i++) { if (await check()) return; await page.waitForTimeout(50); } assert.fail(message); };
    const saved = async () => { await dialog.waitFor({ state: 'detached' }); await page.waitForTimeout(300); };
    async function add(name, command) {
        await toggle.click(); await menu.getByRole('menuitem', { name: 'Add favorite', exact: true }).click();
        await dialog.locator('[name=name]').fill(name); await dialog.locator('[name=command]').fill(command);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
    }
    async function openComponentMenu(id) {
        await page.locator('#app.compact').waitFor();
        const opener = page.locator(`[data-component-menu="${id}"]`);
        if (!await opener.isVisible()) await page.locator('.component-tabs > .overflow-toggle').tap();
        await opener.tap();
    }
    async function closeTerminal() {
        const id = await terminal.locator('[data-terminal]').getAttribute('data-terminal');
        const response = page.waitForResponse(r => r.url().endsWith('/api/terminals/' + id) && r.request().method() === 'DELETE');
        if (await page.locator('#app').evaluate(node => node.classList.contains('compact'))) {
            await openComponentMenu(await terminal.getAttribute('data-panel')); await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
        } else await terminal.getByRole('button', { name: 'Close window', exact: true }).click();
        await response; await terminal.waitFor({ state: 'detached' });
    }
    await mkdir('test-results/command-shortcuts', { recursive: true });
    await toggle.click(); await menu.getByRole('menuitem', { name: 'Add favorite' }).click();
    assert.equal(await dialog.locator('textarea').getAttribute('rows'), '3');
    await dialog.locator('[name=name]').fill('  '); await dialog.locator('[name=command]').fill('pwd');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click(); assert.ok(await dialog.isVisible());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.ok(await toggle.evaluate(node => node === document.activeElement), 'modal cancel restores opener');
    const command = "pwd > cwd\nprintf 'first\\nsecond\\n' >> count\nfalse";
    await add('<b>Multiline</b>', command);
    assert.equal((await getSettings()).commandShortcuts[0].command, command);
    await page.reload(); await toggle.click();
    assert.equal(await rows.locator('b').count(), 0, 'shortcut names are plain text');
    assert.equal(await rows.locator('.command-shortcut-run').textContent(), '<b>Multiline</b>');
    let creates = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/terminals')) creates++; });
    await rows.locator('.component-menu').click();
    assert.equal(creates, 0, 'chevron does not run'); assert.equal(await page.locator(':popover-open').count(), 2);
    await page.keyboard.press('ArrowDown'); assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit');
    await page.keyboard.press('Escape'); assert.ok(await rows.locator('.component-menu').evaluate(node => node === document.activeElement));
    await rows.locator('.command-shortcut-run').click({ button: 'right' });
    assert.deepEqual(await page.locator('.menu-actions [role=menuitem]').allTextContents(), ['Run', 'Edit', 'Delete']); assert.equal(creates, 0);
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    assert.equal(await dialog.locator('textarea').inputValue(), command);
    await dialog.locator('[name=name]').fill('Multiline');
    const failSave = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture save failure' }) });
    await page.route('**/api/settings', failSave);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Fixture save failure' }).waitFor();
    assert.equal(await dialog.locator('textarea').inputValue(), command); assert.equal((await getSettings()).commandShortcuts[0].name, '<b>Multiline</b>');
    await page.unroute('**/api/settings', failSave); await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
    assert.deepEqual((await getSettings()).shortcuts, preferences.shortcuts); assert.equal((await getSettings()).serverName, preferences.serverName);
    await toggle.click(); await menu.locator('.start-favorites-heading strong').click({ button: 'right' });
    assert.deepEqual(await page.locator('.menu-actions [role=menuitem]').allTextContents(), ['Add favorite']);
    await page.locator('.menu-actions').getByRole('menuitem', { name: 'Add favorite', exact: true }).click();
    assert.equal(await dialog.locator('[name=name]').inputValue(), ''); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    console.log('PASS create/edit/cancel, failed-save recovery, literal text, row and empty-area context actions and keyboard focus');

    await toggle.click(); await rows.locator('.command-shortcut-run').click();
    await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
    assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => node === document.activeElement));
    await poll(() => { try { return run('cat', [home + '/cwd/count']) === 'first\nsecond'; } catch { return false; } }, 'initial command did not complete');
    assert.equal(run('cat', [home + '/cwd/cwd']), home + '/cwd'); assert.equal(run('cat', [home + '/cwd/count']), 'first\nsecond');
    assert.equal(run('stat', ['-c', '%U', home + '/cwd/count']), user);
    assert.equal(creates, 1);
    const firstID = await terminal.locator('[data-terminal]').getAttribute('data-terminal');
    await terminal.getByRole('button', { name: 'Reconnect terminal', exact: true }).click();
    await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await page.reload(); await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
    assert.equal(await terminal.locator('[data-terminal]').getAttribute('data-terminal'), firstID); assert.equal(creates, 1);
    assert.equal(run('cat', [home + '/cwd/count']), 'first\nsecond');
    assert.ok(!(await getSettings()).workspaces.some(w => w.panels.some(p => 'command' in p)), 'launch command is not persisted on panels');
    assert.equal((await (await api('/terminals/' + firstID)).json()).exited, false);
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf usable > after-shortcut'); await page.keyboard.press('Enter');
    await poll(() => { try { return run('cat', [home + '/cwd/after-shortcut']) === 'usable'; } catch { return false; } }, 'shell did not accept input after failed shortcut');
    assert.equal(await terminal.locator('.terminal-archive').count(), 0);
    await closeTerminal();
    console.log('PASS multiline shortcut returns to a usable shell after failure; reconnect/rerender/refresh do not replay');

    async function dragShortcut(x, y) {
        await toggle.click();
        const from = await rows.first().locator('.command-shortcut-run').boundingBox();
        const grid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
        await page.mouse.move(grid.x + grid.width * x, grid.y + grid.height * y, { steps: 12 });
        await page.locator('.new-panel-drag').waitFor();
        assert.equal(await menu.count(), 0, 'dragging closes the shortcut menu');
    }
    await poll(async () => !(await getSettings()).workspaces[0].panels.some(p => p.kind === 'terminal'), 'closed panel was not saved');
    const beforeDrag = await getSettings(), beforeCreates = creates;
    for (const cancel of ['Escape', 'outside', 'pointercancel', 'blur']) {
        await dragShortcut(.625, .25);
        await page.locator('.dock-preview.visible:not(.invalid)').waitFor();
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        if (cancel === 'outside') await page.mouse.move(10, 10, { steps: 8 });
        if (cancel === 'pointercancel') await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
        if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.mouse.up(); await page.waitForTimeout(300);
        assert.equal(creates, beforeCreates, `${cancel} does not launch a command`);
        assert.deepEqual((await getSettings()).workspaces, beforeDrag.workspaces, `${cancel} preserves layout`);
        assert.equal(await page.locator('.new-panel-drag, .dock-preview.visible').count(), 0);
    }
    let launches = 0;
    for (const [x, y, expected] of [[.625, .25, [2, 0, 1, 1]], [.5, .25, [1, 0, 2, 1]], [.5, .5, [1, 0, 2, 2]], [.995, .5, [2, 0, 2, 2]]]) {
        if (x === .995) await page.locator('[data-panel=commands-files] .window-maximize').click();
        await dragShortcut(x, y);
        await page.locator('.dock-preview').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
        const preview = await page.locator('.dock-preview.visible:not(.invalid)').boundingBox();
        await page.mouse.up(); await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
        assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => node === document.activeElement), 'dropped terminal receives focus');
        await poll(async () => (await getSettings()).workspaces[0].panels.some(p => p.kind === 'terminal'), 'dropped panel was not saved');
        const panel = (await getSettings()).workspaces[0].panels.find(p => p.kind === 'terminal');
        assert.deepEqual([panel.x, panel.y, panel.w, panel.h], expected, 'drop uses the requested grid target');
        assert.equal((await getSettings()).workspaces[0].maximized, undefined, 'drop returns to grid placement');
        await page.waitForFunction(() => !document.querySelector('.panel-settling'));
        const placed = await terminal.boundingBox();
        for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(preview[key] - placed[key]) <= 1, `drop ${x},${y} ${key}: ${preview[key]} -> ${placed[key]}`);
        assert.equal(creates, beforeCreates + ++launches, 'drop launches exactly once');
        assert.equal(run('cat', [home + '/cwd/cwd']), home + '/cwd');
        assert.equal(run('cat', [home + '/cwd/count']), Array(launches + 1).fill('first\nsecond').join('\n'));
        assert.ok(!('command' in panel), 'drag command is not persisted');
        await page.reload(); await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
        assert.equal(creates, beforeCreates + launches, 'reload does not replay a dropped command');
        await closeTerminal();
    }
    console.log('PASS shortcut drag cancellation, cell/gap/crossing/edge placement, preview, focus and once-only command execution');

    await poll(async () => !(await getSettings()).workspaces[0].panels.some(p => p.kind === 'terminal'), 'closed drop was not saved');
    // Real creation responses are delayed, retaining the production closure and focus lifecycle.
    for (const destination of ['file', 'workspace', 'closed']) {
        let release, id;
        const held = new Promise(resolve => release = resolve);
        const intercept = async route => {
            if (route.request().method() !== 'POST') return route.continue();
            const response = await route.fetch(); assert.equal(response.status(), 201); id = (await response.json()).id;
            await held; await route.fulfill({ response });
        };
        await page.route('**/api/terminals', intercept);
        if (destination === 'closed') { await dragShortcut(.625, .25); await page.mouse.up(); }
        else { await toggle.click(); await rows.locator('.command-shortcut-run').click(); }
        await poll(() => id, 'terminal creation was not intercepted');
        if (destination === 'file') await page.locator('[data-panel=commands-files] input').first().focus();
        if (destination === 'workspace') await page.locator('.workspace-tab').getByText('other', { exact: true }).click();
        let deleted;
        if (destination === 'closed') {
            deleted = page.waitForResponse(r => r.url().endsWith('/api/terminals/' + id) && r.request().method() === 'DELETE');
            await terminal.getByRole('button', { name: 'Close window', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('[data-closing]'));
        }
        const focus = await page.evaluateHandle(() => document.activeElement); release();
        if (deleted) { await deleted; await terminal.waitFor({ state: 'detached' }); assert.ok((await (await api('/terminals/' + id)).json()).exited); }
        else {
            await page.waitForTimeout(500); assert.ok(await focus.evaluate(node => node === document.activeElement || !node.isConnected && document.activeElement === document.body), 'late creation preserves changed focus');
            if (destination === 'workspace') await page.locator('.workspace-tab').getByText('commands', { exact: true }).click();
            await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' }); await closeTerminal();
        }
        await focus.dispose(); await page.unroute('**/api/terminals', intercept);
    }
    console.log('PASS late creation preserves input/workspace and explicit closure terminates pending launch');

    await add('GUI', "xterm -title 'Shortcut GUI'");
    await toggle.click(); await rows.filter({hasText:'GUI'}).locator('.component-menu').click(); await page.getByRole('menuitem', { name: 'Run', exact: true }).click();
    const canvas = terminal.locator('canvas'); await canvas.waitFor({ state: 'visible', timeout: 20000 });
    await canvas.click({ position: { x: 90, y: 80 } }); await page.keyboard.type(`printf gui > '${home}/gui-input'`); await page.keyboard.press('Enter');
    await poll(() => { try { return run('cat', [home + '/gui-input']) === 'gui'; } catch { return false; } }, 'real xterm input did not arrive over VNC');
    await page.keyboard.type('exit'); await page.keyboard.press('Enter');
    await canvas.waitFor({ state: 'hidden' });
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('printf usable > after-gui'); await page.keyboard.press('Enter');
    await poll(() => { try { return run('cat', [home + '/cwd/after-gui']) === 'usable'; } catch { return false; } }, 'shell did not accept input after GUI exit');
    assert.equal(await terminal.locator('.terminal-archive').count(), 0);
    await closeTerminal();
    console.log('PASS GUI shortcut accepts real xterm input and returns to a usable shell after GUI exit');

    await page.setViewportSize({ width: 320, height: 700 }); await page.waitForTimeout(350); await toggle.tap();
    const compactColors = await page.locator('.component-controls .add-panel').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
    assert.equal(compactColors.length, 2); assert.equal(new Set(compactColors).size, 1, 'compact controls share the accent color');
    const box = await toggle.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 320);
    await rows.filter({hasText:'Multiline'}).locator('.component-menu').tap(); await page.getByRole('menuitem', { name: 'Edit', exact: true }).tap();
    await dialog.locator('textarea').fill(command + '\n');
    await page.setViewportSize({ width: 320, height: 350 });
    await dialog.getByRole('button', { name: 'Save', exact: true }).tap(); await saved();
    await page.setViewportSize({ width: 320, height: 700 }); await page.waitForTimeout(350); await toggle.tap(); await rows.filter({hasText:'Multiline'}).locator('.command-shortcut-run').tap();
    await terminal.locator('[data-state=connected]').waitFor({ state: 'attached' });
    assert.ok(await terminal.isVisible()); assert.ok(await terminal.locator('.xterm-helper-textarea').evaluate(node => node === document.activeElement));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await closeTerminal();
    await toggle.tap(); await rows.filter({hasText:'GUI'}).locator('.component-menu').tap(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).tap();
    await poll(async () => (await getSettings()).commandShortcuts.length === 1, 'delete was not saved');
    await page.reload(); await toggle.tap(); assert.equal(await rows.count(), 1); await page.keyboard.press('Escape');
    console.log('PASS 320px touch menu, editing with reduced keyboard-height viewport, launch focus and delete persistence');

    async function addPath(name, path) {
        await toggle.tap(); await menu.getByRole('menuitem', { name: 'Add favorite' }).tap();
        await dialog.locator('[name=name]').fill(name); await dialog.locator('select').selectOption('path');
        await dialog.locator('[name=path]').fill(path);
        await dialog.getByRole('button', { name: 'Save', exact: true }).tap(); await saved();
    }
    await addPath('Z folder', '~/cwd');
    await addPath('A file', home + '/cwd/count');
    await toggle.tap();
    assert.deepEqual(await rows.locator('.command-shortcut-run').allTextContents(), ['A file', 'Multiline', 'Z folder']);
    await rows.last().locator('.command-shortcut-run').tap();
    await page.waitForFunction(path => [...document.querySelectorAll('.path-input')].some(n => n.value === path), home + '/cwd');
    await toggle.tap(); await rows.first().locator('.command-shortcut-run').tap();
    await page.locator('.cm-content').getByText('first', {exact:true}).first().waitFor();
    assert.equal((await getSettings()).commandShortcuts.find(f => f.name === 'A file').path, home + '/cwd/count');
    assert.equal((await getSettings()).commandShortcuts.find(f => f.name === 'Z folder').path, '~/cwd', 'home-relative paths stay portable');
    console.log('PASS sorted command and path favorites, home-relative paths, directory navigation and editor opening');
    const otherContext = await browser.newContext(); const otherMe = await login(otherContext, other);
    assert.equal(otherMe.settings.commandShortcuts, undefined, 'commands are private to the Linux user'); await otherContext.close();
    await page.waitForTimeout(400); await page.goto('about:blank');
    const settings = await getSettings();
    assert.equal((await api('/settings', 'PUT', { ...settings, commandShortcuts: [{ name: 'bad', command: '  ' }] })).status(), 400);
    assert.equal((await getSettings()).commandShortcuts.length, 3, 'invalid save preserves stored settings');
    assert.equal((await context.request.put(base + '/api/settings', { data: settings })).status(), 403, 'CSRF required');
    settings.commandShortcuts = Array.from({ length: 50 }, (_, i) => ({ name: `Command ${i} <>& אבג`, command: 'pwd' }));
    const workspace = settings.workspaces[0]; workspace.panels = Array.from({ length: 32 }, (_, i) => ({ id: 'full-' + i, kind: 'files', path: home, x: i % 2, y: Math.floor(i % 8 / 2), w: 1, h: 1, minimized: i >= 8 })); workspace.columns = 2; workspace.rows = 4; workspace.active = 'full-0';
    assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
    await page.goto(base); await toggle.tap();
    assert.ok(await page.locator('.start-favorite-rows').evaluate(node => node.scrollHeight > node.clientHeight));
    assert.ok(await rows.locator('.command-shortcut-run').evaluateAll(nodes => nodes.every(node => node.disabled)));
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 }); await page.locator('#app:not(.compact)').waitFor(); await toggle.click();
    assert.ok(await menu.evaluate(node => node.offsetHeight <= innerHeight * .8 + 2));
    assert.ok(await page.locator('.start-favorite-rows').evaluate(node => node.scrollHeight > node.clientHeight));
    await page.screenshot({ path: 'test-results/command-shortcuts/desktop-overflow.png' });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 320, height: 700 }); await page.locator('#app.compact').waitFor();
    await mkdir('test-results/command-shortcuts', { recursive: true }); await toggle.tap();
    await page.screenshot({ path: 'test-results/command-shortcuts/mobile.png' }); await page.keyboard.press('Escape');
    await page.goto('about:blank'); const rtl = await login(context, user, 'ar');
    await page.goto(base); await toggle.tap(); await menu.getByRole('menuitem', { name: rtl.i18n.texts['commandShortcuts.add'], exact: true }).tap();
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl'); assert.equal(await dialog.locator('textarea').getAttribute('dir'), 'ltr');
    assert.ok(await dialog.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
    await page.screenshot({ path: 'test-results/command-shortcuts/rtl.png' });
    await dialog.locator('.actions button').first().tap();
    assert.deepEqual(errors, []);
    console.log('PASS account isolation, boundary validation/CSRF, scrollable rows, capacity and RTL chrome/LTR commands');
} finally {
    // The account is dedicated; clean only its sessions/processes and files.
    if (api) { try { for (const terminal of await (await api('/terminals')).json()) await api('/terminals/' + terminal.id, 'DELETE'); } catch {} }
    await browser?.close();
    if (server) { server.kill('SIGTERM'); await stopped; }
    for (const [name, uid] of accounts) {
        try { run('pkill', ['-KILL', '-u', uid]); } catch {}
        run('userdel', [name]);
    }
    run('rm', ['-rf', home, otherHome]); if (state) await rm(state, { recursive: true, force: true });
}
