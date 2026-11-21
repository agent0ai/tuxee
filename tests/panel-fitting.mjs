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
let browser, display, context, page, api, original, screenshotSession;
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
    const fixture = (count, position, desktopCount = 4, active = 2, theme = 'dark') => ({ theme, howToSeen: true, serverColor: '#a58aeb', panelPosition: position, current: `desktop${active}`,
        workspaces: Array.from({ length: desktopCount }, (_, i) => ({ id: `desktop${i}`, name: ['Overview', 'Development', 'Operations', 'Files'][i] || `Desktop ${i + 1}`, columns: 4, rows: 2,
            panels: i !== active ? [] : [{ id: 'browser', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }, ...Array.from({ length: count }, (_, j) => ({ id: `window${j}`, kind: j >= 2 && j <= 4 ? 'terminal' : 'files', terminal: j >= 2 && j <= 4 ? terminals[j - 2].id : undefined, path: [home, '/etc', '/usr', '/home'][j % 4], minimized: true, x: 0, y: 0, w: 1, h: 1 }))] })) });
    async function load(data) {
        await page.goto('about:blank'); assert.equal((await api('/settings', 'PUT', data)).status(), 200);
        await page.goto(base); await page.locator('#app.side-panel .monitor-summary[data-state=ready]').waitFor(); await page.waitForTimeout(250);
    }
    async function check(name, count, capture = false) {
        const geometry = await page.evaluate(() => {
            const rect = n => n.getBoundingClientRect();
            const host = document.querySelector('.component-tabs'), visible = [...host.firstElementChild.children], more = host.lastElementChild;
            const active = document.querySelector('.workspace-tabs > .visible-tabs > .active'), next = active.nextElementSibling;
            const end = more.hidden ? visible.at(-1) : more;
            const plus = document.querySelector('.workspace-controls > button'), controls = document.querySelector('.topbar-right');
            return { count: visible.length, overflow: !more.hidden, row: visible.length ? rect(visible[0]).height : 25,
                gap: next && end ? rect(next).top - rect(end).bottom : 0,
                slack: rect(controls).top - rect(plus).bottom - parseFloat(getComputedStyle(document.querySelector('.topbar')).gap),
                clipped: visible.some(n => rect(n).bottom > rect(host).bottom + .1),
                origin: [scrollX, scrollY], viewport: [innerWidth, innerHeight], zoom: devicePixelRatio,
                activeVisible: rect(active).height > 0, nextVisible: !next || rect(next).height > 0 };
        });
        try {
            assert.equal(geometry.clipped, false, name + ': a visible window must be fully visible');
            assert.ok(geometry.gap <= 8.1, name + ': next desktop must follow the last window/ellipsis without empty rows: ' + JSON.stringify(geometry));
            if (geometry.overflow) {
                assert.ok(count - geometry.count >= 2, name + ': show the last window instead of an equally tall ellipsis');
                assert.ok(geometry.slack < geometry.row + 4 + .1, name + ': available sidebar space must fit another window: ' + JSON.stringify(geometry));
            } else assert.equal(geometry.count, count, name + ': all windows must be accounted for');
            assert.deepEqual(geometry.origin, [0, 0]); assert.ok(geometry.activeVisible && geometry.nextVisible);
        } catch (error) { await page.screenshot({ path: output + '/failure.png' }); throw error; }
        results.push({ name, ...geometry });
        if (capture) {
            const file = `${name}.png`, clip = await page.locator('.topbar').boundingBox();
            clip.height = Math.min(clip.height, geometry.viewport[1]);
            // Native Chrome zoom changes DOM coordinates; screenshot clips still use the window's unzoomed pixels.
            for (const key of ['x', 'y', 'width', 'height']) clip[key] *= geometry.zoom;
            const shot = await screenshotSession.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
            await writeFile(output + '/' + file, Buffer.from(shot.data, 'base64')); screenshots.push(file);
        }
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
    for (const position of ['left', 'right']) for (const count of [0, 1, 2, 5, 7, 8, 9, 10, 11, 12, 16, 24, 29]) {
        await load(fixture(count, position));
        for (const height of [480, 501, 539, 580, 631, 670, 701, 769, 800, 901, 960, 1080]) {
            await resize(height);
            await check(`${position}-${count}w-${height}h`, count, [5, 9, 12, 29].includes(count) && [501, 631, 800, 960].includes(height));
        }
        console.log(`PASS ${position}: ${count} windows across 12 viewport heights`);
    }
    for (const position of ['left', 'right']) for (const [desktops, active] of [[1, 0], [4, 0], [4, 3], [16, 0], [16, 8], [16, 15]]) {
        await load(fixture(12, position, desktops, active, 'light'));
        for (const height of [500, 650, 800, 1000]) {
            await resize(height);
            await check(`${position}-${desktops}d-${active}active-${height}h`, 12, height === 650);
        }
    }
    // Native browser zoom, not CSS zoom or only a scaled screenshot.
    await page.goto('about:blank');
    const zoomContext = await browser.newContext({ storageState: await context.storageState(), viewport: null });
    page = await zoomContext.newPage(); page.on('pageerror', e => errors.push(e.message));
    screenshotSession = await zoomContext.newCDPSession(page);
    const keys = key => { const result = spawnSync('xdotool', ['key', '--clearmodifiers', key], { env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
    for (const position of ['left', 'right']) for (const count of [7, 9, 12, 29]) {
        await load(fixture(count, position, 4, 2, position === 'left' ? 'dark' : 'light')); await page.bringToFront();
        for (const [zoom, steps] of [[.8, -2], [.9, -1], [1, 0], [1.1, 1], [1.25, 2], [1.5, 3]]) {
            await page.evaluate(() => { window.fittingHeader = document.querySelector('.topbar'); });
            keys('ctrl+0'); for (let i = 0; i < Math.abs(steps); i++) keys(steps < 0 ? 'ctrl+minus' : 'ctrl+plus');
            await page.waitForFunction(zoom => Math.abs(devicePixelRatio - zoom) < .02 && document.querySelector('.topbar') !== window.fittingHeader, zoom);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
            await page.waitForTimeout(200);
            assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - zoom) < .02, 'native browser zoom actually changed');
            await check(`${position}-${count}w-zoom${Math.round(zoom * 100)}`, count, true);
        }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${results.length} fitting cases; ${screenshots.length} screenshots; native browser zoom 80–150%; no page errors.`);
} finally {
    await writeFile(output + '/results.json', JSON.stringify({ results, screenshots }, null, 2));
    await page?.goto('about:blank').catch(() => {});
    if (api && original) await api('/settings', 'PUT', original);
    if (api) for (const terminal of terminals) await api('/terminals/' + terminal.id, 'DELETE');
    await browser?.close(); display?.kill();
}
