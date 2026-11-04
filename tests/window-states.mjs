import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
const home = await mkdtemp('/tmp/tuxee-windows-user-'), state = await mkdtemp('/tmp/tuxee-windows-server-');
const user = `tuxee-windows-${process.pid}`, password = randomBytes(24).toString('base64url');
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const [, , uid, gid] = run('getent', ['passwd', user]).split(':');
await chown(home, +uid, +gid); run('chpasswd', [], `${user}:${password}\n`);
await writeFile(home + '/draft.txt', 'original\n'); await chown(home + '/draft.txt', +uid, +gid);
await chmod(state, 0o755); await copyFile('./bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, hasTouch: true });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf } = await (await context.request.get(base + '/api/me')).json();
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const response = await api('/terminals', 'POST', { directory: home, name: 'Window shell', columns: 80, rows: 24 });
    assert.equal(response.status(), 201); const terminal = await response.json();
    const page = await appPage(context), errors = [], sockets = [];
    let terminalResizes = 0, guiResizes = 0;
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
        if (socket.url().includes('/display/ws')) socket.on('framesent', ({ payload }) => { if (typeof payload !== 'string' && payload[0] === 251) guiResizes++; });
        if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
        sockets.push(socket);
        socket.on('framesent', ({ payload }) => { if (typeof payload === 'string' && JSON.parse(payload).type === 'resize') terminalResizes++; });
    });
    const item = id => page.locator(`[data-panel="${id}"]`), title = id => page.locator(`[data-component-name="${id}"]`);
    const menu = page.locator('.menu-actions.popover-menu');
    const panel = (id, x, y, w, h, extra = {}) => ({ id, kind: 'files', path: home, x, y, w, h, ...extra });
    const shell = (minimized = false) => panel('shell', 2, 0, 2, 2, { kind: 'terminal', terminal: terminal.id, minimized });
    const workspace = (id, panels) => ({ id, name: id, columns: 4, rows: 2, active: panels[0]?.id || '', panels });
    const snapshot = async () => (await (await api('/me')).json()).settings;
    async function settled() {
        await page.waitForFunction(() => !document.querySelector('.board') || document.querySelector('#app').classList.contains('compact') === (innerWidth < 760 || innerHeight < 480));
        await page.waitForFunction(() => !document.querySelector('.component-flight') && !document.getAnimations().some(a => a.effect?.target?.matches?.('.grid-stack-item, .workspace-track')));
        await page.waitForTimeout(300); // Existing trailing settings debounce.
        assert.deepEqual(errors, []);
    }
    async function fixture(workspaces) {
        await settled(); await page.goto('about:blank');
        const response = await api('/settings', 'PUT', { theme: 'dark', howToSeen: true, current: workspaces[0].id, workspaces });
        assert.equal(response.status(), 200, await response.text());
        await page.goto(base); await item(workspaces[0].panels[0].id).waitFor({ state: 'attached' });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-panel]')].every(n => n.querySelector('.terminal-view') ? n.querySelector('.terminal-view').dataset.state === 'connected' : n.querySelector('.file-entry')));
        await settled();
    }
    const geometry = ws => ws.panels.map(({ id, x, y, w, h, minimized }) => ({ id, x, y, w, h, minimized: !!minimized }));
    const current = async () => { const s = await snapshot(); return s.workspaces.find(w => w.id === s.current); };
    async function assertGrid(ws) {
        const expected = ws.panels.filter(p => !p.minimized).map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
        const actual = await page.evaluate(panels => panels.map(({ id }) => {
            const node = document.querySelector(`[data-panel="${id}"]`);
            if (!node.checkVisibility()) throw Error('visible window hidden: ' + id);
            return { id, ...Object.fromEntries(['x','y','w','h'].map(k => [k, Number(node.getAttribute('gs-' + k) || (k === 'w' || k === 'h' ? 1 : 0))])) };
        }), expected);
        assert.deepEqual(actual, expected, 'rendered grid cells match saved geometry');
    }
    async function minimize(id) { await item(id).locator('.window-minimize').click(); await settled(); }
    async function restore(id) { await title(id).click(); await settled(); }
    async function maximize(id) { await item(id).locator('.window-maximize').click(); await settled(); }
    async function select(id) { await page.locator(`.workspace-tab-item[data-workspace="${id}"] .workspace-tab`).click(); await settled(); }
    async function drag(id, destination, cancel = false) {
        const from = await title(id).boundingBox(), to = await destination.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
        if (cancel) await page.keyboard.press('Escape');
        await page.mouse.up(); await settled();
    }
    async function dropAt(source, x, y, cancel = false) {
        const from = await source.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 20, { steps: 2 });
        const grid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
        await page.mouse.move(grid.x + grid.width * x, grid.y + grid.height * y, { steps: 10 });
        await page.locator('.dock-preview.visible:not(.invalid)').waitFor();
        if (cancel) await page.keyboard.press('Escape');
        await page.mouse.up(); await settled();
    }
    const sketch = (ws, incoming) => Array.from({ length: 2 }, (_, y) => Array.from({ length: 4 }, (_, x) => {
        const p = ws.panels.find(p => !p.minimized && x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
        return p?.id === incoming ? 'D' : p?.id === 'shell' ? 'C' : p?.id || ' ';
    }).join('')).join('\n');
    for (const [name, x, y, expected, hidden] of [
        ['left', .005, .5, 'DDCC\nDDCC', ['A', 'B']],
        ['bottom-left', .25, .75, 'ABCC\nDDCC', []],
        ['top-left', .25, .25, 'DDCC\nABCC', []],
    ]) {
        await fixture([workspace('origin', [panel('A', 0, 0, 1, 2), panel('B', 1, 0, 1, 1), shell()])]);
        const before = await current(), original = await item('shell').locator('.xterm').elementHandle();
        await dropAt(page.locator('.add-panel[data-kind=files]'), x, y, true);
        assert.deepEqual(await current(), before, 'cancelled replacement preserves all windows');
        await dropAt(page.locator('.add-panel[data-kind=files]'), x, y);
        const result = await current(), added = result.panels.find(p => !before.panels.some(old => old.id === p.id));
        assert.equal(sketch(result, added.id), expected);
        assert.deepEqual(result.panels.filter(p => p.minimized).map(p => p.id).sort(), hidden);
        assert.deepEqual(result.panels.find(p => p.id === 'shell'), before.panels[2]);
        assert.ok(await original.evaluate(node => node === document.querySelector('[data-panel=shell] .xterm')));
        assert.equal((await (await api('/terminals/' + terminal.id)).json()).pid, terminal.pid);
        await assertGrid(result);
        await mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/drop-replacement-${name}.png` });
        await page.reload(); await item('shell').locator('[data-state=connected]').waitFor();
        assert.equal(sketch(await current(), added.id), expected, 'replacement survives reload');
    }
    await fixture([workspace('origin', [panel('A', 0, 0, 1, 1), panel('B', 1, 0, 1, 1), panel('C', 0, 1, 2, 1), shell()])]);
    await dropAt(item('shell').locator('.terminal-tab'), .005, .5);
    assert.equal(sketch(await current(), 'shell'), 'DDAB\nDDCC', 'covered group retains its arrangement in the vacated half');
    await assertGrid(await current());
    assert.equal((await (await api('/terminals/' + terminal.id)).json()).pid, terminal.pid);
    console.log('PASS replacement drops, partial trims, free-cell relocation, group swaps, cancellation, persistence and unaffected terminal identity');

    await fixture([workspace('origin', [panel('files', 0, 0, 2, 1), panel('other', 0, 1, 2, 1), shell()]), workspace('destination', [])]);
    await item('shell').locator('[data-state=connected]').waitFor();
    const original = geometry(await current()), shellDOM = await item('shell').locator('.xterm').elementHandle();
    const pid = (await (await api('/terminals/' + terminal.id)).json()).pid, socketCount = sockets.length;
    await minimize('shell');
    assert.equal(await page.locator('.window-bar').isVisible(), true);
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/window-bar.png' });
    assert.deepEqual(geometry(await current()).slice(0, 2), original.slice(0, 2));
    assert.equal(await item('shell').isVisible(), false);
    await restore('shell');
    assert.deepEqual(geometry(await current()), original); await assertGrid(await current());
    assert.equal(await page.locator('.window-bar').isVisible(), false, 'secondary bar hides after the last minimized window is restored');
    assert.equal(await page.locator('.window-bar .component-tab').count(), 0);
    assert.ok(await shellDOM.evaluate(node => node === document.querySelector('[data-panel=shell] .xterm')));
    assert.equal((await (await api('/terminals/' + terminal.id)).json()).pid, pid);
    assert.equal(sockets.length, socketCount, 'minimize/restore keeps the terminal socket');
    await page.keyboard.type("printf 'window-state-input\\n'"); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-panel=shell] .xterm-rows').textContent.includes('window-state-input'));
    console.log('PASS minimize/restore keeps geometry, DOM, socket, PID and ordinary keyboard focus');

    await item('files').locator('.file-entry').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = item('files').locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('unsaved window draft');
    const editorDOM = await editor.elementHandle();
    await minimize('files');
    await page.locator('[data-component-menu=files]').click();
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Restore', 'Move to desktop', 'Close']);
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await restore('files'); assert.ok((await editor.textContent()).includes('unsaved window draft'));
    assert.ok(await editorDOM.evaluate(node => node === document.querySelector('[data-panel=files] .cm-content')));
    await minimize('other');
    const preMax = geometry(await current());
    await maximize('shell');
    assert.equal(await page.locator('.board > .grid-stack > [data-panel]:visible').count(), 1);
    assert.deepEqual(await item('shell').evaluate(n => ['x','y','w','h'].map(k => Number(n.getAttribute('gs-' + k) || (k === 'w' || k === 'h' ? 1 : 0)))), [0,0,4,2]);
    assert.equal(await item('shell').locator('.window-minimize').isVisible(), false);
    await restore('other'); assert.equal((await current()).maximized, 'other');
    assert.equal((await current()).panels.find(p => p.id === 'other').minimized, true);
    await restore('files'); assert.ok((await editor.textContent()).includes('unsaved window draft'));
    await maximize('files'); assert.deepEqual(geometry(await current()), preMax, 'switch/exit leaves every saved cell and hidden flag exact'); await assertGrid(await current());
    await maximize('shell'); await select('destination'); await select('origin');
    assert.equal((await current()).maximized, 'shell');
    await page.reload(); await settled(); assert.equal((await current()).maximized, 'shell');
    assert.deepEqual(geometry(await current()), preMax);
    await page.setViewportSize({ width: 390, height: 844 }); await settled();
    if (!await title('other').isVisible()) await page.locator('.component-tabs .overflow-toggle').tap();
    await title('other').tap(); assert.equal(await item('other').isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 950 }); await settled();
    assert.equal((await current()).maximized, 'shell'); assert.deepEqual(geometry(await current()), preMax);
    await page.locator('.layout-cycle').click(); await settled();
    assert.equal((await current()).maximized, undefined);
    assert.equal((await current()).panels.find(p => p.id === 'other').minimized, true);
    console.log('PASS editor draft/discard cancellation, maximize switching, reload/cache persistence and Auto Layout exit');

    const beforeCompact = geometry(await current());
    await page.setViewportSize({ width: 390, height: 844 }); await settled();
    assert.equal(await page.locator('.window-bar').count(), 0);
    assert.equal(await page.locator('.window-minimize:visible, .window-maximize:visible').count(), 0);
    if (!await title('other').isVisible()) await page.locator('.component-tabs .overflow-toggle').tap();
    await title('other').tap(); assert.equal(await item('other').isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 950 }); await settled();
    assert.deepEqual(geometry(await current()), beforeCompact);
    assert.equal(await item('other').isVisible(), false);
    await minimize('shell');
    await title('shell').click({ button: 'right' });
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Restore', 'Move to desktop', 'Rename', 'Close']);
    await page.keyboard.press('Escape'); assert.ok(await title('shell').evaluate(n => n === document.activeElement));
    await restore('shell');
    for (let i = 0; i < 4; i++) {
        await item('shell').locator('.window-minimize').evaluate(n => n.click());
        await title('shell').evaluate(n => n.click());
    }
    await settled(); assert.equal(await page.locator('.component-flight').count(), 0);
    await item('shell').locator('.window-minimize').evaluate(n => n.click());
    await page.setViewportSize({ width: 1450, height: 950 }); await settled();
    assert.equal(await page.locator('.component-flight').count(), 0); await restore('shell');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await minimize('shell');
    assert.equal(await page.locator('.component-flight').count(), 0); await restore('shell');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    console.log('PASS compact access/orientation, shared keyboard menus, rapid cancellation, resize and reduced motion');

    const gridPanels = () => Array.from({ length: 8 }, (_, i) => panel(`p${i}`, i % 4, Math.floor(i / 4), 1, 1));
    await fixture([workspace('origin', [panel('a', 0, 0, 1, 2), panel('b', 1, 0, 1, 2), shell(true)]), workspace('destination', gridPanels())]);
    let before = geometry(await current());
    await drag('shell', item('b'));
    let after = geometry(await current());
    assert.deepEqual(after[0], before[0]); assert.equal(after[1].minimized, false);
    assert.deepEqual(after[2], { id: 'shell', x: 1, y: 0, w: 1, h: 2, minimized: false });
    await assertGrid(await current());
    await minimize('shell');
    before = (await snapshot()).workspaces.map(geometry);
    const dest = page.locator('[data-workspace=destination] .workspace-tab');
    await drag('shell', dest, true);
    assert.deepEqual((await snapshot()).workspaces.map(geometry), before, 'cancelled cross-desktop drop changes neither desktop');
    const movingDOM = await item('shell').elementHandle();
    await drag('shell', dest);
    const moved = await snapshot(), destination = moved.workspaces[1];
    assert.equal(moved.current, 'origin'); assert.equal(moved.workspaces[0].panels.some(p => p.id === 'shell'), false);
    assert.equal(destination.panels.find(p => p.id === 'p7').minimized, true);
    assert.deepEqual(geometry(destination).slice(0, 7), before[1].slice(0, 7));
    await select('destination');
    assert.ok(await movingDOM.evaluate(node => node === document.querySelector('[data-panel=shell]')));
    assert.equal((await (await api('/terminals/' + terminal.id)).json()).pid, pid);
    await minimize('shell'); await restore('p7');
    await drag('shell', item('p5'));
    assert.equal((await current()).panels.find(p => p.id === 'p5').minimized, true);
    assert.deepEqual(geometry(await current()).find(p => p.id === 'shell'), { id: 'shell', x: 1, y: 1, w: 1, h: 1, minimized: false });
    await assertGrid(await current());
    console.log('PASS grid placement, cross-desktop full replacement, unaffected geometry and cancellation');

    await fixture([workspace('origin', [shell(true), ...gridPanels()])]);
    await restore('shell'); assert.equal((await current()).panels.find(p => p.id === 'p7').minimized, true);
    await fixture([workspace('origin', [panel('a', 0, 0, 1, 1, { minimized: true }), panel('c', 2, 0, 1, 1, { minimized: true }), shell()])]);
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.mouse.move(1400, 900);
        const styles = await page.locator('.window-bar').evaluate(bar => {
            const rect = bar.getBoundingClientRect(), top = document.querySelector('.topbar').getBoundingClientRect();
            const panel = document.querySelector('[data-panel=shell] .panel').getBoundingClientRect();
            const group = bar.querySelector('.component-tab-item'), tab = group.querySelector('.component-tab');
            return { x: rect.x, width: rect.width, viewportWidth: innerWidth, height: rect.height, gap: panel.top - rect.bottom, topGap: rect.top - top.bottom,
                background: getComputedStyle(bar).backgroundColor, surface: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
                barBorder: getComputedStyle(bar).borderBottom, mainBorder: getComputedStyle(document.querySelector('.topbar')).borderBottom,
                tabBackground: getComputedStyle(tab).backgroundColor, groupBackground: getComputedStyle(group).backgroundColor,
                border: getComputedStyle(tab).borderWidth, separator: getComputedStyle(group.nextElementSibling, '::before').content };
        });
        assert.equal(styles.x, 0); assert.equal(styles.width, styles.viewportWidth); assert.equal(styles.height, 27);
        assert.equal(styles.topGap, 0); assert.ok(styles.gap >= 0 && styles.gap <= 8, 'small gap below the secondary bar');
        assert.equal(styles.background, styles.surface);
        assert.equal(styles.barBorder, styles.mainBorder, 'secondary bar has the main bar bottom rule');
        assert.equal(styles.tabBackground, 'rgba(0, 0, 0, 0)'); assert.equal(styles.groupBackground, 'rgba(0, 0, 0, 0)');
        assert.equal(styles.border, '0px'); assert.equal(styles.separator, 'none');
        await title('a').hover(); await page.waitForTimeout(150);
        assert.equal(await title('a').evaluate(tab => getComputedStyle(tab.parentElement).backgroundColor), 'rgba(0, 0, 0, 0)', 'window tabs have no hover fill');
        await page.locator('.workspace-menu').first().hover(); await page.waitForTimeout(150);
        const chevronHover = await page.locator('.workspace-menu').first().evaluate(button => getComputedStyle(button).backgroundColor);
        await page.locator('[data-component-menu=a]').hover(); await page.waitForTimeout(150);
        assert.equal(await page.locator('[data-component-menu=a]').evaluate(button => getComputedStyle(button).backgroundColor), chevronHover, 'window chevron hover matches desktop chevrons');
        await page.mouse.move(1400, 900);
        await page.screenshot({ path: `test-results/window-bar-${theme}.png` });
    }
    let head = await item('shell').locator('.panel-header').boundingBox();
    let aTab = await title('a').boundingBox(), cTab = await title('c').boundingBox();
    await page.mouse.move(head.x + 15, head.y + head.height / 2); await page.mouse.down();
    await page.mouse.move((aTab.x + aTab.width + cTab.x) / 2, aTab.y + aTab.height / 2, { steps: 12 });
    assert.equal(await page.locator('.window-drop-marker:visible').count(), 1);
    await page.mouse.up(); await settled();
    assert.deepEqual((await current()).panels.filter(p => p.minimized).map(p => p.id), ['a', 'shell', 'c'], 'drop between tabs minimizes in place');
    assert.equal((await (await api('/terminals/' + terminal.id)).json()).pid, pid);
    await fixture([workspace('origin', [shell()])]);
    await maximize('shell');
    assert.equal(await page.locator('.window-bar').isVisible(), false, 'one maximized window has no empty bar');
    await maximize('shell');
    assert.equal(await page.locator('.window-bar').isVisible(), false);
    const originalGrid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    const resizeCount = terminalResizes;
    head = await item('shell').locator('.panel-header').boundingBox();
    await page.mouse.move(head.x + 15, head.y + head.height / 2); await page.mouse.down();
    await page.mouse.move(head.x + 15, head.y - 12, { steps: 6 });
    const emptyBar = await page.locator('.window-bar').boundingBox();
    const emptyGrid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    assert.ok(emptyBar, 'dragging reveals the empty drop row');
    assert.ok(emptyBar.y + emptyBar.height <= emptyGrid.y, 'empty bar never overlaps the desktop');
    await page.mouse.move(emptyGrid.x + emptyGrid.width / 2, emptyGrid.y + 2, { steps: 4 });
    assert.equal(await page.locator('.dock-preview.visible:not(.invalid)').count(), 1, 'empty bar leaves top-edge snapping available');
    await page.waitForTimeout(150);
    const preview = await page.locator('.dock-preview.visible').boundingBox();
    assert.ok(Math.abs(preview.height - emptyGrid.height / 2) < 1, 'scaled preview covers exactly the top grid half');
    await page.screenshot({ path: 'test-results/window-bar-empty-drag.png' });
    assert.equal(terminalResizes, resizeCount, 'empty-bar dragging does not resize the terminal');
    await page.mouse.move(emptyBar.x + 20, emptyBar.y + emptyBar.height / 2, { steps: 4 });
    await page.keyboard.press('Escape'); await page.mouse.up(); await settled();
    assert.equal((await current()).panels[0].minimized, undefined, 'cancelled empty-bar drop keeps the window');
    assert.equal(await page.locator('.window-bar').isVisible(), false, 'cancelled drag hides the empty bar');
    assert.deepEqual(await page.locator('.board:not([inert]) .grid-stack').boundingBox(), originalGrid, 'cancelled drag restores the desktop bounds');
    assert.equal(terminalResizes, resizeCount, 'cancelled empty-bar dragging never resizes the terminal');
    head = await item('shell').locator('.panel-header').boundingBox();
    await page.mouse.move(head.x + 15, head.y + head.height / 2); await page.mouse.down();
    await page.mouse.move(head.x + 15, head.y - 12, { steps: 6 });
    await page.mouse.move(emptyBar.x + 20, emptyBar.y + emptyBar.height / 2, { steps: 4 });
    await page.mouse.up(); await settled();
    assert.equal((await current()).panels[0].minimized, true, 'empty bar accepts the first window');
    await fixture([workspace('origin', [panel('a', 0, 0, 1, 1, { minimized: true }), panel('b', 1, 0, 1, 1, { minimized: true }), panel('c', 2, 0, 1, 1, { minimized: true }), shell()])]);
    await drag('a', title('c'));
    assert.deepEqual((await current()).panels.filter(p => p.minimized).map(p => p.id), ['b', 'c', 'a'], 'reorder minimized tabs without restoring');
    await maximize('shell');
    await drag('b', title('c'));
    assert.deepEqual((await current()).panels.filter(p => p.minimized).map(p => p.id), ['c', 'b', 'a'], 'maximized bar tabs reorder without selecting');
    assert.equal((await current()).maximized, 'shell');
    const grid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    const from = await title('a').boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(grid.x + grid.width * .625, grid.y + grid.height * .25, { steps: 12 }); await page.mouse.up(); await settled();
    const unmaximized = await current();
    assert.equal(unmaximized.maximized, undefined, 'drag from maximized bar exits maximize');
    assert.deepEqual(geometry(unmaximized).find(p => p.id === 'a'), { id: 'a', x: 2, y: 0, w: 1, h: 1, minimized: false });
    await assertGrid(unmaximized);
    for (const source of ['bar', 'terminal', 'files']) {
        await fixture([workspace('origin', [shell(), panel('left', 0, 0, 2, 1), panel('other', 0, 1, 2, 1), panel('hidden', 0, 0, 1, 1, { minimized: true })])]);
        await maximize('shell');
        const grid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
        const trigger = source === 'bar' ? title('left') : page.locator(`.add-panel[aria-label="${source === 'terminal' ? 'Add terminal' : 'Add file browser'}"]`);
        const from = await trigger.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
        await page.mouse.move(grid.x + 2, grid.y + grid.height / 2, { steps: 12 }); await page.mouse.up(); await settled();
        const composed = await current(), visible = composed.panels.filter(p => !p.minimized);
        assert.equal(composed.maximized, undefined); assert.equal(visible.length, 2, 'maximized drops keep only the selected and incoming windows');
        assert.deepEqual(visible.map(p => [p.id === 'shell', p.x, p.y, p.w, p.h]).sort(), [[false, 0, 0, 2, 2], [true, 2, 0, 2, 2]]);
        assert.equal(composed.panels.find(p => p.id === 'other').minimized, true);
        assert.equal(composed.panels.find(p => p.id === 'hidden').minimized, true);
        await assertGrid(composed);
    }
    await fixture([workspace('origin', [shell(), panel('hidden', 0, 0, 1, 1, { minimized: true })])]);
    await maximize('shell'); await restore('hidden');
    assert.equal((await current()).maximized, 'hidden');
    const maximizedHead = await item('hidden').locator('.panel-header').boundingBox(), shellTab = await title('shell').boundingBox();
    await page.mouse.move(maximizedHead.x + 8, maximizedHead.y + maximizedHead.height / 2); await page.mouse.down();
    await page.mouse.move(shellTab.x + shellTab.width / 2, shellTab.y + shellTab.height / 2, { steps: 12 });
    await page.mouse.up(); await settled();
    assert.equal((await current()).maximized, undefined);
    assert.equal((await current()).panels.find(p => p.id === 'hidden').minimized, true, 'dragging a formerly minimized maximized window back to the bar exits maximize');
    await fixture([workspace('origin', [panel('files', 0, 0, 2, 2), shell()])]);
    await maximize('files');
    const maxGrid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    const maxGrip = await item('files').locator('.panel-resize-sw').boundingBox();
    await page.mouse.move(maxGrip.x + 4, maxGrip.y + maxGrip.height - 4); await page.mouse.down();
    await page.mouse.move(maxGrip.x + 4 + maxGrid.width / 2, maxGrip.y + maxGrip.height - 4, { steps: 8 });
    await page.mouse.up(); await settled();
    const resizedMax = await current();
    assert.equal(resizedMax.maximized, undefined, 'resizing a maximized window returns it to the grid');
    assert.deepEqual(geometry(resizedMax).find(p => p.id === 'files'), { id: 'files', x: 2, y: 0, w: 2, h: 2, minimized: false });
    await assertGrid(resizedMax);
    await fixture([workspace('origin', [panel('files', 0, 0, 2, 2), shell(), panel('hidden', 0, 0, 1, 1, { minimized: true })]), workspace('away', [])]);
    await maximize('files');
    await page.locator('[data-component-menu=shell]').click();
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Restore', 'Move to desktop', 'Rename', 'Close']);
    await page.keyboard.press('Escape');
    await drag('shell', title('hidden'));
    assert.deepEqual((await current()).panels.map(p => p.id), ['files', 'hidden', 'shell']);
    assert.equal((await current()).maximized, 'files');
    await fixture([workspace('origin', [panel('left', 0, 0, 1, 1), panel('files', 1, 0, 1, 1), { ...shell(), x: 2, y: 0, w: 1, h: 1 }])]);
    await minimize('files');
    assert.deepEqual(geometry(await current()).find(p => p.id === 'shell'), { id: 'shell', x: 1, y: 0, w: 2, h: 1, minimized: false }, 'minimizing expands the equal-sized terminal first');
    await fixture([workspace('origin', gridPanels())]);
    const gridBounds = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    const grip = await item('p0').locator('.panel-resize-se').boundingBox();
    await page.mouse.move(grip.x + grip.width - 4, grip.y + grip.height - 4); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width - 4 + gridBounds.width / 4, grip.y + grip.height - 4 + gridBounds.height / 2, { steps: 8 });
    assert.equal(await page.locator('.dock-preview.visible.invalid').count(), 0);
    await page.mouse.up(); await settled();
    const resized = await current();
    assert.deepEqual(geometry(resized).find(p => p.id === 'p0'), { id: 'p0', x: 0, y: 0, w: 2, h: 2, minimized: false });
    assert.equal(resized.panels.filter(p => p.minimized).length, 3);
    await assertGrid(resized);
    for (const source of ['new', 'minimized', 'existing']) {
        const panels = gridPanels();
        if (source === 'minimized') panels.push(panel('hidden', 0, 0, 1, 1, { minimized: true }));
        await fixture([workspace('origin', panels)]);
        const grid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
        const handle = source === 'new' ? page.locator('.add-panel[aria-label="Add file browser"]') : source === 'minimized' ? title('hidden') : item('p0').locator('.panel-header');
        const start = await handle.boundingBox();
        await page.mouse.move(start.x + (source === 'existing' ? 8 : start.width / 2), start.y + start.height / 2); await page.mouse.down();
        await page.mouse.move(grid.x + grid.width - 3, grid.y + grid.height * .5, { steps: 16 });
        assert.equal(await page.locator('.dock-preview.visible.invalid').count(), 0, `${source} drop is valid`);
        await page.mouse.up(); await settled();
        const result = await current(), placed = source === 'new' ? result.panels.find(p => !panels.some(old => old.id === p.id)) : result.panels.find(p => p.id === (source === 'minimized' ? 'hidden' : 'p0'));
        assert.deepEqual([placed.x, placed.y, placed.w, placed.h, !!placed.minimized], [2, 0, 2, 2, false], `${source} uses the same half-screen target`);
        assert.equal(result.panels.filter(p => p.minimized).length, source === 'existing' ? 3 : 4);
        await assertGrid(result);
    }
    await fixture([workspace('origin', gridPanels())]);
    await page.locator('.add-panel[aria-label="Add file browser"]').click(); await settled();
    const added = await current();
    assert.equal(added.panels.length, 9); assert.equal(added.panels.find(p => p.id === 'p7').minimized, true);
    await assertGrid(added);
    await fixture([workspace('origin', gridPanels())]);
    await item('p0').locator('.panel-header').click({ button: 'right', position: { x: 8, y: 8 } });
    await menu.getByRole('menuitem', { name: 'Add file browser', exact: true }).click(); await settled();
    assert.equal((await current()).panels.find(p => p.id === 'p7').minimized, true, 'header addition also replaces the bottom-right window');
    console.log('PASS minimized tab reorder, maximized drag and full-desktop creation');

    await fixture([workspace('origin', [shell(), ...Array.from({ length: 24 }, (_, i) => panel(`hidden${i}`, 0, 0, 1, 1, { minimized: true }))]), ...Array.from({ length: 11 }, (_, i) => workspace(`Long desktop number ${i}`, []))]);
    const more = page.locator('.window-bar .overflow-toggle'); await more.click();
    await page.locator('[data-component-menu=hidden23]').click();
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).click(); await settled();
    assert.equal((await current()).panels.some(p => p.id === 'hidden23'), false);
    await more.click(); await title('hidden22').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Restore', exact: true }).click(); await settled();
    assert.equal(!!(await current()).panels.find(p => p.id === 'hidden22').minimized, false);
    await more.click();
    const overflowSource = await title('hidden21').boundingBox(), workspaceMore = await page.locator('.workspace-tabs .overflow-toggle').boundingBox();
    await page.mouse.move(overflowSource.x + overflowSource.width / 2, overflowSource.y + overflowSource.height / 2); await page.mouse.down();
    await page.mouse.move(workspaceMore.x + workspaceMore.width / 2, workspaceMore.y + workspaceMore.height / 2, { steps: 12 });
    const overflowDestination = await page.locator('[data-workspace="Long desktop number 10"] .workspace-tab').boundingBox();
    await page.mouse.move(overflowDestination.x + overflowDestination.width / 2, overflowDestination.y + overflowDestination.height / 2, { steps: 12 });
    await page.mouse.up(); await settled();
    assert.equal((await snapshot()).workspaces.at(-1).panels[0].id, 'hidden21');
    assert.equal((await current()).panels.some(p => p.id === 'hidden21'), false);
    console.log('PASS deterministic full click restore, overflow actions and drag through desktop overflow');

    await fixture([workspace('origin', [shell(), panel('closing', 0, 0, 2, 1), panel('minimizing', 0, 1, 2, 1)])]);
    await item('closing').getByRole('button', { name: 'Close panel', exact: true }).evaluate(n => n.click());
    await page.waitForFunction(() => document.querySelector('[data-panel=closing]')?.dataset.closing);
    await item('minimizing').locator('.window-minimize').evaluate(n => n.click()); await settled();
    assert.equal(await item('closing').count(), 0, 'minimize geometry animation cannot cancel an accepted close');

    await fixture([workspace('origin', [shell(), panel('files', 0, 0, 2, 2)]), workspace('away', [])]);
    const preCreation = geometry(await current());
    await maximize('shell');
    await page.locator('.add-panel[aria-label="Add file browser"]').click(); await settled();
    const created = (await current()).panels.find(p => !['shell', 'files'].includes(p.id));
    assert.equal((await current()).maximized, created.id);
    const afterCreation = geometry(await current());
    assert.deepEqual(afterCreation.find(p => p.id === 'shell'), preCreation.find(p => p.id === 'shell'));
    await item(created.id).getByRole('button', { name: 'Close panel', exact: true }).click();
    await select('away');
    assert.equal((await snapshot()).workspaces[0].maximized, 'shell', 'closing selection reconciles saved state while its desktop is inactive');
    await select('origin');
    assert.equal((await current()).maximized, 'shell');
    assert.deepEqual(geometry(await current()), afterCreation.filter(p => p.id !== created.id), 'close while maximized does not expand neighbors');
    await restore('files');
    await item('files').locator('.panel-header').click({ button: 'right', position: { x: 20, y: 10 } });
    await menu.getByRole('menuitem', { name: 'Move to desktop', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'away', exact: true }).click();
    await select('away');
    assert.equal((await snapshot()).workspaces[0].maximized, 'shell', 'moving selection reconciles its source without waiting for remount');
    await select('origin'); await maximize('shell');
    let release, createdTerminal;
    const held = new Promise(resolve => release = resolve), pending = new Promise(resolve => createdTerminal = resolve);
    const intercept = async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 201);
        createdTerminal((await response.json()).id); await held; await route.fulfill({ response });
    };
    await page.route('**/api/terminals', intercept);
    await page.locator('.add-panel[aria-label="Add terminal"]').click(); const pendingID = await pending;
    const pendingPanel = page.locator('[data-panel]').filter({ has: page.locator('.terminal-view:not([data-terminal])') });
    const pendingPanelID = await pendingPanel.getAttribute('data-panel');
    await minimize(pendingPanelID);
    const focused = await page.evaluateHandle(() => document.activeElement);
    release();
    await item(pendingPanelID).locator('[data-state=connected]').waitFor({ state: 'attached' });
    await page.unroute('**/api/terminals', intercept);
    assert.ok(await focused.evaluate(node => node === document.activeElement), 'late hidden creation preserves focus');
    await page.locator(`[data-component-menu="${pendingPanelID}"]`).click();
    const pendingDelete = page.waitForResponse(r => r.url().endsWith('/api/terminals/' + pendingID) && r.request().method() === 'DELETE');
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).click(); await pendingDelete; await settled();
    assert.equal((await api('/terminals/' + pendingID)).status(), 404);
    console.log('PASS maximized creation/closure and hidden pending creation focus/lifecycle');

    await fixture([workspace('origin', [shell(), panel('files', 0, 0, 2, 2)])]);
    await item('shell').locator('[data-state=connected]').waitFor();
    await item('shell').locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('xterm -title Window-state-GUI &'); await page.keyboard.press('Enter');
    await item('shell').locator('.display-title').filter({ hasText: 'Window-state-GUI' }).waitFor({ timeout: 30000 });
    const gui = await item('shell').locator('.display-screen canvas').elementHandle();
    await minimize('shell'); await restore('shell'); await maximize('shell'); await maximize('shell');
    assert.ok(await gui.evaluate(node => node === document.querySelector('[data-panel=shell] .display-screen canvas')), 'GUI canvas survives state changes');
    await page.waitForTimeout(500);
    const guiBefore = await item('shell').locator('.display-screen canvas').boundingBox(), guiResizeCount = guiResizes;
    const headerBefore = await item('shell').locator('.panel-header').boundingBox();
    const resizeGrid = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
    const corner = await item('shell').locator('.panel-resize-se').boundingBox();
    await page.mouse.move(corner.x + corner.width - 2, corner.y + corner.height - 2); await page.mouse.down();
    await page.mouse.move(corner.x + corner.width - 2 - resizeGrid.width * .15, corner.y + corner.height - 2 - resizeGrid.height * .3, { steps: 8 });
    await page.waitForTimeout(150);
    assert.equal((await item('shell').locator('.panel-header').boundingBox()).height, headerBefore.height, 'GUI resize keeps the header unscaled');
    const guiDuring = await item('shell').locator('.display-screen canvas').boundingBox();
    assert.deepEqual([guiDuring.width, guiDuring.height], [guiBefore.width, guiBefore.height], 'GUI pixels stay fixed and are cropped inside the frame');
    assert.equal(guiResizes, guiResizeCount, 'GUI drag preview sends no remote resize');
    await page.screenshot({ path: 'test-results/window-resize-gui.png' });
    await page.mouse.up(); await page.waitForTimeout(50);
    assert.equal((await item('shell').locator('.panel-header').boundingBox()).height, headerBefore.height, 'snap animation also keeps the header unscaled');
    assert.equal(guiResizes, guiResizeCount, 'GUI resize waits for snap completion');
    await settled();
    await page.waitForFunction(() => !document.querySelector('.resizing-content'));
    await page.waitForFunction(({ width, height }) => {
        const canvas = document.querySelector('[data-panel=shell] .display-screen canvas');
        return canvas && (canvas.getBoundingClientRect().width !== width || canvas.getBoundingClientRect().height !== height);
    }, guiBefore);
    assert.equal(guiResizes, guiResizeCount + 1, 'GUI receives one final size');
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/window-states-gui.png' });
    await minimize('shell'); await page.locator('[data-component-menu=shell]').click();
    const deleted = page.waitForResponse(r => r.url().endsWith('/api/terminals/' + terminal.id) && r.request().method() === 'DELETE');
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).click(); assert.equal((await deleted).status(), 200); await settled();
    assert.equal(await item('shell').count(), 0);
    const info = await api('/terminals/' + terminal.id);
    assert.ok(info.status() === 404 || (await info.json()).exited);
    assert.deepEqual(errors, []);
    console.log('PASS real GUI survival and explicit hidden terminal closure through the original owner');
} finally {
    if (api) for (const terminal of await (await api('/terminals')).json()) await api('/terminals/' + terminal.id, 'DELETE');
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    spawnSync('pkill', ['-KILL', '-u', uid]); run('userdel', [user]);
    await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
