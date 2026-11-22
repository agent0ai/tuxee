import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.TUXEE_TEST_URL, user = process.env.TUXEE_TEST_USER, password = process.env.TUXEE_TEST_PASSWORD;
assert.ok(base && user && password, 'supply the isolated server and marked test account');
const container = process.env.TUXEE_TEST_CONTAINER;
const account = spawnSync(container ? 'docker' : 'getent', container ? ['exec', container, 'getent', 'passwd', user] : ['passwd', user], { encoding: 'utf8' });
assert.equal(account.status, 0); assert.equal(account.stdout.trim().split(':')[4], 'Tuxee prototype test');
const output = 'test-results/panel-fitting', results = [], screenshots = [], terminals = [];
await mkdir(output, { recursive: true });
let browser, display, context, page, api, original, screenshotSession, loaded;
const env = { ...process.env };
for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete env[key];
try {
    display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '2560x2160x24', '-nolisten', 'tcp', '-ac'], { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    env.DISPLAY = await new Promise((resolve, reject) => {
        display.stdio[3].once('data', data => resolve(':' + String(data).trim()));
        display.once('exit', () => reject(Error('Xvfb failed')));
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false, args: ['--no-sandbox', '--window-position=0,0', '--window-size=1280,880'], env });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const me = await (await context.request.get(base + '/api/me')).json(); original = me.settings;
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf } });
    for (let i = 0; i < 3; i++) {
        const response = await api('/terminals', 'POST', { directory: '/tmp', name: `Terminal ${i + 1}`, columns: 80, rows: 24 });
        assert.equal(response.status(), 201); terminals.push(await response.json());
    }
    const errors = []; page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const metrics = await context.newCDPSession(page), home = account.stdout.trim().split(':')[5];
    screenshotSession = metrics;
    const fixture = (count, position, desktopCount = 4, active = 2, theme = 'dark', marker) => ({ theme, howToSeen: true, serverColor: marker, panelPosition: position, current: `desktop${active}`,
        workspaces: Array.from({ length: desktopCount }, (_, i) => ({ id: `desktop${i}`, name: ['Overview', 'Development', 'Operations', 'Files'][i] || `Desktop ${i + 1}`, columns: 4, rows: 2,
            panels: i !== active ? [] : [{ id: 'browser', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }, ...Array.from({ length: count }, (_, j) => ({ id: `window${j}`, kind: j >= 2 && j <= 4 ? 'terminal' : 'files', terminal: j >= 2 && j <= 4 ? terminals[j - 2].id : undefined, path: [home, '/etc', '/usr', '/home'][j % 4], minimized: true, x: 0, y: 0, w: 1, h: 1 }))] })) });
    async function load(data) {
        loaded = data;
        await page.goto('about:blank'); assert.equal((await api('/settings', 'PUT', data)).status(), 200);
        await page.goto(base); await page.locator(data.monitoring?.hidden ? '#app.side-panel .topbar-right' : '#app.side-panel .monitor-summary[data-state=ready]').waitFor(); await page.waitForTimeout(250);
    }
    async function check(name, count) {
        const geometry = await page.evaluate(() => {
            const rect = n => n.getBoundingClientRect();
            const host = document.querySelector('.component-tabs'), visible = [...host.firstElementChild.children], more = host.lastElementChild;
            const active = document.querySelector('.workspace-tabs > .visible-tabs > .active'), next = active?.nextElementSibling;
            const end = more.hidden ? visible.at(-1) : more;
            const plus = document.querySelector('.workspace-add'), controls = document.querySelector('.topbar-right');
            const desktopList = document.querySelector('.workspace-tabs > .visible-tabs'), desktops = [...desktopList.children];
            const highlight = active && getComputedStyle(active, '::before'), highlightHeight = highlight && parseFloat(highlight.height) + (highlight.boxSizing === 'border-box' ? 0 : parseFloat(highlight.borderTopWidth) + parseFloat(highlight.borderBottomWidth));
            const highlightTop = active && rect(active).top + parseFloat(getComputedStyle(active).borderTopWidth) + parseFloat(highlight.top);
            const desktopMore = document.querySelector('.workspace-tab-actions > .overflow-toggle');
            const topbar = document.querySelector('.topbar'), actions = document.querySelector('.workspace-tab-actions');
            return { desktops: desktops.map(n => n.dataset.workspace), following: desktops.slice(desktops.indexOf(active) + 1).map(n => n.dataset.workspace),
                desktopOverflow: !desktopMore.hidden, actions: [rect(desktopMore).toJSON(), rect(plus).toJSON()], count: visible.length, overflow: !more.hidden, row: visible.length ? rect(visible[0]).height : 25,
                gap: next && end ? rect(next).top - rect(end).bottom : 0,
                slack: rect(controls).top - rect(actions).bottom,
                bottomGap: rect(topbar).bottom - rect(controls).bottom - parseFloat(getComputedStyle(topbar).paddingBottom),
                controlRowGap: parseFloat(getComputedStyle(controls).rowGap), actionsGap: rect(actions).top - rect(desktopList).bottom,
                rowGap: parseFloat(getComputedStyle(host.firstElementChild).rowGap),
                controlsClipped: rect(controls).bottom > innerHeight + .1,
                clipped: visible.some(n => rect(n).bottom > rect(host).bottom + .1),
                origin: [scrollX, scrollY], viewport: [innerWidth, innerHeight], zoom: devicePixelRatio,
                highlightHeight, desktopClipped: desktops.some(n => rect(n).bottom > rect(desktopList).bottom + .1),
                highlightClipped: active && highlightTop + highlightHeight > rect(desktopList).bottom + .1,
                activeVisible: !!active && rect(active).height > 0, nextVisible: !next || rect(next).height > 0 };
        });
        try {
            assert.equal(geometry.clipped, false, name + ': a visible window must be fully visible');
            assert.equal(geometry.desktopClipped, false, name + ': desktop rows must be fully visible');
            assert.equal(geometry.highlightClipped, false, name + ': the complete rounded active border must fit');
            assert.ok(geometry.gap <= 4.1, name + ': next desktop must follow the last window/ellipsis without empty rows: ' + JSON.stringify(geometry));
            assert.ok(Math.abs(geometry.bottomGap) < .1, name + ': controls stay at the viewport bottom: ' + JSON.stringify(geometry));
            assert.ok(geometry.controlRowGap === 0 && Math.abs(geometry.actionsGap) < .1, name + ': no extra vertical space around ellipsis/Plus or between bottom control rows: ' + JSON.stringify(geometry));
            assert.equal(geometry.controlsClipped, false, name + ': every bottom control fits');
            if (geometry.overflow) {
                assert.ok(count - geometry.count >= 2, name + ': show the last window instead of an equally tall ellipsis');
                assert.ok(geometry.slack < geometry.row + geometry.rowGap + .1, name + ': available sidebar space must fit another window: ' + JSON.stringify(geometry));
            } else assert.equal(geometry.count, count, name + ': all windows must be accounted for');
            const activeIndex = loaded.workspaces.findIndex(w => w.id === loaded.current), successor = loaded.workspaces[activeIndex + 1]?.id;
            if (successor) assert.equal(geometry.following[0], successor, name + ': immediate successor stays visible');
            if (geometry.overflow) assert.deepEqual(geometry.following, successor ? [successor] : [], name + ': extra later desktops cannot squeeze overflowing windows');
            if (geometry.desktopOverflow) {
                const [more, plus] = geometry.actions;
                assert.ok(Math.abs(more.y - plus.y) < .1 && more.right <= plus.x && more.width > 40 && plus.width > 40, name + ': ellipsis and Plus share a usable row');
                if (geometry.following.length && !geometry.overflow) assert.ok(geometry.slack < 35.1, name + ': an additional desktop must appear when a row is free');
            }
            assert.deepEqual(geometry.origin, [0, 0]); assert.ok(geometry.activeVisible && geometry.nextVisible);
        } catch (error) { console.error(name, geometry); await page.screenshot({ path: output + '/failure.png' }); throw error; }
        results.push({ name, ...geometry });
        {
            const file = `${name}.png`, clip = await page.locator('.topbar').boundingBox();
            clip.height = Math.min(clip.height, geometry.viewport[1]);
            // Native Chrome zoom changes DOM coordinates; screenshot clips still use the window's unzoomed pixels.
            for (const key of ['x', 'y', 'width', 'height']) clip[key] *= geometry.zoom;
            const shot = await screenshotSession.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
            await writeFile(output + '/' + file, Buffer.from(shot.data, 'base64')); screenshots.push(file);
        }
        return geometry;
    }
    async function resize(height) {
        const changed = await page.evaluate(height => { window.fittingHeader = document.querySelector('.topbar'); return innerHeight !== height; }, height);
        await metrics.send('Emulation.setDeviceMetricsOverride', { width: 1280, height, deviceScaleFactor: 1, mobile: false });
        await page.waitForFunction(height => innerHeight === height, height);
        if (changed) await page.waitForFunction(() => document.querySelector('.topbar') !== window.fittingHeader);
        else await page.waitForTimeout(150);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    }
    // Counts near overflow boundaries and uneven heights catch wasted rows independently of the list's own height.
    for (const position of ['left', 'right']) for (const count of Array.from({ length: 32 }, (_, i) => i)) {
        await load(fixture(count, position));
        for (const height of [480, 501, 539, 580, 631, 670, 701, 769, 800, 901, 960, 1080]) {
            await resize(height);
            await check(`${position}-${count}w-${height}h`, count);
        }
        console.log(`PASS ${position}: ${count} windows across 12 viewport heights`);
    }
    for (const position of ['left', 'right']) for (const [desktops, active] of [[1, 0], [2, 0], [2, 1], [4, 0], [4, 3], [16, 0], [16, 8], [16, 15], [32, 0], [32, 16], [32, 31]]) {
        await load(fixture(12, position, desktops, active, 'light', '#a58aeb'));
        for (const height of [500, 650, 800, 1000]) {
            await resize(height);
            await check(`${position}-${desktops}d-${active}active-${height}h`, 12);
        }
    }
    for (const position of ['left', 'right']) for (let desktops = 1; desktops <= 32; desktops++) for (const count of [0, 1, 31]) {
        await resize(800);
        await load(fixture(count, position, desktops, desktops - 1, desktops % 2 ? 'dark' : 'light'));
        const state = await check(`${position}-all-counts-${desktops}d-${count}w`, count);
        if (desktops <= 2) assert.equal(state.desktops.length, desktops, 'sparse desktop lists never overflow');
    }
    // Later desktops consume only space left after the windows; never cap a roomy list to one successor.
    for (const position of ['left', 'right']) for (const active of [0, 2]) for (const count of [0, 1, 5, 12, 29]) {
        for (const height of [501, 800, 1080]) {
            await resize(height);
            await load(fixture(count, position, active + 2, active));
            const baseline = await check(`${position}-priority-${active}active-${count}w-${height}h-base`, count);
            await load(fixture(count, position, 16, active));
            const crowded = await check(`${position}-priority-${active}active-${count}w-${height}h-crowded`, count);
            assert.equal(crowded.count, baseline.count, 'adding later desktops must not take visible window rows');
            if (count <= 1 && height === 1080) assert.equal(crowded.desktops.length, 16, 'all desktops remain visible when everything fits');
        }
    }
    // Hidden resources must return their space to windows without leaving gaps around the control rows.
    for (const position of ['left', 'right']) for (const theme of ['dark', 'light']) for (const active of [0, 5, 11]) for (const count of [1, 4, 12, 31]) {
        const data = fixture(count, position, 12, active, theme);
        data.monitoring = { hidden: true, cpu: true, memory: true, swap: false, disks: ['/'], networks: ['/all'], interval: 2 };
        await resize(650); await load(data);
        await check(`${position}-hidden-monitor-${theme}-${active}active-${count}w`, count);
    }
    for (const position of ['left', 'right']) for (const theme of ['dark', 'light']) {
        await resize(650); await load(fixture(31, position, 4, 2, theme));
        const before = await check(`${position}-${theme}-monitor-shown`, 31);
        for (const hidden of [true, false]) {
            await page.locator('.brand-button').click();
            await page.locator('.start-menu [data-action=Activity]').click();
            await page.locator('.monitor-display input').setChecked(!hidden);
            await page.waitForFunction(() => !document.querySelector('.monitor-display input').disabled);
            await page.locator('dialog:open .modal-head > button').last().click();
            await page.waitForTimeout(250);
            const state = await check(`${position}-${theme}-monitor-${hidden ? 'hidden' : 'restored'}`, 31);
            if (hidden) assert.ok(state.count > before.count, 'hiding resources immediately returns rows to windows');
            else assert.equal(state.count, before.count, 'showing resources reserves their rows again');
        }
    }
    // Native browser zoom, not CSS zoom or only a scaled screenshot.
    await page.goto('about:blank');
    const zoomContext = await browser.newContext({ storageState: await context.storageState(), viewport: null });
    page = await zoomContext.newPage(); page.on('pageerror', e => errors.push(e.message));
    screenshotSession = await zoomContext.newCDPSession(page);
    const { windowId } = await screenshotSession.send('Browser.getWindowForTarget');
    await screenshotSession.send('Browser.setWindowBounds', { windowId, bounds: { width: 2400, height: 1800 } });
    const keys = key => { const result = spawnSync('xdotool', ['key', '--clearmodifiers', key], { env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    for (const position of ['left', 'right']) for (const [count, desktops] of [[0, 1], [0, 2], [1, 1], [1, 2], [1, 32], [7, 4], [9, 16], [12, 4], [12, 32], [31, 32]]) {
        await load(fixture(count, position, desktops, Math.min(2, desktops - 1), position === 'left' ? 'dark' : 'light')); await page.bringToFront();
        for (const [zoom, steps] of [[.8, -2], [.9, -1], [1, 0], [1.1, 1], [1.25, 2], [1.5, 3], [1.75, 4], [2, 5]]) {
            await page.evaluate(() => { window.fittingHeader = document.querySelector('.topbar'); });
            keys('ctrl+0'); for (let i = 0; i < Math.abs(steps); i++) keys(steps < 0 ? 'ctrl+minus' : 'ctrl+plus');
            await page.waitForFunction(zoom => Math.abs(devicePixelRatio - zoom) < .02 && document.querySelector('.topbar') !== window.fittingHeader, zoom);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
            await page.waitForTimeout(200);
            assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - zoom) < .02, 'native browser zoom actually changed');
            await check(`${position}-${count}w-${desktops}d-zoom${Math.round(zoom * 100)}`, count);
        }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${results.length} fitting cases; ${screenshots.length} screenshots; native browser zoom 80–200%; no page errors.`);
} finally {
    await writeFile(output + '/results.json', JSON.stringify({ results, screenshots }, null, 2));
    await page?.goto('about:blank').catch(() => {});
    if (api && original) await api('/settings', 'PUT', original);
    if (api) for (const terminal of terminals) await api('/terminals/' + terminal.id, 'DELETE');
    await browser?.close(); display?.kill();
}
