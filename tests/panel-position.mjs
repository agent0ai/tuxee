import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const base = process.env.TUXEE_TEST_URL || 'http://127.0.0.1:19085';
const user = process.env.TUXEE_TEST_USER, password = process.env.TUXEE_TEST_PASSWORD;
assert.ok(user && password, 'supply credentials for a marked test account');
const container = process.env.TUXEE_TEST_CONTAINER;
const account = spawnSync(container ? 'docker' : 'getent', container ? ['exec', container, 'getent', 'passwd', user] : ['passwd', user], { encoding: 'utf8' });
assert.equal(account.status, 0);
const fields = account.stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing an unrelated account');
const home = fields[5], browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 960 } });
let api, original, terminal, page;
try {
    page = await appPage(context); page.setDefaultTimeout(10000); const errors = [], sockets = [];
    let resizes = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => { if (socket.url().includes('/terminals/')) {
        sockets.push(socket.url());
        socket.on('framesent', ({ payload }) => { if (typeof payload === 'string' && JSON.parse(payload).type === 'resize') resizes++; });
    } });
    await page.goto(base);
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.locator('button[type=submit]').click(); await page.locator('.topbar').waitFor();
    await page.waitForTimeout(500); await page.goto('about:blank');
    const me = await (await context.request.get(base + '/api/me')).json(); original = me.settings;
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf } });
    const response = await api('/terminals', 'POST', { directory: home, name: 'Panel preview', columns: 100, rows: 30 });
    assert.equal(response.status(), 201); terminal = await response.json();
    const panels = [
        { id: 'browser', kind: 'files', path: home, x: 0, y: 0, w: 2, h: 2 },
        { id: 'shell', kind: 'terminal', path: home, terminal: terminal.id, x: 2, y: 0, w: 2, h: 2 },
        ...['minimized', 'second', 'third'].map((id, i) => ({ id, kind: 'files', path: ['/tmp', '/etc', '/usr'][i], minimized: true, x: 0, y: 0, w: 1, h: 1 })),
    ];
    const fixture = { theme: 'dark', serverColor: '#a58aeb', howToSeen: true, current: 'overview', panelPosition: 'top', workspaces: ['Overview', 'Development', 'Operations', 'Files'].map((name, i) => ({ id: name.toLowerCase(), name, columns: 4, rows: 2, panels: i ? [] : panels, active: i ? '' : 'shell' })) };
    const saved = await api('/settings', 'PUT', fixture); assert.equal(saved.status(), 200, await saved.text());
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await page.evaluate(() => { window.originalTerminal = document.querySelector('.terminal-view'); });
    const connections = sockets.length;
    const hoverStyles = {};
    const snapshot = async () => (await (await api('/me')).json()).settings;
    async function choose(position, save = true) {
        await page.locator('.user-menu-button').click(); await page.locator('.account-menu [data-action=Settings]').click();
        await page.locator('[name=panelPosition]').waitFor();
        const compact = page.viewportSize().width < 760 || page.viewportSize().height < 480;
        assert.deepEqual(await page.locator('[name=panelPosition] option').evaluateAll(options => options.map(option => option.value)), compact ? ['top', 'bottom'] : ['top', 'bottom', 'left', 'right']);
        await page.locator('[name=panelPosition]').selectOption(position);
        if (save) await page.locator('dialog:has(.settings-form) .modal-footer button[type=submit]').click();
        else await page.locator('.modal-head > button').click();
        await page.locator('.settings-form').waitFor({ state: 'detached' });
        if (save) await page.waitForFunction(position => document.querySelector('#app').dataset.panelPosition === position, position);
    }
    await mkdir('test-results/panel-position', { recursive: true });
    for (const position of ['top', 'bottom', 'left', 'right']) {
        await choose(position); await page.waitForTimeout(300);
        assert.equal((await snapshot()).panelPosition, position);
        assert.equal(await page.evaluate(() => originalTerminal === document.querySelector('.terminal-view')), true, 'changing position retains terminal DOM');
        assert.equal(sockets.length, connections, 'changing position keeps the terminal transport');
        const top = await page.locator('.topbar').boundingBox(), desktop = await page.locator('.workspace-viewport').boundingBox();
        const edge = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[position];
        assert.equal(await page.locator('.topbar').evaluate((node, edge) => getComputedStyle(node).getPropertyValue(`border-${edge}-color`), edge), 'rgb(165, 138, 235)');
        assert.ok(await page.locator('.topbar').evaluate((node, edge) => parseFloat(getComputedStyle(node).getPropertyValue(`border-${edge}-width`)) > 1, edge));
        if (position === 'top') assert.ok(top.y + top.height <= desktop.y);
        if (position === 'bottom') assert.ok(desktop.y + desktop.height <= top.y);
        if (position === 'left') assert.ok(top.x + top.width <= desktop.x);
        if (position === 'right') assert.ok(desktop.x + desktop.width <= top.x);
        if (position === 'left' || position === 'right') {
            assert.equal(top.width, 154);
            const rail = await page.locator('.window-bar').boundingBox();
            assert.equal(await page.locator('[data-workspace=overview] > .window-bar').count(), 1, 'window list belongs to the active desktop');
            const active = await page.locator('[data-workspace=overview] > .workspace-tab').boundingBox();
            assert.ok(rail.y >= active.y + active.height && rail.x > top.x && rail.x + rail.width < top.x + top.width, 'window list is indented below its desktop');
            if (position === 'left') assert.equal(top.x + top.width, desktop.x);
            else assert.equal(desktop.x + desktop.width, top.x);
            const tabs = await page.locator('.workspace-tab-item').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
            assert.ok(tabs.every((r, i) => r.width === tabs[0].width && (!i || r.y >= tabs[i - 1].bottom)));
            const plus = await page.locator('.workspace-controls > button').boundingBox();
            assert.ok(plus.y >= tabs.at(-1).bottom && plus.y - tabs.at(-1).bottom < 10);
            const actions = await page.locator('.panel-additions > button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
            assert.ok(actions.every(r => r.y === actions[0].y));
            const network = await page.locator('.monitor-network-value > span').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().y));
            assert.ok(network.length === 2 && network[0] === network[1], 'network readings stay on one line');
            assert.equal(await page.locator('.panel-additions > button > svg').first().evaluate(n => n.getBoundingClientRect().width), 18);
            const theme = await page.locator('.theme-toggle').boundingBox(), volume = await page.locator('.volume-toggle').boundingBox(), account = await page.locator('.user-menu-button').boundingBox();
            assert.equal(theme.y, volume.y); assert.equal(account.y, theme.y);
        }
        for (const [opener, popup] of [['.user-menu-button', '.account-menu'], ['.volume-toggle', '.volume-popover'], ['.workspace-menu', '.menu-actions'], ['[data-component-menu=minimized]', '.menu-actions'], ['.command-shortcuts-toggle', '.command-shortcuts']]) {
            await page.locator(opener).first().click();
            const box = await page.locator(popup + ':popover-open').boundingBox();
            assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 960);
            const button = await page.locator(opener).first().boundingBox();
            if (position === 'left') assert.ok(Math.abs(box.x - button.x - button.width - 4) < 1);
            if (position === 'right') assert.ok(Math.abs(box.x + box.width - button.x + 4) < 1);
            if (position === 'bottom') assert.ok(box.y + box.height <= top.y);
            if (opener === '.workspace-menu') await page.screenshot({ path: `test-results/panel-position/${position}-menu.png` });
            await page.locator(opener).first().click(); assert.equal(await page.locator(popup + ':popover-open').count(), 0);
        }
        const vertical = position === 'left' || position === 'right';
        const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        const title = id => page.locator(`[data-component-name="${id}"]`);
        const panel = id => page.locator(`[data-panel="${id}"]`);
        const desktopTab = id => page.locator(`[data-workspace="${id}"] .workspace-tab`);
        const settled = async () => {
            await page.waitForFunction(() => !document.querySelector('.component-flight') && !document.getAnimations().some(a => a.effect?.target?.matches?.('.grid-stack-item, .workspace-track')));
            await page.waitForTimeout(350);
        };
        const startDrag = async locator => {
            const point = center(await locator.boundingBox());
            await page.mouse.move(point.x, point.y); await page.mouse.down();
        };
        const move = async (point, steps = 12) => page.mouse.move(point.x, point.y, { steps });
        const endDrag = async cancel => { if (cancel) await page.keyboard.press('Escape'); await page.mouse.up(); await settled(); };
        const checkGap = async () => {
            await page.waitForTimeout(220);
            const gap = await page.locator('.tab-placeholder:not([hidden])').boundingBox(), preview = await page.locator('.tab-drag-preview').boundingBox();
            assert.ok(gap && preview && Math.abs(gap.width - preview.width) < 1 && Math.abs(gap.height - preview.height) < 1, 'full tab gap matches the preview');
            assert.equal(await page.locator('.tab-drag-preview button').count(), 2, 'label and chevron remain in the preview');
            const host = await page.locator('.tab-placeholder:not([hidden])').evaluate(n => n.closest('nav').getBoundingClientRect().toJSON());
            assert.ok(gap.y >= host.y && gap.y + gap.height <= host.bottom + 1, 'placement gap is inside the visible strip');
            assert.equal(await page.locator('.tab-drop-before, .tab-drop-after').count(), 0, 'no separator drop marker');
        };
        const beforeDesktops = (await snapshot()).workspaces.map(w => w.id);
        for (const cancel of [true, false]) {
            await startDrag(desktopTab('development')); await move(center(await desktopTab('files').boundingBox()));
            await checkGap(); await endDrag(cancel);
            assert.equal((await snapshot()).current, 'overview', 'reordering never activates a desktop');
            if (cancel) assert.deepEqual((await snapshot()).workspaces.map(w => w.id), beforeDesktops);
        }
        assert.equal((await snapshot()).workspaces.at(-1).id, 'development');
        await desktopTab('development').focus();
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft');
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft'); await settled();
        assert.deepEqual((await snapshot()).workspaces.map(w => w.id), beforeDesktops);
        if (vertical) {
            for (const cancel of [true, false]) {
                await startDrag(desktopTab('overview')); await move(center(await desktopTab('files').boundingBox()));
                await page.locator('.tab-drag-preview .window-bar').waitFor();
                await endDrag(cancel);
                assert.equal((await snapshot()).current, 'overview', 'active desktop carries its nested windows when reordered');
                if (cancel) assert.deepEqual((await snapshot()).workspaces.map(w => w.id), beforeDesktops);
            }
            await desktopTab('overview').focus();
            for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+ArrowUp');
            await settled();
            assert.deepEqual((await snapshot()).workspaces.map(w => w.id), beforeDesktops);
        }
        const hiddenOrder = async () => (await snapshot()).workspaces[0].panels.filter(p => p.minimized).map(p => p.id);
        await title('minimized').focus();
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft');
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft'); await settled();
        const beforeWindows = await hiddenOrder();
        assert.deepEqual(beforeWindows, ['minimized', 'second', 'third']);
        for (const cancel of [true, false]) {
            await startDrag(title('minimized')); await move(center(await title('third').boundingBox())); await checkGap(); await endDrag(cancel);
            if (cancel) assert.deepEqual(await hiddenOrder(), beforeWindows);
        }
        assert.deepEqual(await hiddenOrder(), ['second', 'third', 'minimized']);
        await title('minimized').focus();
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft');
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft'); await settled();
        assert.deepEqual(await hiddenOrder(), beforeWindows);
        // Leaving the rail keeps the source lifted through desktop restoration and reentry.
        await startDrag(title('minimized')); await move(center(await title('second').boundingBox())); await checkGap();
        await move(center(desktop));
        assert.equal(await title('minimized').evaluate(n => getComputedStyle(n.parentElement).visibility), 'hidden');
        await move(center(await title('third').boundingBox())); await checkGap(); await endDrag(true);
        assert.deepEqual(await hiddenOrder(), beforeWindows);
        await startDrag(title('minimized')); await move(center(desktop)); await endDrag(false);
        assert.ok(await panel('minimized').isVisible(), 'dragging out restores the real window');
        await panel('minimized').locator('.window-minimize').click(); await settled();
        await title('minimized').focus();
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft');
        await page.keyboard.press(vertical ? 'Alt+ArrowUp' : 'Alt+ArrowLeft'); await settled();
        // Insert an existing window between two tabs, then restore by clicking it.
        await startDrag(panel('browser').locator('.panel-header'));
        const insert = await title('second').boundingBox();
        await move({ x: insert.x + (vertical ? insert.width / 2 : 2), y: insert.y + (vertical ? 2 : insert.height / 2) });
        await checkGap(); await endDrag(false);
        assert.deepEqual(await hiddenOrder(), ['minimized', 'browser', 'second', 'third']);
        await title('browser').click(); await settled();
        assert.ok(await panel('browser').isVisible());
        // Move a window between desktops using the same compact preview and retain the source desktop.
        await startDrag(panel('browser').locator('.panel-header')); await move(center(await desktopTab('development').boundingBox()));
        await endDrag(false);
        assert.equal((await snapshot()).current, 'overview');
        assert.ok((await snapshot()).workspaces.find(w => w.id === 'development').panels.some(p => p.id === 'browser'));
        await desktopTab('development').click(); await settled();
        await startDrag(panel('browser').locator('.panel-header')); await move(center(await desktopTab('overview').boundingBox())); await endDrag(false);
        await desktopTab('overview').click(); await settled();
        // A maximized window uses the same vertical/horizontal reorder and restore controls.
        await panel('shell').locator('.window-maximize').click(); await settled();
        await startDrag(title('second')); await move(center(await title('third').boundingBox())); await checkGap(); await endDrag(true);
        assert.equal((await snapshot()).workspaces[0].maximized, 'shell');
        await panel('shell').locator('.window-maximize').click(); await settled();
        // Temporarily reveal an empty rail, preserving live content pixels and exact cancel geometry.
        for (const id of ['minimized', 'second', 'third']) { await title(id).click(); await settled(); }
        assert.equal(await page.locator('.window-bar').isVisible(), false);
        const gridBefore = await page.locator('.board:not([inert]) .grid-stack').boundingBox(), resizeBefore = resizes;
        await startDrag(panel('shell').locator('.panel-header'));
        const initial = center(await panel('shell').locator('.panel-header').boundingBox());
        await move({ x: initial.x + 10, y: initial.y + 10 });
        const emptyBar = await page.locator('.window-bar').boundingBox(), gridDuring = await page.locator('.board:not([inert]) .grid-stack').boundingBox();
        assert.ok(emptyBar);
        if (vertical) assert.deepEqual(gridDuring, gridBefore, 'revealing nested windows does not consume desktop space');
        else assert.ok(gridDuring.height < gridBefore.height && gridDuring.width === gridBefore.width);
        await move(center(emptyBar)); await checkGap();
        await page.waitForTimeout(250); assert.equal(resizes, resizeBefore, 'revealing an empty rail never resizes the live terminal');
        await endDrag(true);
        assert.deepEqual(await page.locator('.board:not([inert]) .grid-stack').boundingBox(), gridBefore);
        assert.equal(resizes, resizeBefore, 'cancellation never resizes the live terminal');
        await startDrag(panel('minimized').locator('.panel-header')); await move(center(emptyBar)); await checkGap(); await endDrag(false);
        assert.deepEqual(await hiddenOrder(), ['minimized'], 'empty rail accepts the first window drop');
        for (const id of ['second', 'third']) { await panel(id).locator('.window-minimize').click(); await settled(); }
        // Toolbar actions retain click and grid-drop behavior in every position.
        const ids = new Set((await snapshot()).workspaces[0].panels.map(p => p.id));
        for (const drag of [false, true]) {
            const add = page.locator('.add-panel[data-kind=files]');
            if (drag) { await startDrag(add); await move(center(desktop)); await endDrag(false); }
            else { await add.click(); await settled(); }
            const created = (await snapshot()).workspaces[0].panels.find(p => !ids.has(p.id));
            assert.ok(created, 'toolbar adds a file window');
            await panel(created.id).locator('.panel-tools > button:last-child').click(); await settled();
        }
        const head = await page.locator('[data-panel=browser] .panel-header').boundingBox();
        const bar = await page.locator('.window-bar').boundingBox(), destination = await page.locator('[data-workspace=development]').boundingBox();
        await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2); await page.mouse.down();
        for (const point of [{ x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 }, { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 }]) {
            await page.mouse.move(point.x, point.y, { steps: 12 });
            await page.locator('.tab-drag-preview').waitFor(); await page.waitForTimeout(200);
            const preview = await page.locator('.tab-drag-preview').boundingBox();
            assert.ok(preview.width < 300 && preview.height < 80, 'window remains tab-sized over either bar');
        }
        await page.mouse.move(desktop.x + desktop.width / 2, desktop.y + desktop.height / 2, { steps: 12 });
        assert.equal(await page.locator('.tab-drag-preview').count(), 0, 'desktop restores full window preview');
        await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(300);
        await page.mouse.move(720, 600);
        await page.locator('.terminal-view').click();
        for (const theme of ['dark', 'light']) {
            if (theme === 'light') { await page.locator('.theme-toggle').click(); await settled(); }
            const appearances = [];
            for (const selector of ['[data-workspace=overview] .workspace-tab', '[data-workspace=development] .workspace-tab', '[data-component-name=minimized]', '[data-workspace=overview] .workspace-menu', '[data-component-menu=minimized]']) {
                await page.locator(selector).hover(); await page.waitForTimeout(120);
                appearances.push(await page.locator(selector).evaluate(n => [getComputedStyle(n).backgroundColor, getComputedStyle(n.parentElement).backgroundColor]));
            }
            if (position === 'top') hoverStyles[theme] = appearances;
            else assert.deepEqual(appearances, hoverStyles[theme], 'hover appearance matches horizontal mode in both themes');
            await page.mouse.move(720, 600);
            for (const selector of ['.theme-toggle', '.volume-toggle', '.user-menu-button']) assert.equal(await page.locator(selector).evaluate(n => getComputedStyle(n).backgroundColor), 'rgba(0, 0, 0, 0)', 'utility controls have no permanent backgrounds');
            await page.screenshot({ path: `test-results/panel-position/${position}${theme === 'light' ? '-light' : ''}.png` });
        }
        await page.locator('.theme-toggle').click(); await settled();
        assert.equal(await page.evaluate(() => originalTerminal === document.querySelector('.terminal-view')), true);
        assert.equal(sockets.length, connections, 'all gestures preserve the terminal connection');
        if (position === 'bottom') {
            await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#app.compact[data-panel-position=bottom]').waitFor();
            const desktopBar = await page.locator('.topbar').boundingBox(), windowBar = await page.locator('.component-controls').boundingBox();
            assert.ok(windowBar.y + windowBar.height <= desktopBar.y, 'mobile inherits Bottom with windows above desktops');
            assert.equal((await snapshot()).mobilePanelPosition, undefined, 'inheritance does not save a mobile override');
            await page.setViewportSize({ width: 1440, height: 960 }); await page.locator('#app:not(.compact)').waitFor();
        }
        console.log(`PASS ${position}: settings/layout, themed hovers, anchored toggles, desktop/window reorder, insertion gaps, restoration, cross-desktop moves, maximized tabs, empty rail and terminal continuity`);
    }
    await choose('left', false); assert.equal((await snapshot()).panelPosition, 'right', 'Cancel preserves the saved position');
    await page.reload(); await page.locator('#app[data-panel-position=right]').waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#app.compact[data-panel-position=top]').waitFor();
    assert.equal((await snapshot()).panelPosition, 'right', 'compact fallback preserves side preference');
    await choose('bottom');
    assert.equal((await snapshot()).mobilePanelPosition, 'bottom'); assert.equal((await snapshot()).panelPosition, 'right');
    await page.reload(); await page.locator('#app.compact[data-panel-position=bottom]').waitFor();
    const mobileDesktop = await page.locator('.topbar').boundingBox(), mobileWindows = await page.locator('.component-controls').boundingBox();
    assert.ok(mobileWindows.y + mobileWindows.height <= mobileDesktop.y, 'mobile window strip mirrors above the desktop bar');
    await page.screenshot({ path: 'test-results/panel-position/mobile-bottom.png' });
    await choose('top'); await page.screenshot({ path: 'test-results/panel-position/mobile-top.png' });
    await page.setViewportSize({ width: 1440, height: 960 }); await page.locator('#app.side-panel[data-panel-position=right]').waitFor();
    await page.setViewportSize({ width: 900, height: 650 }); await page.waitForTimeout(500);
    assert.equal(await page.locator('.monitor-chip').count(), 4, 'side panel retains two rows of metrics on narrower desktops');
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const rtlPanel = await page.locator('.topbar').boundingBox();
    assert.ok(rtlPanel.x >= 679, 'Right stays on the physical right with RTL chrome');
    await page.locator('.user-menu-button').click(); await page.locator('.account-menu [data-action=Settings]').click();
    await page.screenshot({ path: 'test-results/panel-position/settings-rtl.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('[name=panelPosition]').options.length === 2);
    assert.equal(await page.locator('[name=panelPosition]').inputValue(), 'top', 'open settings switches to the mobile preference on resize');
    await page.setViewportSize({ width: 900, height: 650 });
    await page.waitForFunction(() => document.querySelector('[name=panelPosition]').options.length === 4);
    assert.equal(await page.locator('[name=panelPosition]').inputValue(), 'right');
    await page.locator('.modal-head > button').click();
    const invalid = await api('/settings', 'PUT', { ...await snapshot(), panelPosition: 'center' });
    assert.equal(invalid.status(), 400);
    assert.equal((await api('/settings', 'PUT', { ...await snapshot(), mobilePanelPosition: 'left' })).status(), 400);
    assert.deepEqual(errors, []);
    console.log('PASS cancellation, reload, independent mobile placement/inheritance, responsive settings, invalid values and browser errors');
    let rate = 999e6;
    await page.route(base + '/api/metrics', async route => {
        const response = await route.fetch(), data = await response.json();
        data.networks.find(n => n.name === '/all').receiveRate = rate;
        data.networks.find(n => n.name === '/all').sendRate = rate;
        data.cpu.percent = 100;
        await route.fulfill({ response, json: data });
    });
    for (const cpu of [true, false]) for (const theme of ['dark', 'light']) {
        await page.waitForTimeout(350); await page.goto('about:blank');
        assert.equal((await api('/settings', 'PUT', { ...fixture, panelPosition: 'right', theme,
            monitoring: { cpu, memory: true, swap: false, disks: ['/'], networks: ['/all'], interval: 2 } })).status(), 200);
        await page.goto(base); await page.locator('.monitor-summary[data-state=ready]').waitFor();
        for (rate of [999e6, 0]) {
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await page.waitForFunction(value => document.querySelector('.monitor-download').textContent === value, rate ? '999M' : '0B');
            const geometry = await page.locator('.monitor-strip').evaluate(n => {
                const r = n.getBoundingClientRect(), network = n.querySelector('[data-kind=network]').getBoundingClientRect();
                return { right: r.right, left: r.left, network: network.toJSON(),
                    readings: [...n.querySelectorAll('.monitor-network-value > span')].map(n => n.getBoundingClientRect().toJSON()),
                    columns: getComputedStyle(n).gridTemplateColumns.split(' ').map(parseFloat) };
            });
            assert.equal(geometry.readings[0].y, geometry.readings[1].y, 'both NET rates remain on one line');
            assert.ok(geometry.readings[1].right <= geometry.right + 1, 'large NET values fit the side panel');
            assert.ok(cpu ? geometry.network.x > geometry.left : geometry.network.x === geometry.left, 'NET follows the configured metric order');
            if (rate) assert.ok(geometry.columns[cpu ? 1 : 0] > geometry.columns[cpu ? 0 : 1], 'the column containing NET grows with its content');
        }
        await page.screenshot({ path: `test-results/panel-position/right-metrics-${cpu ? 'cpu' : 'no-cpu'}-${theme}.png` });
    }
    await page.unroute(base + '/api/metrics');
    console.log('PASS content-sized metrics, single-line NET in either column and both themes');
    // Long side lists remain scrollable, with their last controls clickable and draggable.
    const crowded = structuredClone(fixture);
    crowded.workspaces.push(...Array.from({ length: 8 }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}`, columns: 4, rows: 2, panels: [] })));
    crowded.workspaces[0].panels.push(...Array.from({ length: 27 }, (_, i) => ({ id: `hidden${i}`, kind: 'files', path: home, minimized: true, x: 0, y: 0, w: 1, h: 1 })));
    await page.waitForTimeout(300); await page.goto('about:blank');
    for (const position of ['left', 'right']) {
        assert.equal((await api('/settings', 'PUT', { ...crowded, panelPosition: position })).status(), 200);
        await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
        await page.waitForTimeout(300);
        for (const [strip, last, opener] of [['.workspace-tabs', '[data-workspace=extra7] .workspace-tab', '[data-workspace=extra7] .workspace-menu']]) {
            assert.equal(await page.locator(strip).evaluate(n => n.scrollHeight > n.clientHeight), true, 'long side list scrolls');
            await page.locator(last).scrollIntoViewIfNeeded();
            const scroll = await page.locator(strip).evaluate(n => n.scrollTop);
            await page.evaluate(() => window.dispatchEvent(new Event('tuxee-tabs-changed')));
            await page.waitForTimeout(100);
            assert.equal(await page.locator(strip).evaluate(n => n.scrollTop), scroll, 'label refresh keeps the vertical scroll position');
            await page.locator(opener).click(); await page.locator('.menu-actions:popover-open').waitFor();
            await page.locator(opener).click(); assert.equal(await page.locator('.menu-actions:popover-open').count(), 0);
            const a = await page.locator(last).boundingBox();
            await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
            await page.evaluate(() => window.dispatchEvent(new Event('tuxee-tabs-changed')));
            await page.waitForTimeout(100);
            await page.mouse.move(a.x + a.width / 2, a.y - a.height, { steps: 12 });
            await page.locator('.tab-drag-preview').waitFor();
            await page.keyboard.press('Escape'); await page.mouse.up();
            await page.waitForTimeout(250);
            const beforeCommit = await page.locator(strip).evaluate(n => n.scrollTop);
            const start = await page.locator(last).boundingBox();
            await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
            await page.mouse.move(start.x + start.width / 2, start.y - start.height, { steps: 12 });
            await page.mouse.up(); await page.waitForTimeout(350);
            assert.equal(await page.locator(strip).evaluate(n => n.scrollTop), beforeCommit, 'reordering a scrolled list keeps its scroll position');
            assert.equal(await page.locator(last).evaluate(n => n.parentElement.nextElementSibling !== null), true, 'last tab moved up');
        }
        await page.goto('about:blank');
        await page.setViewportSize({ width: 1280, height: 800 });
        assert.equal((await api('/settings', 'PUT', { ...crowded, workspaces: crowded.workspaces.slice(0, 4), panelPosition: position })).status(), 200);
        await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
        await page.waitForTimeout(300);
        await page.locator('[data-workspace=overview] > .workspace-tab').scrollIntoViewIfNeeded();
        const visibleWindows = page.locator('.component-tabs > .visible-tabs > .component-tab-item');
        const originalCount = await visibleWindows.count();
        await page.setViewportSize({ width: 1280, height: 600 }); await page.waitForTimeout(300);
        assert.ok(await visibleWindows.count() < originalCount, 'shorter side panels move excess windows into overflow');
        await page.setViewportSize({ width: 1280, height: 1000 }); await page.waitForTimeout(300);
        assert.ok(await visibleWindows.count() > originalCount, 'taller side panels recover window rows from overflow');
        await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(300);
        assert.equal(await visibleWindows.count(), originalCount);
        const more = page.locator('.window-bar .overflow-toggle');
        await more.scrollIntoViewIfNeeded(); await more.click();
        const hidden = page.locator('[data-component-name=hidden26]');
        await hidden.scrollIntoViewIfNeeded();
        await page.locator('[data-component-menu=hidden26]').click(); await page.locator('.menu-actions:popover-open').waitFor();
        const childMenu = await page.locator('.menu-actions:popover-open').boundingBox(), opener = await page.locator('[data-component-menu=hidden26]').boundingBox();
        assert.ok(childMenu.x >= opener.x + opener.width || childMenu.x + childMenu.width <= opener.x, 'nested actions keep their opener clear');
        await page.locator('[data-component-menu=hidden26]').click(); assert.equal(await page.locator('.menu-actions:popover-open').count(), 0);
        for (const cancel of [true, false]) {
            const from = await hidden.boundingBox(), target = await page.locator('.component-tabs > .visible-tabs > .component-tab-item').first().boundingBox();
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
            await page.mouse.move(from.x + from.width / 2, from.y + 6, { steps: 3 });
            await page.mouse.move(target.x + target.width / 2, target.y + 2, { steps: 12 });
            await page.locator('.tab-drag-preview').waitFor();
            if (cancel) await page.keyboard.press('Escape');
            await page.mouse.up(); await page.waitForTimeout(350);
            if (cancel) { await more.click(); await hidden.scrollIntoViewIfNeeded(); }
        }
        assert.equal(await page.locator('.component-tabs > .visible-tabs [data-component-name=hidden26]').count(), 1, 'overflow window can move into the nested list');
        const from = await hidden.boundingBox(), toggle = await more.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
        await page.mouse.move(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2, { steps: 16 });
        await page.locator('.overflow-tabs:popover-open').waitFor();
        const target = await page.locator('.overflow-tabs:popover-open > .component-tab-item').first().boundingBox();
        await page.mouse.move(target.x + target.width / 2, target.y + target.height, { steps: 16 });
        await page.locator('.tab-drag-preview').waitFor();
        await page.mouse.up(); await page.waitForTimeout(350);
        assert.equal(await page.locator('.component-tabs > .visible-tabs [data-component-name=hidden26]').count(), 0, 'visible window can move back into overflow');
        await page.screenshot({ path: `test-results/panel-position/${position}-nested-overflow.png` });
        await page.waitForTimeout(300); await page.goto('about:blank');
        await page.setViewportSize({ width: 900, height: 650 });
    }
    assert.deepEqual(errors, []);
    console.log('PASS long vertical desktops and nested window overflow: anchored menus, dragging and cancellation');
} catch (error) {
    if (page && await page.locator('.topbar').count()) await page.screenshot({ path: 'test-results/panel-position/failure.png' }).catch(() => {});
    throw error;
} finally {
    await page?.close();
    if (api && original) await api('/settings', 'PUT', original);
    if (api && terminal) await api(`/terminals/${terminal.id}`, 'DELETE');
    await browser.close();
}
