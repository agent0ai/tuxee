import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, chown, copyFile, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
await import('./novnc.mjs');

const user = 'tuxee-poc-desktop';
let account = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
if (account.status !== 0) {
    assert.equal(spawnSync('useradd', ['-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]).status, 0);
    account = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
}
const fields = account.stdout.trim().split(':'), uid = Number(fields[2]), gid = Number(fields[3]);
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const state = await mkdtemp('/tmp/tuxee-desktop-test-');
const fixture = await mkdtemp('/tmp/tuxee-desktop-input-');
await chown(fixture, uid, gid);
await mkdir('test-results', { recursive: true });
await copyFile('./bin/tuxee', `${state}/tuxee`);
const service = spawn(`${state}/tuxee`, ['serve', '--bind', '127.0.0.1:0', '--acme', 'off', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => service.once('exit', resolve));
let logs = '';
service.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
    service.stdout.on('data', data => {
        const match = String(data).match(/listening at (https?:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    service.once('exit', () => { clearTimeout(timer); reject(Error('server stopped')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
const page = await context.newPage(), errors = [], external = [], sockets = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) external.push(request.url()); });
page.on('websocket', socket => { if (/\/api\/terminals\/[^/]+\/display\/ws$/.test(socket.url())) { const value = { closed: false }; sockets.push(value); socket.on('close', () => value.closed = true); } });
let csrf, original;
const appPIDs = [], runtimes = [];
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf || '', 'X-Tuxee-Client': 'web' } });
async function poll(check, message) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw Error(message);
}
const alive = async pid => {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    return !!value && !/\) Z /.test(value);
};
async function shell(view, command) {
    const panel = view.locator('..');
    if (await view.locator('.terminal-display').isVisible()) await panel.locator('.terminal-tab').click();
    await view.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(command, { delay: 1 }); await page.keyboard.press('Enter');
}
async function launch(view, command) {
    await shell(view, command + ' &');
    await view.locator('.terminal-display[data-state=connected]').waitFor({ timeout: 15000 });
}
async function memory() {
    const all = [];
    for (const id of await readdir('/proc')) {
        if (!/^\d+$/.test(id)) continue;
        try {
            const raw = await readFile(`/proc/${id}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
            all.push({ pid: Number(id), ppid: Number(fields[1]), name: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')), ticks: Number(fields[11]) + Number(fields[12]) });
        } catch {}
    }
    const owned = new Set([service.pid]);
    for (let i = 0; i < 10; i++) for (const p of all) if (owned.has(p.ppid)) owned.add(p.pid);
    const result = [];
    for (const p of all.filter(p => owned.has(p.pid))) {
        let unavailable;
        const info = await readFile(`/proc/${p.pid}/smaps_rollup`, 'utf8').catch(error => { unavailable = error.code; return ''; });
        const status = await readFile(`/proc/${p.pid}/status`, 'utf8').catch(() => '');
        result.push({ ...p, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0), pssKiB: info ? Number(info.match(/^Pss:\s+(\d+)/m)?.[1]) : null, unavailable });
    }
    return result;
}
async function point(view, x, y) {
    const canvas = view.locator('canvas'), box = await canvas.boundingBox();
    const size = await canvas.evaluate(node => ({ width: node.width, height: node.height }));
    return { x: box.x + x * box.width / size.width, y: box.y + y * box.height / size.height };
}
async function clickControl(view, name) {
    const layout = JSON.parse(await readFile(`${fixture}/input.json.layout`, 'utf8'));
    const location = await point(view, layout[name].x, layout[name].y);
    await page.mouse.click(location.x, location.y);
}
function runX(env, command, args) {
    const result = spawnSync(command, args, { uid, gid, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
async function dragWindow(from, to, cancel = false, vertical = false) {
    const start = await from.boundingBox(), end = await to.boundingBox();
    const grab = await from.locator('img').count() ? await from.locator('img').boundingBox() : start;
    await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await page.mouse.down();
    await page.mouse.move(vertical ? start.x + start.width / 2 : end.x + (end.x > start.x ? end.width - 1 : 1),
        vertical ? end.y + (end.y > start.y ? end.height - 1 : 1) : start.y + start.height / 2, { steps: 12 });
    assert.ok(await from.locator('..').evaluate(node => node.classList.contains('tab-dragging')));
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(250);
}
const sessionPanels = async () => (await (await api('/me')).json()).settings.workspaces.filter(ws => ws.id === 'gui-proof').flatMap(ws => ws.panels).filter(panel => panel.kind === 'terminal');
const measurements = {};
try {
    assert.equal((await api('/terminals/unknown/display')).status(), 401);
    await page.goto(base);
    await page.locator('[name=username]').fill(user);
    await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Add terminal', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add GUI application', exact: true }).count(), 0);
    const me = await (await api('/me')).json(); csrf = me.csrf; original = me.settings;
    await page.waitForTimeout(400); await page.goto('about:blank');
    const terminal = await (await api('/terminals', 'POST', { directory: fields[5], name: 'Terminal', columns: 80, rows: 24 })).json();
    assert.equal((await api('/settings', 'PUT', {
        theme: 'dark', current: 'gui-proof', workspaces: [{ id: 'gui-proof', name: 'GUI proof', columns: 4, rows: 2, active: 'shell', panels: [
            { id: 'files', kind: 'files', path: fields[5], x: 0, y: 0, w: 1, h: 2 },
            { id: 'shell', kind: 'terminal', terminal: terminal.id, path: fields[5], x: 1, y: 0, w: 3, h: 2 },
        ] }],
    })).status(), 200);
    await page.goto(base);
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    const firstPanel = page.locator('[data-panel="shell"]'), first = firstPanel.locator('.terminal-view');
    const terminalDOM = await first.locator('.xterm').elementHandle();
    await shell(first, `printf '%s\\n' "$DISPLAY" > ${fixture}/display.txt`);
    await poll(async () => !!await stat(`${fixture}/display.txt`).catch(() => false), 'ordinary terminal input failed');
    assert.equal((await api(`/terminals/${terminal.id}/display`)).status(), 409);
    measurements.coldTerminal = await memory();
    assert.ok(!measurements.coldTerminal.some(p => p.name.includes('Xvnc')));
    await launch(first, `python3 ${process.cwd()}/tests/gui-fixture.py ${fixture}/input.json`);
    await poll(async () => !!await stat(`${fixture}/input.json.layout`).catch(() => false), 'GTK fixture did not start');
    await page.waitForTimeout(700);
    await clickControl(first, 'entry');
    await page.keyboard.type('GUI_INPUT_OK'); await page.keyboard.press('Enter');
    await poll(async () => (await readFile(`${fixture}/input.json`, 'utf8').catch(() => '')).includes('GUI_INPUT_OK'), 'keyboard did not reach GTK');
    const input = JSON.parse(await readFile(`${fixture}/input.json`, 'utf8'));
    assert.equal(input.uid, uid); assert.equal((await stat(`${fixture}/input.json`)).uid, uid);
    appPIDs.push(input.pid); runtimes.push(input.auth.replace('/Xauthority', ''));
    const env = { PATH: '/usr/bin:/bin', HOME: fields[5], DISPLAY: input.display, XAUTHORITY: input.auth };
    assert.notEqual(spawnSync('xdpyinfo', [], { uid: 65534, gid: 65534, env: { ...env, XAUTHORITY: '/dev/null' }, timeout: 2000 }).status, 0);
    const windowID = title => firstPanel.locator('.display-windows button').evaluateAll((buttons, title) => {
        const button = buttons.find(b => b.title === title);
        return button ? '0x' + Number(button.dataset.window).toString(16) : undefined;
    }, title);
    const dialogFits = async title => {
        const id = await windowID(title); if (!id) return false;
        const info = runX(env, 'xwininfo', ['-id', id]);
        const value = label => Number(info.match(new RegExp(label + ':\\s+(-?\\d+)'))[1]);
        const [width, height] = runX(env, 'xdpyinfo', []).match(/dimensions:\s+(\d+)x(\d+)/).slice(1).map(Number);
        const x = value('Absolute upper-left X'), y = value('Absolute upper-left Y');
        return x >= 0 && y >= 0 && x + value('Width') <= width && y + value('Height') <= height;
    };
    const mainID = await windowID('GUI application proof'); assert.ok(mainID);
    await clickControl(first, 'Open dialog');
    await poll(async () => !!await windowID('GUI test dialog'), 'modal dialog missing');
    const dialogID = await windowID('GUI test dialog');
    assert.ok(runX(env, 'xprop', ['-id', dialogID, 'WM_TRANSIENT_FOR']).includes(mainID), 'dialog lost its parent');
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/gui-dialog.png' });
    await page.keyboard.press('Enter');
    await poll(async () => !await windowID('GUI test dialog'), 'dialog did not accept keyboard input');
    await clickControl(first, 'Open file chooser');
    await poll(async () => !!await windowID('Choose a file'), 'file chooser missing');
    await poll(() => dialogFits('Choose a file'), 'file chooser extends outside its component');
    await page.waitForTimeout(300); await page.screenshot({ path: 'test-results/gui-file-chooser.png' });
    await page.keyboard.press('Escape');
    await poll(async () => !await windowID('Choose a file'), 'file chooser did not close');
    await clickControl(first, 'Open second window');
    await poll(async () => !!await windowID('Second application window'), 'secondary window missing');
    const secondWindowID = await windowID('Second application window');
    const active = () => runX(env, 'xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    await poll(() => active().includes(secondWindowID), 'secondary window did not receive focus');
    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click();
    assert.equal(await firstPanel.getByRole('button', { name: 'Next application window', exact: true }).count(), 0);
    await poll(() => firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).getAttribute('aria-pressed').then(value => value === 'true'), 'active window button was not highlighted');
    await poll(() => active().includes(mainID), 'window switcher did not restore the main window');
    await firstPanel.getByRole('button', { name: 'Second application window', exact: true }).click();
    await poll(() => firstPanel.getByRole('button', { name: 'Second application window', exact: true }).getAttribute('aria-pressed').then(value => value === 'true'), 'secondary window button did not become active');
    const primaryTab = firstPanel.getByRole('button', { name: 'GUI application proof', exact: true });
    const secondaryTab = firstPanel.getByRole('button', { name: 'Second application window', exact: true });
    const windowOrder = () => firstPanel.locator('.display-windows .visible-tabs [data-window]').evaluateAll(nodes => nodes.map(n => n.dataset.window));
    const originalOrder = await windowOrder(), liveCanvas = await first.locator('canvas').elementHandle();
    const panelBounds = await firstPanel.boundingBox();
    for (const direction of [-1, 1]) {
        const wide = await secondaryTab.locator('..').boundingBox(), small = await primaryTab.locator('..').boundingBox();
        assert.ok(wide.width > small.width * 3, 'fixture needs unequal tab widths');
        const handle = await secondaryTab.boundingBox(), x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
        const edge = direction < 0 ? wide.x : wide.x + wide.width;
        const crossing = small.x + small.width / 2 - edge;
        const shifted = () => primaryTab.locator('..').evaluate(node => new DOMMatrix(node.style.transform).m41);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + crossing - direction * 2, y, { steps: 4 });
        assert.equal(await shifted(), 0, 'neighbor moved before the dragged edge reached its midpoint');
        const target = x + crossing + direction * 2;
        assert.ok(direction < 0 ? target > small.x + small.width : target < small.x,
            'pointer must remain outside the neighbor for the edge regression');
        await page.mouse.move(target, y, { steps: 4 });
        assert.ok((await shifted()) * direction < 0, 'neighbor did not move when the dragged edge crossed its midpoint');
        await page.mouse.move(x, y, { steps: 4 });
        assert.equal(await shifted(), 0, 'reversing the drag did not restore the neighbor');
        await page.mouse.move(target, y, { steps: 4 });
        await page.mouse.up(); await page.waitForTimeout(250);
        assert.deepEqual(await windowOrder(), direction < 0 ? [...originalOrder].reverse() : originalOrder);
        assert.ok(active().includes(secondWindowID), 'edge reordering changed the active window');
    }
    assert.equal(await primaryTab.getAttribute('aria-pressed'), 'false');
    await primaryTab.locator('img').waitFor();
    await dragWindow(primaryTab, secondaryTab);
    assert.deepEqual(await windowOrder(), [...originalOrder].reverse());
    assert.ok(active().includes(secondWindowID), 'dragging activated another window');
    assert.deepEqual(await firstPanel.boundingBox(), panelBounds, 'window drag moved the whole terminal panel');
    assert.ok(await liveCanvas.evaluate(node => node === document.querySelector('[data-panel="shell"] canvas')));
    runX(env, 'xprop', ['-id', mainID, '-f', '_NET_WM_NAME', '8u', '-set', '_NET_WM_NAME', 'Renamed GUI window']);
    await firstPanel.getByRole('button', { name: 'Renamed GUI window', exact: true }).waitFor();
    assert.deepEqual(await windowOrder(), [...originalOrder].reverse(), 'window metadata reset the order');
    runX(env, 'xprop', ['-id', mainID, '-f', '_NET_WM_NAME', '8u', '-set', '_NET_WM_NAME', 'GUI application proof']);
    await primaryTab.press('Alt+ArrowLeft');
    assert.deepEqual(await windowOrder(), originalOrder);
    await primaryTab.press('Alt+ArrowLeft');
    assert.deepEqual(await windowOrder(), originalOrder, 'window moved before the terminal');
    assert.ok(await firstPanel.locator('.display-controls > :first-child').evaluate(node => node.classList.contains('terminal-tab')));
    assert.equal(await firstPanel.locator('.terminal-tab').getAttribute('aria-keyshortcuts'), null);
    await dragWindow(primaryTab, secondaryTab, true);
    assert.deepEqual(await windowOrder(), originalOrder, 'cancelled drag changed window order');
    assert.ok(await firstPanel.locator('.display-window-item.active').evaluate(group => {
        const bounds = group.getBoundingClientRect(), menu = group.querySelector('.display-window-menu').getBoundingClientRect();
        return getComputedStyle(group).borderTopWidth === '1px' && getComputedStyle(group).borderColor !== 'rgba(0, 0, 0, 0)' &&
            getComputedStyle(group.querySelector('.display-window')).borderTopWidth === '0px' &&
            getComputedStyle(group.querySelector('.display-window')).backgroundColor === 'rgba(0, 0, 0, 0)' &&
            menu.left > bounds.left && menu.right < bounds.right && menu.top > bounds.top && menu.bottom < bounds.bottom;
    }), 'chevron is outside the selected window outline');
    await firstPanel.locator('.display-window-item.active').getByRole('button', { name: 'Window menu', exact: true }).click();
    await page.screenshot({ path: 'test-results/gui-window-close-menu.png' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await poll(async () => !await windowID('Second application window'), 'chevron menu did not close its window');
    assert.ok(await alive(input.pid), 'closing a child window killed the application');
    await clickControl(first, 'Open second window');
    await poll(async () => !!await windowID('Second application window'), 'secondary window did not reopen');
    await poll(() => secondaryTab.getAttribute('aria-keyshortcuts').then(value => !!value), 'new window has no reorder binding');
    const reopenedOrder = await windowOrder();
    await secondaryTab.press('Alt+ArrowLeft');
    assert.deepEqual(await windowOrder(), [...reopenedOrder].reverse(), 'reopened window cannot reorder');
    await secondaryTab.press('Alt+ArrowRight');
    assert.deepEqual(await windowOrder(), reopenedOrder);
    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click();
    measurements.activeDisplay = await memory();
    await page.waitForTimeout(3000); measurements.idleDisplay = await memory();
    await writeFile('test-results/gui-memory.json', JSON.stringify(measurements, null, 2));
    await clickControl(first, 'entry'); await page.keyboard.press('Control+a');
    await firstPanel.locator('.terminal-tab').click();
    assert.ok(await terminalDOM.evaluate(node => node === document.querySelector('[data-panel="shell"] .xterm')));
    await page.keyboard.type(`echo TERMINAL_STILL_ALIVE > ${fixture}/terminal.txt`); await page.keyboard.press('Enter');
    await poll(async () => (await readFile(`${fixture}/terminal.txt`, 'utf8').catch(() => '')).includes('TERMINAL_STILL_ALIVE'), 'terminal did not survive display switching');
    assert.equal(await first.locator('canvas').count(), 0, 'hidden VNC canvas retained');
    assert.equal(await firstPanel.getByRole('button', { name: 'Window menu', exact: true }).count(), 0, 'terminal selection has a window chevron');
    assert.equal(await firstPanel.locator('.terminal-tab.active .panel-title').isVisible(), true);
    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click();
    await first.locator('.terminal-display[data-state=connected]').waitFor();
    await page.keyboard.type('FOCUS_RESTORED'); await page.keyboard.press('Enter');
    await poll(async () => (await readFile(`${fixture}/input.json`, 'utf8')).includes('FOCUS_RESTORED'), 'display toggle did not restore keyboard focus');
    console.log('PASS real GTK keyboard input, owner credentials, modal parent, native file chooser and secondary-window switching');

    const canvasDOM = await first.locator('canvas').elementHandle();
    const sizeBefore = runX(env, 'xdpyinfo', []).match(/dimensions:\s+(\d+x\d+)/)[1];
    await page.setViewportSize({ width: 1700, height: 1000 });
    await poll(() => runX(env, 'xdpyinfo', []).match(/dimensions:\s+(\d+x\d+)/)[1] !== sizeBefore, 'component resize did not resize the X display');
    await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
    const second = page.locator('.terminal-view').last();
    await poll(() => second.getAttribute('data-state').then(v => v === 'connected'), 'second terminal not connected');
    await launch(second, "xterm -fa 'DejaVu Sans Mono' -fs 11 -bg '#111827' -fg '#e5e7eb'");
    await page.waitForTimeout(700);
    const shellBox = await second.locator('canvas').boundingBox();
    await page.mouse.click(shellBox.x + 60, shellBox.y + 60);
    await page.keyboard.type(`printf '%s\\n' GUI_SHELL_OK "$$" "$DISPLAY" > ${fixture}/shell.txt`, { delay: 2 });
    await page.keyboard.press('Enter');
    await poll(async () => (await readFile(`${fixture}/shell.txt`, 'utf8').catch(() => '')).includes('GUI_SHELL_OK'), 'xterm input failed');
    const shellLines = (await readFile(`${fixture}/shell.txt`, 'utf8')).trim().split('\n');
    appPIDs.push(Number(shellLines[1])); assert.notEqual(shellLines[2], input.display);
    const panels = await sessionPanels(); assert.equal(panels.length, 2); assert.notEqual(panels[0].terminal, panels[1].terminal);
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/gui-components.png' });
    await page.getByRole('button', { name: 'Rearrange workspace', exact: true }).click();
    assert.equal(await page.locator('.terminal-view').count(), 2, 'auto layout discarded GUI panels');
    assert.ok(await terminalDOM.evaluate(node => node === document.querySelector('[data-panel="shell"] .xterm')));
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.locator('[data-workspace]:not([data-workspace="gui-proof"]) .terminal-view[data-state=connected]').waitFor();
    const savedWorkspace = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.request().postDataJSON().current === 'gui-proof');
    await page.getByRole('button', { name: 'GUI proof', exact: true }).click();
    await savedWorkspace;
    assert.ok(await canvasDOM.evaluate(node => node === document.querySelector('.terminal-view canvas')));
    await poll(async () => (await (await api('/me')).json()).settings.current === 'gui-proof', 'workspace selection was not saved');
    await page.reload();
    await page.locator('.terminal-display[data-state=connected]').last().waitFor();
    assert.ok(await alive(input.pid));
    assert.deepEqual((await sessionPanels()).map(panel => panel.terminal), panels.map(panel => panel.terminal));
    console.log('PASS separate component displays, actual remote resize, neighboring terminal, automatic layout, warm switch and reload');

    await page.setViewportSize({ width: 1000, height: 950 });
    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click();
    await poll(async () => {
        const data = JSON.parse(await readFile(`${fixture}/input.json.layout`, 'utf8'));
        const canvas = await first.locator('canvas').evaluate(n => ({ w: n.width, h: n.height }));
        return data.entry.x < canvas.w && data['Open many windows'].y < canvas.h;
    }, 'fixture has not resized');
    await clickControl(first, 'Open many windows');
    await firstPanel.getByRole('button', { name: 'Extra window 32', exact: true }).waitFor();
    const moreWindows = firstPanel.getByRole('button', { name: 'More windows', exact: true });
    await moreWindows.waitFor();
    await moreWindows.click();
    const overflowMenu = page.locator('.overflow-tabs:popover-open');
    await overflowMenu.getByRole('button', { name: 'Extra window 26', exact: true }).click();
    await poll(() => firstPanel.locator('.display-window.active').getAttribute('title').then(t => t === 'Extra window 26'), 'overflow selection was not promoted into the header');
    assert.equal(await firstPanel.locator('.display-window.active .display-title').isVisible(), true);
    assert.equal(await firstPanel.locator('.terminal-tab .panel-title').isVisible(), false);
    const headerFits = async () => firstPanel.locator('.panel-header').evaluate(header => {
        const tools = header.querySelector('.panel-tools').getBoundingClientRect();
        return [...header.querySelectorAll('.display-controls button')].filter(b => b.getClientRects().length)
            .every(b => b.getBoundingClientRect().right <= tools.left);
    });
    assert.ok(await headerFits(), 'window row overlaps rename/close');
    await page.screenshot({ path: 'test-results/gui-window-overflow.png' });
    const priorWidth = await firstPanel.evaluate(panel => { const old = panel.style.width; panel.style.width = '260px'; return old; });
    await poll(() => firstPanel.locator('.display-window.active').isVisible(), 'narrow header hid its selected window');
    await poll(headerFits, 'narrow header overlaps rename/close');
    await page.screenshot({ path: 'test-results/gui-window-narrow.png' });
    await firstPanel.evaluate((panel, width) => { panel.style.width = width; }, priorWidth);

    await moreWindows.click();
    assert.ok(await overflowMenu.locator('.display-title').first().isVisible(), 'overflow lost window names');
    await page.screenshot({ path: 'test-results/gui-window-menu.png' });
    const overflowOrder = () => overflowMenu.locator('[data-window]').evaluateAll(nodes => nodes.map(n => n.dataset.window));
    const beforeOverflow = await overflowOrder();
    await dragWindow(overflowMenu.locator('[data-window]').nth(0), overflowMenu.locator('[data-window]').nth(1), false, true);
    await moreWindows.click();
    assert.deepEqual((await overflowOrder()).slice(0, 2), [beforeOverflow[1], beforeOverflow[0]], 'overflow drag did not reorder windows');
    const toClose = overflowMenu.getByRole('button', { name: 'Extra window 24', exact: true });
    const closedID = '0x' + Number(await toClose.getAttribute('data-window')).toString(16);
    await toClose.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await poll(() => !runX(env, 'xprop', ['-root', '_NET_CLIENT_LIST']).includes(closedID), 'overflow context menu did not close its window');
    await firstPanel.locator('.terminal-tab').click();
    assert.ok(await firstPanel.locator('.terminal-tab.active .panel-title').isVisible());
    assert.equal(await first.locator('canvas').count(), 0);
    await moreWindows.click();
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await first.locator('.terminal-display[data-state=connected]').waitFor();
    assert.ok(await headerFits());
    console.log('PASS selected titles, icon-only alternatives, overflow selection/keyboard input and preserved rename/close space');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.component-tab').filter({ hasText: 'Terminal' }).last().click();
    await page.waitForTimeout(1000);
    const bounds = await second.locator('canvas').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845);
    await page.screenshot({ path: 'test-results/gui-mobile.png' });
    const firstTab = page.locator('[data-component-name="shell"]');
    if (!await firstTab.isVisible()) await page.getByRole('button', { name: 'More components', exact: true }).click();
    await firstTab.click();
    await moreWindows.waitFor();
    await moreWindows.click();
    await overflowMenu.getByRole('button', { name: 'Extra window 26', exact: true }).click();
    await poll(() => first.locator('.display-window.active').isVisible(), 'mobile header hid its selected window');
    await first.locator('.terminal-display[data-state=connected]').waitFor();
    await page.screenshot({ path: 'test-results/gui-mobile-windows.png' });

    await page.setViewportSize({ width: 1440, height: 950 });
    await page.evaluate(id => new Promise((resolve, reject) => {
        const socket = window.revocationProbe = new WebSocket(`${location.origin.replace('http', 'ws')}/api/terminals/${id}/display/ws`);
        socket.onopen = resolve; socket.onerror = reject;
    }), panels[0].terminal);
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    await page.waitForFunction(() => window.revocationProbe.readyState === WebSocket.CLOSED);
    assert.ok(await alive(input.pid));
    assert.equal((await api(`/terminals/${panels[0].terminal}/display`)).status(), 401);
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.terminal-display[data-state=connected]').last().waitFor();
    csrf = (await (await api('/me')).json()).csrf;
    await shell(second, 'exit');
    await poll(() => second.getAttribute('data-state').then(value => value === 'ended'), 'shell exit was not reported');
    await poll(() => second.locator('.terminal-host').isVisible(), 'shell exit left a dead display visible');
    await poll(async () => !await alive(Number(shellLines[1])), 'shell exit left GUI app running');
    await page.locator('.terminal-view').last().locator('..').getByRole('button', { name: 'Close panel', exact: true }).click();
    await poll(() => api(`/terminals/${panels[1].terminal}`).then(response => response.status() === 404), 'closing panel left GUI session running');
    await poll(async () => !await alive(Number(shellLines[1])), 'closing panel left its shell running');
    assert.ok(await alive(input.pid));
    console.log('PASS mobile fit, logout socket revocation, login reconnection and individual session termination');

    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click();
    await poll(() => firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).getAttribute('aria-pressed').then(value => value === 'true'), 'main window button did not become active');
    const menu = page.getByRole('menuitem', { name: 'Close', exact: true });
    await firstPanel.locator('.display-window-item.active').getByRole('button', { name: 'Window menu', exact: true }).click();
    await menu.click();
    await poll(async () => !!await windowID('Confirm application close'), 'window close bypassed the application confirmation');
    await page.keyboard.press('Escape');
    await poll(async () => !await windowID('Confirm application close'), 'close confirmation did not cancel');
    assert.ok(await alive(input.pid), 'cancelled window close killed the application');
    await firstPanel.getByRole('button', { name: 'GUI application proof', exact: true }).click({ button: 'right' });
    await menu.click();
    await poll(async () => !!await windowID('Confirm application close'), 'right-click Close did not reach the application');
    await page.screenshot({ path: 'test-results/gui-close-confirmation.png' });
    await page.keyboard.press('Enter');
    await poll(async () => !await alive(input.pid), 'application did not exit');
    await poll(() => firstPanel.locator('[data-window]').count().then(n => n === 0), 'closed windows remain in header');
    assert.equal((await api(`/terminals/${terminal.id}`)).status(), 200);
    await poll(() => api(`/terminals/${terminal.id}/display`).then(response => response.status() === 409), 'empty display kept running');
    await poll(async () => !(await memory()).some(p => /Xvnc|matchbox|dbus-daemon/.test(p.name)), 'GUI runtime processes survived last window');
    measurements.releasedDisplay = await memory();
    assert.equal(await first.locator('canvas').count(), 0, 'empty display retained its canvas');
    assert.ok(await first.locator('.terminal-host').isVisible());
    assert.ok(await firstPanel.locator('.terminal-tab .panel-title').isVisible());
    assert.equal(await firstPanel.locator('.terminal-tab').getAttribute('class').then(s => s.includes('active')), false);
    assert.equal(await firstPanel.locator('.terminal-tab').evaluate(b => getComputedStyle(b).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await firstPanel.locator('.display-separator').isVisible(), false);
    assert.equal(await firstPanel.getByRole('button', { name: 'More windows', exact: true }).isVisible(), false);
    await page.screenshot({ path: 'test-results/gui-released.png' });
    await page.keyboard.type(`echo RECLAIMED > ${fixture}/reclaimed.txt`); await page.keyboard.press('Enter');
    await poll(async () => !!await stat(`${fixture}/reclaimed.txt`).catch(() => false), 'terminal lost input after reclamation');
    await launch(first, `python3 ${process.cwd()}/tests/gui-fixture.py ${fixture}/relaunch.json`);
    await poll(() => firstPanel.locator('[data-window]').count().then(n => n > 0), 'display could not be reused');
    console.log('PASS graceful window close, cancellation, last-window RAM/canvas release and lazy relaunch in the same terminal');

    await page.getByRole('button', { name: 'GUI proof', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
    await poll(async () => !await alive(input.pid), 'workspace closure left GUI running');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    assert.ok(!logs.includes('Invalid screen layout'), 'hidden component requested an invalid display size');
    await writeFile('test-results/gui-memory.json', JSON.stringify(measurements, null, 2));
    console.log('PASS whole-workspace termination and local-only frontend');
} catch (error) {
    if (!await page.locator('.login-page').count()) await page.screenshot({ path: 'test-results/gui-failure.png' });
    console.error(logs); throw error;
} finally {
    await page.goto('about:blank');
    if (original) {
        await api('/login', 'POST', { username: user, password });
        csrf = (await (await api('/me')).json()).csrf;
        await api('/settings', 'PUT', original);
    }
    await browser.close(); service.kill('SIGTERM'); await stopped;
    for (const pid of appPIDs) await poll(async () => !await alive(pid), 'shutdown left an application running');
    for (const runtime of runtimes) assert.equal(await stat(runtime).catch(() => false), false);
    await rm(state, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
console.log('PASS shutdown and temporary credential cleanup');
