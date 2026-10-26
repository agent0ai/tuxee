import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
assert.equal(spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), created = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const item = id => page.locator(`[data-panel="${id}"]`);
const rect = id => item(id).evaluate(node => ['x', 'y', 'w', 'h'].map(key => Number(node.getAttribute('gs-' + key) || (key === 'w' || key === 'h' ? 1 : 0))));
await mkdir('test-results', { recursive: true });

async function fixture(width, height, columns, rows, shapes) {
    await page.waitForTimeout(350); await page.goto('about:blank');
    for (const id of created.splice(0)) await api(`/terminals/${id}`, 'DELETE');
    await page.setViewportSize({ width, height });
    const panels = [];
    for (const [i, [x, y, w, h]] of shapes.entries()) {
        const response = await api('/terminals', 'POST', { directory: '/tmp', name: 'Terminal', columns: 80, rows: 24 });
        assert.equal(response.status(), 201);
        const terminal = await response.json(); created.push(terminal.id);
        panels.push({ id: `t${i}`, kind: 'terminal', path: '/tmp', terminal: terminal.id, x, y, w, h });
    }
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'work', workspaces: [
        { id: 'work', name: 'Work', columns, rows, active: 't0', panels },
    ] })).status(), 200);
    await page.goto(base);
    await page.waitForFunction(count => document.querySelectorAll('.terminal-view[data-state=connected]').length === count, panels.length);
    await page.waitForTimeout(250);
    return panels;
}
async function checkClose(width, height, columns, rows, shapes, closing, expected, screenshot) {
    const panels = await fixture(width, height, columns, rows, shapes);
    const survivors = panels.filter(p => !closing.includes(p.id)), nodes = new Map(), pids = new Map();
    for (const p of survivors) {
        nodes.set(p.id, await item(p.id).locator('.xterm').elementHandle());
        pids.set(p.id, (await (await api(`/terminals/${p.terminal}`)).json()).pid);
    }
    const saved = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT'
        && r.request().postDataJSON().workspaces[0].panels.length === survivors.length);
    if (closing.length === 1) await item(closing[0]).getByRole('button', { name: 'Close panel', exact: true }).click();
    else await page.evaluate(ids => ids.forEach(id => document.querySelector(`[data-panel="${id}"] [aria-label="Close panel"]`).click()), closing);
    for (const id of closing) await item(id).waitFor({ state: 'detached' });
    assert.equal((await saved).status(), 200);
    for (const [i, p] of survivors.entries()) {
        assert.deepEqual(await rect(p.id), expected[i], `${width}px ${JSON.stringify(shapes)} closing ${closing}: ${p.id}`);
        assert.ok(await nodes.get(p.id).evaluate((node, id) => node === document.querySelector(`[data-panel="${id}"] .xterm`), p.id));
        assert.equal((await (await api(`/terminals/${p.terminal}`)).json()).pid, pids.get(p.id));
    }
    const settings = (await (await api('/me')).json()).settings;
    assert.deepEqual(settings.workspaces[0].panels.map(({ x, y, w, h }) => [x, y, w, h]), expected);
    for (const p of panels.filter(p => closing.includes(p.id))) assert.equal((await api(`/terminals/${p.terminal}`)).status(), 404);
    await page.waitForTimeout(250);
    if (screenshot) await page.screenshot({ path: `test-results/${screenshot}.png` });
}
async function paint(id, color) {
    await item(id).locator('textarea').focus();
    await page.keyboard.insertText(`printf '\\033[?1049h\\033]11;${color}\\007\\033[2J\\033[HTERMINAL BACKGROUND\\033[999;1HBOTTOM ROW'`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.querySelector(`[data-panel="${id}"] .xterm-rows`).textContent.includes('BOTTOM ROW'), id);
}
async function checkSurface(id, color) {
    await page.waitForTimeout(200);
    const result = await item(id).evaluate(node => {
        const box = s => node.querySelector(s).getBoundingClientRect();
        const body = box('.panel-body'), host = box('.terminal-host'), term = box('.xterm'), screen = box('.xterm-screen');
        const row = box('.xterm-rows > div:last-child');
        return { body: body.bottom, host: host.bottom, term: term.bottom, screen: screen.bottom, rowHeight: row.height,
            color: getComputedStyle(node.querySelector('.xterm')).backgroundColor,
            viewportColor: getComputedStyle(node.querySelector('.xterm-scrollable-element')).backgroundColor,
            x: Math.floor(term.right - 20), y: Math.floor(term.bottom - 1) };
    });
    assert.ok(Math.abs(result.body - result.host) < 1 && Math.abs(result.host - result.term) < 1, 'terminal surface reaches panel bottom');
    assert.ok(result.term - result.screen >= -0.5 && result.term - result.screen < result.rowHeight, 'all rows fit and no room for another row is wasted');
    assert.equal(result.color, color, 'spare pixels match the application background');
    assert.equal(result.viewportColor, color);
    const pixel = await page.evaluate(async ({ png, x, y }) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    }, { png: (await page.screenshot()).toString('base64'), x: result.x, y: result.y });
    assert.deepEqual(pixel, color.match(/\d+/g).map(Number), 'visible bottom pixel must not be covered by a black viewport');
}
try {
    let checked = 0;
    for (const width of [1440, 1920, 2560, 3440]) for (const closed of ['t0', 't1']) {
        await checkClose(width, 1080, 4, 2, [[0, 0, 2, 2], [2, 0, 2, 2]], [closed], [[0, 0, 4, 2]],
            width === 2560 && closed === 't0' ? 'close-terminals-wide' : undefined); checked++;
    }
    for (const width of [1920, 3440]) for (const closed of ['t0', 't1', 't2']) {
        const expected = closed === 't0' ? [[0, 0, 4, 1], [0, 1, 4, 1]]
            : [[0, 0, 2, 2], [2, 0, 2, 2]];
        await checkClose(width, 1080, 4, 2, [[0, 0, 2, 2], [2, 0, 2, 1], [2, 1, 2, 1]], [closed], expected,
            width === 1920 && closed === 't0' ? 'close-terminals-stacked' : undefined); checked++;
    }
    await checkClose(3440, 1440, 4, 2, [[0, 0, 2, 1], [0, 1, 2, 1], [2, 0, 2, 2]], ['t2'], [[0, 0, 4, 1], [0, 1, 4, 1]]); checked++;
    await checkClose(3440, 1440, 4, 2, [[0, 0, 2, 2], [2, 0, 2, 1], [2, 1, 2, 1]], ['t1', 't2'], [[0, 0, 4, 2]]); checked++;
    for (const closed of ['t0', 't1']) {
        await checkClose(900, 1200, 2, 4, [[0, 0, 2, 2], [0, 2, 2, 2]], [closed], [[0, 0, 2, 4]]); checked++;
    }
    console.log(`PASS ${checked} real-browser terminal closures at desktop/ultrawide/portrait sizes, both directions, T layouts and concurrent closes; saved geometry and surviving DOM/PIDs`);
    await fixture(1920, 1080, 4, 2, [[0, 0, 2, 2], [2, 0, 2, 2]]);
    await checkSurface('t0', 'rgb(27, 34, 48)');
    await paint('t1', '#153c35'); await checkSurface('t1', 'rgb(21, 60, 53)');
    await page.screenshot({ path: 'test-results/terminal-bottom-after.png' });
    for (const theme of ['light', 'dark']) {
        await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
        await page.waitForFunction(color => getComputedStyle(document.querySelector('[data-panel=t1] .xterm')).backgroundColor === color,
            theme === 'light' ? 'rgb(248, 249, 252)' : 'rgb(27, 34, 48)');
        await paint('t1', '#153c35');
        for (const height of [900, 907, 914]) {
            await page.setViewportSize({ width: 1920, height }); await page.waitForTimeout(400);
            await checkSurface('t1', 'rgb(21, 60, 53)');
        }
        await page.screenshot({ path: `test-results/terminal-bottom-${theme}.png` });
    }
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.terminal-view[data-state=connected]').length === 2);
    await checkSurface('t1', 'rgb(21, 60, 53)');
    await paint('t1', '#36213e'); await checkSurface('t1', 'rgb(54, 33, 62)');
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    await page.locator('[data-component-name=t1]').click(); await checkSurface('t1', 'rgb(54, 33, 62)');
    await page.screenshot({ path: 'test-results/terminal-bottom-mobile.png' });
    assert.deepEqual(errors, []);
    console.log('PASS full terminal surface and unclipped bottom row through resize, themes, restored palette, live palette changes and mobile');
} finally {
    await page.waitForTimeout(350); await page.goto('about:blank');
    await api('/settings', 'PUT', original);
    for (const id of created) await api(`/terminals/${id}`, 'DELETE');
    await browser.close();
}
