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
const addedTerminals = [];
try {
    page = await appPage(context); page.setDefaultTimeout(30000); const errors = [], sockets = [];
    const pendingSettings = new Set();
    page.on('request', request => { if (request.url() === base + '/api/settings' && request.method() === 'PUT') pendingSettings.add(request); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) pendingSettings.clear(); });
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
    const snapshot = async () => {
        while (pendingSettings.size) {
            await Promise.all([...pendingSettings].map(async request => { await (await request.response())?.finished(); pendingSettings.delete(request); }));
            await page.waitForTimeout(20);
        }
        return (await (await api('/me')).json()).settings;
    };
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
            const group = await page.locator('.workspace-tab-item[data-workspace=overview]').boundingBox();
            assert.ok(rail.y >= group.y + 35, 'window indentation starts clear of the desktop highlight');
            assert.ok(rail.x - group.x <= 5, 'window indentation stays compact');
            const icon = await page.locator('[data-component-name=minimized] > svg').boundingBox();
            assert.ok(icon.x - rail.x <= 6, 'window icons sit close to the indentation border');
            const chevrons = await page.locator('.workspace-tabs > .visible-tabs .workspace-menu > svg, .component-tabs > .visible-tabs .component-menu > svg').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().x));
            assert.ok(Math.max(...chevrons) - Math.min(...chevrons) < 1, 'desktop and window chevrons align');
            if (position === 'left') assert.equal(top.x + top.width, desktop.x);
            else assert.equal(desktop.x + desktop.width, top.x);
            const tabs = await page.locator('.workspace-tab-item').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
            assert.ok(tabs.every((r, i) => r.width === tabs[0].width && (!i || r.y >= tabs[i - 1].bottom)));
            const plus = await page.locator('.workspace-add').boundingBox();
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
            await page.screenshot({ path: `test-results/panel-position/${position}-menu-${opener.replace(/[^a-z-]/g, '')}.png` });
            await page.locator(opener).first().click(); assert.equal(await page.locator(popup + ':popover-open').count(), 0);
        }
        const vertical = position === 'left' || position === 'right';
        let dragCapture = 0;
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
            await page.screenshot({ path: `test-results/panel-position/${position}-drag-gap-${++dragCapture}.png` });
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
                await checkGap();
                assert.equal(await page.locator('.tab-drag-preview .window-bar').count(), 0, 'desktop preview excludes its windows');
                assert.ok((await page.locator('.tab-drag-preview').boundingBox()).height <= 35, 'desktop drag reserves only a button-sized row');
                if (cancel) await page.screenshot({ path: `test-results/panel-position/${position}-desktop-drag.png` });
                await endDrag(cancel);
                assert.equal((await snapshot()).current, 'overview', 'active desktop stays selected when reordered');
                assert.equal(await page.locator('[data-workspace=overview] > .window-bar:not([hidden]) .component-tab-item').count(), 3, 'windows return after cancel or reorder');
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
        if (vertical) {
            await title('third').click(); await settled();
            const rail = page.locator('.window-bar'), before = await rail.boundingBox();
            await page.screenshot({ path: `test-results/panel-position/${position}-before-incoming-window.png` });
            for (const cancel of [true, false]) {
                await startDrag(panel('browser').locator('.panel-header'));
                const target = await title('second').boundingBox();
                await move({ x: target.x + target.width / 2, y: target.y + 2 }); await checkGap();
                const during = await rail.boundingBox();
                assert.ok(during.height >= before.height + target.height, 'incoming window grows the sidebar list by a full insertion row: ' + JSON.stringify({ before, during, target }));
                for (const id of ['minimized', 'second']) {
                    const row = await title(id).boundingBox();
                    assert.ok(row.y >= during.y && row.y + row.height <= during.y + during.height, 'existing minimized windows remain fully visible during insertion');
                }
                await endDrag(cancel);
                if (!cancel) { await title('browser').click(); await settled(); }
                assert.deepEqual(await rail.boundingBox(), before, 'cancellation or restoration removes the extra row');
            }
            await panel('third').locator('.window-minimize').click(); await settled();
        }
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
            if (vertical) {
                const logo = await page.locator('.brand').boundingBox(), button = await page.locator('.brand-button').boundingBox();
                // Both horizontal assets' foreground lies inside these source-pixel bounds.
                assert.ok(logo.x + logo.width * 20 / 320 > button.x + 3 && logo.x + logo.width * 300 / 320 < button.x + button.width - 3, 'full logo has horizontal clearance');
                assert.ok(logo.y + logo.height * 16 / 128 >= button.y + 1 && logo.y + logo.height * 112 / 128 <= button.y + button.height - 1, 'full logo fits vertically');
            }
            const appearances = [];
            for (const selector of ['[data-workspace=overview] .workspace-tab', '[data-workspace=development] .workspace-tab', '[data-component-name=minimized]', '[data-workspace=overview] .workspace-menu', '[data-component-menu=minimized]']) {
                await page.locator(selector).hover(); await page.waitForTimeout(120);
                await page.locator(selector.startsWith('[data-component') && !vertical ? '.component-controls' : '.topbar').screenshot({ path: `test-results/panel-position/${position}-${theme}-hover-${selector.replace(/[^a-z-]/g, '')}.png` });
                appearances.push(await page.locator(selector).evaluate(n => [getComputedStyle(n).backgroundColor, getComputedStyle(n.parentElement, n.closest('#app.side-panel') && n.parentElement.matches('.workspace-tab-item.active') ? '::before' : null).backgroundColor]));
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
    assert.deepEqual(await page.locator('.component-controls > .panel-additions > button').evaluateAll(nodes => nodes.map(n => n.dataset.kind || n.className)), ['files', 'terminal', 'command-shortcuts-toggle'], 'mobile actions stay together in Files, Terminal, Favorites order');
    assert.equal((await snapshot()).panelPosition, 'right', 'compact fallback preserves side preference');
    await choose('bottom');
    assert.equal((await snapshot()).mobilePanelPosition, 'bottom'); assert.equal((await snapshot()).panelPosition, 'right');
    await page.reload(); await page.locator('#app.compact[data-panel-position=bottom]').waitFor();
    const mobileDesktop = await page.locator('.topbar').boundingBox(), mobileWindows = await page.locator('.component-controls').boundingBox();
    assert.ok(mobileWindows.y + mobileWindows.height <= mobileDesktop.y, 'mobile window strip mirrors above the desktop bar');
    await page.locator('.terminal-view[data-state=connected]:visible').waitFor();
    await page.locator('.terminal-rendering:visible').waitFor({ state: 'hidden' });
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
    const samples = [
        { name: 'zero', cpu: 0, disk: 0, memory: 0, rate: 0, net: '0B' },
        { name: 'decimal', cpu: 9.9, disk: 9.9e9, memory: 9.9 * 1024 ** 2, rate: 9.9e3, net: '9.9K' },
        { name: 'two-digits', cpu: 10, disk: 83e9, memory: 61 * 1024 ** 2, rate: 12e3, net: '12K' },
        { name: 'maximum', cpu: 100, disk: 999e6, memory: 999 * 1024 ** 2, rate: 999e6, net: '999M' },
        { name: 'promoted', cpu: 1, disk: 1e12, memory: 1024 ** 3, rate: 1e9, net: '1.0G' },
        { name: 'unavailable', cpu: null, disk: null, memory: null, rate: null, net: '—' },
    ];
    let sample = samples[0];
    await page.route(base + '/api/metrics', async route => {
        const response = await route.fetch(), data = await response.json();
        data.networks.find(n => n.name === '/all').receiveRate = sample.rate;
        data.networks.find(n => n.name === '/all').sendRate = sample.rate;
        data.cpu.percent = sample.cpu;
        data.disks.find(d => d.path === '/').used = sample.disk;
        data.memory.used = sample.memory;
        await route.fulfill({ response, json: data });
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    for (const position of ['top', 'bottom', 'left', 'right']) for (const cpu of [true, false]) for (const theme of ['dark', 'light']) {
        await page.waitForTimeout(350); await page.goto('about:blank');
        assert.equal((await api('/settings', 'PUT', { ...fixture, panelPosition: position, theme,
            monitoring: { cpu, memory: true, swap: false, disks: ['/'], networks: ['/all'], interval: 2 } })).status(), 200);
        await page.goto(base); await page.locator('.monitor-summary[data-state=ready]').waitFor();
        const vertical = position === 'left' || position === 'right';
        let baseline;
        for (sample of samples) {
            const previous = await page.locator('.monitor-strip').elementHandle();
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
            await page.waitForFunction(node => !node.isConnected, previous); await previous.dispose();
            await page.waitForFunction(value => document.querySelector('.monitor-download').textContent === value, sample.net);
            const geometry = await page.evaluate(() => {
                const n = document.querySelector('.monitor-strip');
                const rect = n => n.getBoundingClientRect().toJSON();
                return { strip: rect(n), network: rect(n.querySelector('[data-kind=network]')),
                    fontSize: getComputedStyle(n.querySelector('.monitor-chip')).fontSize,
                    networkFontSize: getComputedStyle(n.querySelector('.monitor-network-value .monitor-value')).fontSize,
                    labelAlign: getComputedStyle(n.querySelector('.monitor-label')).textAlign,
                    readings: [...n.querySelectorAll('.monitor-network-value > span')].map(rect),
                    slots: [...n.querySelectorAll('.monitor-chip, .monitor-gauge, .monitor-value, .monitor-network-value svg')].map(rect),
                    overflow: [...n.querySelectorAll('.monitor-value')].some(n => [...n.children].some(child => {
                        const r = child.getBoundingClientRect(), slot = n.getBoundingClientRect();
                        return r.left < slot.left - .1 || r.right > slot.right + .1;
                    })),
                    columns: getComputedStyle(n).gridTemplateColumns.split(' ').map(parseFloat) };
            });
            const name = `${position}-metrics-${cpu ? 'cpu' : 'no-cpu'}-${theme}-${sample.name}`;
            assert.equal(geometry.readings[0].y, geometry.readings[1].y, name + ': both NET rates remain on one line');
            assert.ok(geometry.readings[1].right <= geometry.strip.right + .1, name + ': large NET values fit the panel');
            assert.equal(geometry.overflow, false, name + ': numbers and units fit their reserved reading slots');
            if (baseline) assert.deepEqual(geometry.slots, baseline, name + ': metric columns, gauges, arrows and reading slots do not move as values change');
            else baseline = geometry.slots;
            assert.equal(geometry.fontSize, '18px');
            assert.equal(geometry.networkFontSize, vertical ? '15px' : '18px');
            if (vertical) {
                assert.equal(geometry.labelAlign, 'start', name + ': labels retain their leading-edge alignment');
                assert.ok(cpu ? geometry.network.x > geometry.strip.left : geometry.network.x === geometry.strip.left, name + ': NET follows the configured metric order');
                assert.ok(geometry.columns[cpu ? 1 : 0] > geometry.columns[cpu ? 0 : 1], name + ': the column containing NET reserves more space');
            }
            await page.locator('.topbar-right').screenshot({ path: `test-results/panel-position/${name}.png` });
        }
    }
    await page.unroute(base + '/api/metrics');
    console.log('PASS stable metric columns/readings/arrows across six value lengths, NET in either column, all four positions and both themes; 96 screenshots');
    const metrics = await (await api('/metrics')).json();
    const networks = [...new Set(['/all', ...metrics.networks.map(n => n.name), 'unavailable-net'])].slice(0, 3);
    const longDisk = metrics.disks.map(d => d.path).sort((a, b) => b.length - a.length)[0];
    const choices = [
        ['two-networks', { cpu: true, memory: true, swap: false, disks: [], networks: networks.slice(0, 2) }],
        ['networks-only', { cpu: false, memory: false, swap: false, disks: [], networks }],
        ['long-disk-network', { cpu: false, memory: false, swap: false, disks: [longDisk], networks: ['/all'] }],
        ['unavailable-labels', { cpu: false, memory: false, swap: false, disks: ['/unavailable-long-disk'], networks: ['unavailable-net'] }],
        ['swap-network', { cpu: false, memory: false, swap: true, disks: [], networks: ['/all'] }],
        ['more-selected', { cpu: true, memory: true, swap: true, disks: ['/'], networks }],
        ['empty', { cpu: false, memory: false, swap: false, disks: [], networks: [] }],
    ];
    for (const position of ['top', 'bottom', 'left', 'right']) for (const theme of ['dark', 'light']) for (const [choice, monitoring] of choices) {
        await page.goto('about:blank');
        assert.equal((await api('/settings', 'PUT', { ...fixture, panelPosition: position, theme, monitoring: { ...monitoring, interval: 2 } })).status(), 200);
        await page.goto(base); await page.locator('.monitor-summary[data-state=ready]').waitFor();
        const geometry = await page.evaluate(() => {
            const n = document.querySelector('.monitor-summary');
            const rect = node => node.getBoundingClientRect().toJSON();
            return { bounds: rect(n), items: [...n.querySelectorAll('.monitor-chip, .monitor-value, .monitor-label, .monitor-more')].map(rect),
                networks: [...n.querySelectorAll('.monitor-network-value')].map(node => [...node.children].map(rect)) };
        });
        const name = `${position}-choices-${theme}-${choice}`;
        for (const item of geometry.items) assert.ok(item.left >= geometry.bounds.left - .1 && item.right <= geometry.bounds.right + .1, name + ': every metric, label and extra count fits');
        for (const [download, upload] of geometry.networks) assert.equal(download.y, upload.y, name + ': network readings never wrap');
        if (choice === 'empty') assert.equal(await page.locator('.monitor-summary .monitor-chip').count(), 0);
        if (choice === 'more-selected') assert.equal(await page.locator('.monitor-more').textContent(), `+${networks.length}`);
        await page.locator('.topbar-right').screenshot({ path: `test-results/panel-position/${name}.png` });
    }
    console.log('PASS multiple networks, long/unavailable labels, swap, extra count and empty selection in all four positions and both themes; 56 screenshots');
    // Desktop overflow preserves the active row and its immediate successor around nested windows.
    await page.setViewportSize({ width: 900, height: 650 });
    const crowded = structuredClone(fixture);
    crowded.workspaces.push(...Array.from({ length: 8 }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}`, columns: 4, rows: 2, panels: [] })));
    crowded.workspaces[0].panels.push(...Array.from({ length: 27 }, (_, i) => ({ id: `hidden${i}`, kind: 'files', path: home, minimized: true, x: 0, y: 0, w: 1, h: 1 })));
    await page.waitForTimeout(300); await page.goto('about:blank');
    for (const position of ['left', 'right']) {
        for (const activeIndex of [0, 8, crowded.workspaces.length - 1]) {
            const workspaces = structuredClone(crowded.workspaces), activeWorkspace = workspaces.shift();
            workspaces.splice(activeIndex, 0, activeWorkspace);
            assert.equal((await api('/settings', 'PUT', { ...crowded, workspaces, panelPosition: position })).status(), 200);
            await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
            await page.waitForTimeout(350);
            const active = page.locator('.workspace-tabs > .visible-tabs > [data-workspace=overview]');
            await active.waitFor();
            const list = page.locator('.workspace-tabs'), moreDesktops = page.locator('.workspace-tab-actions > .overflow-toggle');
            assert.ok(await moreDesktops.isVisible(), 'long desktop lists use ellipsis overflow');
            assert.ok(await page.locator('.window-bar .overflow-toggle').isVisible(), 'long window lists use their own ellipsis');
            assert.ok(await page.locator('.component-tabs > .visible-tabs > .component-tab-item').count() >= 1, 'window overflow retains a visible window row');
            const bounds = await list.boundingBox(), label = await active.locator(':scope > .workspace-tab').boundingBox();
            assert.ok(label.y >= bounds.y && label.y + label.height <= bounds.y + bounds.height);
            if (activeIndex < workspaces.length - 1) {
                const next = await active.evaluate(n => n.nextElementSibling?.dataset.workspace);
                assert.equal(next, workspaces[activeIndex + 1].id, 'a following desktop always separates the two overflow buttons');
                assert.equal(await active.evaluate(n => n.nextElementSibling.nextElementSibling), null, 'overflowing windows leave only one following desktop');
            }
            const appearance = await active.evaluate(n => ({ background: getComputedStyle(n).backgroundColor,
                border: getComputedStyle(n).borderColor, highlightHeight: parseFloat(getComputedStyle(n, '::before').height),
                windows: getComputedStyle(n.querySelector('.window-bar')).backgroundColor }));
            assert.equal(appearance.background, 'rgba(0, 0, 0, 0)');
            assert.equal(appearance.border, 'rgba(0, 0, 0, 0)');
            assert.equal(appearance.windows, 'rgba(0, 0, 0, 0)');
            assert.ok(appearance.highlightHeight <= label.height + 2, 'highlight stops at the desktop button');
            if (activeIndex === 8) await page.screenshot({ path: `test-results/panel-position/${position}-separated-overflows.png` });
            await moreDesktops.click();
            const hiddenDesktop = page.locator('.overflow-tabs:popover-open > .workspace-tab-item').first();
            await hiddenDesktop.locator('.workspace-menu').click(); await page.locator('.menu-actions:popover-open').waitFor();
            await hiddenDesktop.locator('.workspace-menu').click(); assert.equal(await page.locator('.menu-actions:popover-open').count(), 0);
            const handle = await hiddenDesktop.locator('.workspace-tab').boundingBox();
            await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
            await page.evaluate(() => window.dispatchEvent(new Event('tuxee-tabs-changed')));
            await page.waitForTimeout(100);
            await page.mouse.move(label.x + label.width / 2, label.y + 2, { steps: 16 });
            await page.locator('.tab-drag-preview').waitFor();
            await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(350);
            assert.deepEqual((await snapshot()).workspaces.map(w => w.id), workspaces.map(w => w.id), 'desktop overflow drag cancels without reordering');
            if (activeIndex === 0) for (const cancel of [true, false]) {
                if (await page.locator('.overflow-tabs:popover-open').count()) await moreDesktops.click();
                const from = await active.locator(':scope > .workspace-tab').boundingBox(), toggle = await moreDesktops.boundingBox();
                await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
                await page.mouse.move(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2, { steps: 16 });
                const destination = page.locator('.overflow-tabs:popover-open > .workspace-tab-item').first();
                await destination.waitFor(); const to = await destination.boundingBox();
                await page.mouse.move(to.x + to.width / 2, to.y + to.height, { steps: 16 }); await page.waitForTimeout(220);
                const preview = page.locator('.overflow-tabs > .tab-drag-preview'); await preview.waitFor();
                assert.equal(await preview.locator('button').count(), 2);
                assert.equal(await preview.locator('.window-bar').count(), 0, 'overflow preview also excludes nested windows');
                const previewHeight = (await preview.boundingBox()).height, gapHeight = (await page.locator('.tab-placeholder').boundingBox()).height;
                assert.ok(Math.abs(previewHeight - to.height) < 1 && Math.abs(previewHeight - gapHeight) < 1, 'preview and gap match a destination menu row');
                const menuBounds = await page.locator('.overflow-tabs:popover-open').boundingBox();
                assert.ok(menuBounds.y >= 4 && menuBounds.y + menuBounds.height <= page.viewportSize().height - 4, 'incoming drag row keeps the overflow menu inside the viewport');
                if (cancel) await page.screenshot({ path: `test-results/panel-position/${position}-desktop-overflow-drag.png` });
                if (cancel) await page.keyboard.press('Escape');
                await page.mouse.up(); await page.waitForTimeout(350);
                assert.equal((await snapshot()).current, 'overview');
                assert.ok(await page.locator('.workspace-tabs > .visible-tabs > .active > .window-bar').isVisible(), 'nested windows return after overflow drag');
                if (cancel) assert.deepEqual((await snapshot()).workspaces.map(w => w.id), workspaces.map(w => w.id));
                else assert.notDeepEqual((await snapshot()).workspaces.map(w => w.id), workspaces.map(w => w.id), 'overflow drop commits desktop reorder');
            }
            await page.goto('about:blank');
        }
        await page.goto('about:blank');
        await page.setViewportSize({ width: 1280, height: 800 });
        assert.equal((await api('/settings', 'PUT', { ...crowded, workspaces: crowded.workspaces.slice(0, 4), panelPosition: position })).status(), 200);
        await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
        await page.waitForTimeout(300);
        await page.locator('[data-workspace=overview] > .workspace-tab').scrollIntoViewIfNeeded();
        const visibleWindows = page.locator('.component-tabs > .visible-tabs > .component-tab-item');
        async function checkWindowFit() {
            const { available, row, count, toggle } = await page.evaluate(() => {
                const n = document.querySelector('.component-tabs');
                return { available: n.getBoundingClientRect().height,
                    row: n.querySelector('.component-tab-item').getBoundingClientRect().height,
                    count: n.firstElementChild.children.length,
                    toggle: n.lastElementChild.getBoundingClientRect().height };
            });
            assert.equal(count, Math.floor((available - toggle) / (row + 4)), `window overflow uses every available row: ${JSON.stringify({ available, row, count, toggle })}`);
        }
        await checkWindowFit();
        const originalCount = await visibleWindows.count();
        await page.setViewportSize({ width: 1280, height: 600 }); await page.waitForTimeout(300);
        await checkWindowFit();
        assert.ok(await visibleWindows.count() < originalCount, 'shorter side panels move excess windows into overflow');
        await page.setViewportSize({ width: 1280, height: 1000 }); await page.waitForTimeout(300);
        await checkWindowFit();
        assert.ok(await visibleWindows.count() > originalCount, 'taller side panels recover window rows from overflow');
        await page.setViewportSize({ width: 1280, height: 600 }); await page.waitForTimeout(300);
        const focusedWindow = visibleWindows.first().locator('.component-tab');
        await focusedWindow.focus();
        for (let padding = 3; padding < 33; padding++) {
            await page.locator('.topbar').evaluate((n, padding) => n.style.paddingBottom = `${padding}px`, padding); await page.waitForTimeout(100);
            await checkWindowFit();
            assert.ok(await focusedWindow.evaluate(n => document.activeElement === n), 'refitting preserves window keyboard focus');
        }
        await page.locator('.topbar').evaluate(n => n.style.paddingBottom = '');
        await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(300);
        await checkWindowFit();
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
        const existingTerminals = new Set((await (await api('/terminals')).json()).map(t => t.id));
        await page.locator('.workspace-add').click();
        await page.locator('.terminal-view[data-state=connected]:visible').first().waitFor();
        await page.waitForTimeout(400);
        assert.equal((await snapshot()).workspaces.length, 5, 'Plus creates a desktop from the shared vertical footer');
        addedTerminals.push(...(await (await api('/terminals')).json()).filter(t => !existingTerminals.has(t.id)).map(t => t.id));
        await page.waitForTimeout(300); await page.goto('about:blank');
        await page.setViewportSize({ width: 900, height: 650 });
    }
    assert.deepEqual(errors, []);
    console.log('PASS separate desktop/window highlights and overflow: active successor, resizing, anchored menus, dragging and cancellation');
} catch (error) {
    if (page && await page.locator('.topbar').count()) await page.screenshot({ path: 'test-results/panel-position/failure.png' }).catch(() => {});
    throw error;
} finally {
    await page?.close();
    if (api && original) await api('/settings', 'PUT', original);
    if (api && terminal) await api(`/terminals/${terminal.id}`, 'DELETE');
    if (api) for (const id of addedTerminals) await api('/terminals/' + id, 'DELETE');
    await browser.close();
}
