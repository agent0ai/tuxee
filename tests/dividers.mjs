import './shared-layout.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
assert.equal(spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const terminalResponse = await api('/terminals', 'POST', { directory: '/tmp', name: 'Divider test', columns: 80, rows: 24 });
assert.equal(terminalResponse.status(), 201);
const terminal = await terminalResponse.json();
const neighborResponse = await api('/terminals', 'POST', { directory: '/tmp', name: 'Neighbor test', columns: 80, rows: 24 });
assert.equal(neighborResponse.status(), 201);
const neighbor = await neighborResponse.json();
const addedTerminals = [];
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
    window.geometryFrames = {};
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
        if (this.dataset.panel && Array.isArray(frames) && frames[0]?.width) window.geometryFrames[this.dataset.panel] = frames;
        return animate.call(this, frames, options);
    };
});
const panel = (id, x, y, w, h) => ({ id, kind: id === 'a' ? 'terminal' : 'files', path: '/tmp', ...(id === 'a' ? { terminal: terminal.id } : {}), x, y, w, h });
const item = id => page.locator(`[data-panel="${id}"]`);
const rect = id => item(id).evaluate(node => ['x', 'y', 'w', 'h'].map(key => Number(node.getAttribute('gs-' + key) || (key === 'w' || key === 'h' ? 1 : 0))));
async function resizePoint(handle) {
    return handle.evaluate(node => {
        const r = node.getBoundingClientRect();
        for (const [x, y] of [[r.right - 2, r.bottom - 2], [r.left + 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]]) {
            if (document.elementFromPoint(x, y) === node) return { x, y };
        }
        throw Error('no exposed resize grip: ' + node.className);
    });
}
async function fixture(panels, portrait = false, mode = 0) {
    await page.waitForTimeout(350); await page.goto('about:blank');
    await page.setViewportSize(portrait ? { width: 900, height: 1200 } : { width: 1440, height: 1000 });
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'work', workspaces: [{ id: 'work', name: 'Work', columns: portrait ? 2 : 4, rows: portrait ? 4 : 2, active: 'a', panels, ...(mode ? { layout: { mode, custom: panels.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) } } : {}) }] })).status(), 200);
    await page.goto(base);
    await item('a').locator('.terminal-view[data-state=connected]').waitFor();
}
async function drag(handle, dx, dy, cancel = false) {
    const box = await handle.boundingBox();
    await page.evaluate(() => { delete window.geometryFrames.a; });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 });
    const live = await item('a').boundingBox();
    const highlight = await handle.boundingBox(), axis = await handle.getAttribute('data-axis');
    assert.ok(await handle.evaluate(node => node.classList.contains('divider-active')), 'keep the captured handle highlighted');
    assert.ok(Math.abs(highlight.x + highlight.width / 2 - (axis === 'y' ? box.x + box.width / 2 : live.x + live.width)) < 2, 'highlight follows the live vertical boundary');
    assert.ok(Math.abs(highlight.y + highlight.height / 2 - (axis === 'x' ? box.y + box.height / 2 : live.y + live.height)) < 2, 'highlight follows the live horizontal boundary');
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (!cancel) {
        const frames = await page.evaluate(() => window.geometryFrames.a);
        if (frames?.length) assert.ok(Math.abs(parseFloat(frames[0].width) - live.width) < 2);
        else {
            const settled = await item('a').boundingBox();
            assert.ok(['x', 'y', 'width', 'height'].every(key => Math.abs(settled[key] - live[key]) < 2), 'a release already on the grid needs no animation');
        }
    }
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.divider-active').count(), 0, 'release/cancellation clears the active highlight');
}
try {
    await mkdir('test-results', { recursive: true });
    for (const [width, height] of [[1440, 1000], [2560, 1080], [900, 1200], [390, 844]]) {
        const portrait = height > width;
        for (const kind of ['files', 'terminal']) {
            const panels = portrait ? [panel('a', 0, 1, 2, 1)] : [panel('a', 1, 0, 1, 2), panel('b', 0, 1, 1, 1)];
            await fixture(panels, portrait, 1);
            await page.setViewportSize({ width, height });
            await page.waitForFunction(compact => document.querySelector('#app').classList.contains('compact') === compact, width < 760);
            const originalTerminal = await item('a').locator('.xterm').elementHandle();
            const created = kind === 'terminal' ? page.waitForResponse(response => response.url().endsWith('/api/terminals') && response.request().method() === 'POST') : undefined;
            await page.getByRole('button', { name: kind === 'files' ? 'Add file browser' : 'Add terminal', exact: true }).click();
            if (created) {
                const response = await created; assert.equal(response.status(), 201);
                const info = await response.json(); addedTerminals.push(info.id);
                await page.locator(`.terminal-view[data-terminal="${info.id}"][data-state=connected]`).waitFor();
            }
            const added = page.locator('[data-panel]:not([data-panel=a]):not([data-panel=b])');
            await added.waitFor();
            const id = await added.getAttribute('data-panel');
            const expected = [portrait ? 0 : 2, portrait ? 2 : 0, kind === 'files' ? 1 : 2, 2];
            assert.deepEqual(await rect(id), expected, `${width}x${height} ${kind} uses the largest suitable gap`);
            for (const p of panels) assert.deepEqual(await rect(p.id), [p.x, p.y, p.w, p.h]);
            assert.ok(await originalTerminal.evaluate(node => node === document.querySelector('[data-panel=a] .xterm')));
            assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
            if (width >= 760) assert.equal(await page.locator('.layout-cycle').getAttribute('data-mode'), '0');
            if (width === 1440) await page.screenshot({ path: `test-results/add-${kind}-free-space.png` });
            await page.waitForTimeout(400); await page.reload(); await added.waitFor();
            assert.deepEqual(await rect(id), expected, 'expanded size persists after reload');
            assert.equal((await (await api('/me')).json()).settings.workspaces[0].layout, undefined, 'adding resets the saved automatic layout');
            if (width < 760) assert.equal(await page.locator('[data-panel]:visible').getAttribute('data-panel'), id, 'activate the added compact component');
        }
    }
    console.log('PASS new terminals maximize free area and file browsers grow vertically on desktop, ultrawide, portrait and mobile; neighbors, PIDs and saved sizes survive');
    const resizeCases = [
        { name: 'exposed east edge', edge: 'e', panels: [panel('a', 0, 0, 1, 2), panel('b', 3, 0, 1, 2)], dx: .8, dy: 0, expected: [[0, 0, 2, 2], [3, 0, 1, 2]] },
        { name: 'exposed west edge', edge: 'w', panels: [panel('a', 3, 0, 1, 2), panel('b', 0, 0, 1, 2)], dx: -.8, dy: 0, expected: [[2, 0, 2, 2], [0, 0, 1, 2]] },
        { name: 'exposed south edge', edge: 's', portrait: true, panels: [panel('a', 0, 0, 2, 1), panel('b', 0, 3, 2, 1)], dx: 0, dy: .8, expected: [[0, 0, 2, 2], [0, 3, 2, 1]] },
        { name: 'east corner trim', edge: 'se', panels: [panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)], dx: .8, dy: 0, expected: [[0, 0, 3, 2], [3, 0, 1, 2]] },
        { name: 'west corner trim', edge: 'sw', panels: [panel('a', 2, 0, 2, 2), panel('b', 0, 0, 2, 2)], dx: -.8, dy: 0, expected: [[1, 0, 3, 2], [0, 0, 1, 2]] },
        { name: 'portrait south corner trim', edge: 'se', portrait: true, panels: [panel('a', 0, 0, 2, 2), panel('b', 0, 2, 2, 2)], dx: 0, dy: .8, expected: [[0, 0, 2, 3], [0, 3, 2, 1]] },
        { name: 'relocate', edge: 'se', panels: [panel('a', 0, 0, 1, 1), panel('b', 1, 0, 1, 1), panel('c', 2, 0, 2, 2)], dx: .8, dy: 0, expected: [[0, 0, 2, 1], [1, 1, 1, 1], [2, 0, 2, 2]] },
        { name: 'move and shrink', edge: 'se', panels: [panel('a', 0, 0, 1, 1), panel('b', 1, 0, 2, 1), panel('c', 0, 1, 2, 1), panel('d', 3, 0, 1, 2)], dx: 1.8, dy: 0, expected: [[0, 0, 3, 1], [2, 1, 1, 1], [0, 1, 2, 1], [3, 0, 1, 2]] },
        { name: 'southwest', edge: 'sw', panels: [panel('a', 2, 0, 2, 1), panel('b', 1, 0, 1, 1), panel('c', 0, 0, 1, 2)], dx: -.8, dy: 0, expected: [[1, 0, 3, 1], [1, 1, 1, 1], [0, 0, 1, 2]] },
        { name: 'two axes and blockers', edge: 'se', panels: [panel('a', 0, 0, 1, 1), panel('b', 1, 0, 1, 1), panel('c', 0, 1, 1, 1)], dx: .8, dy: .8, expected: [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1]] },
        { name: 'full grid', edge: 'se', panels: Array.from({ length: 8 }, (_, i) => panel(String.fromCharCode(97 + i), i % 4, Math.floor(i / 4), 1, 1)), dx: .8, dy: 0, invalid: true },
        { name: 'same cell', edge: 'se', panels: [panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)], dx: -.1, dy: -.1, expected: [[0, 0, 2, 2], [2, 0, 2, 2]], unchanged: true },
        { name: 'minimum', edge: 'se', panels: [panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)], dx: -8, dy: -8, expected: [[0, 0, 1, 1], [2, 0, 2, 2]] },
        { name: 'bounds', edge: 'se', panels: [panel('a', 1, 0, 1, 1), panel('b', 0, 0, 1, 2)], dx: 8, dy: 8, expected: [[1, 0, 3, 2], [0, 0, 1, 2]] },
    ];
    for (const test of resizeCases) {
        const panels = test.panels.map(p => p.id === 'b' ? { ...p, kind: 'terminal', terminal: neighbor.id } : p);
        await fixture(panels, test.portrait, 1);
        await item('b').locator('.terminal-view[data-state=connected]').waitFor();
        const originals = await Promise.all(['a', 'b'].map(id => item(id).locator('.xterm').elementHandle()));
        const bounds = await page.locator('.grid-stack').boundingBox();
        const grip = await resizePoint(item('a').locator(`.panel-resize-${test.edge}`));
        await page.mouse.move(grip.x, grip.y); await page.mouse.down();
        await page.mouse.move(grip.x + test.dx * bounds.width / (test.portrait ? 2 : 4),
            grip.y + test.dy * bounds.height / (test.portrait ? 4 : 2), { steps: 6 });
        const preview = page.locator('.dock-preview[data-edge=resize]'); await preview.waitFor();
        assert.equal(await preview.evaluate(node => node.classList.contains('invalid')), !!test.invalid, test.name);
        for (const p of panels) assert.deepEqual(await rect(p.id), [p.x, p.y, p.w, p.h], 'preview preserves saved geometry');
        const live = await item('a').boundingBox();
        await page.mouse.up(); await page.waitForTimeout(220);
        const expected = test.expected || panels.map(p => [p.x, p.y, p.w, p.h]);
        for (let i = 0; i < panels.length; i++) assert.deepEqual(await rect(panels[i].id), expected[i], test.name);
        const frames = await page.evaluate(() => window.geometryFrames.a);
        const settled = await item('a').boundingBox();
        if (['x', 'y', 'width', 'height'].some(key => Math.abs(live[key] - settled[key]) > 2)) {
            assert.ok(frames?.length, 'animate the resized window into its snapped size');
            for (const key of ['width', 'height']) assert.ok(Math.abs(parseFloat(frames[0][key]) - live[key]) < 2, 'animate from the exact released dimensions');
            assert.ok(!frames[0].transform.includes('scale'), 'never scale terminal text');
        }
        if (expected[1].some((n, i) => n !== [panels[1].x, panels[1].y, panels[1].w, panels[1].h][i]))
            assert.ok(await page.evaluate(() => window.geometryFrames.b?.length), 'animate the affected neighbor');
        for (let i = 0; i < 2; i++) assert.ok(await originals[i].evaluate((node, id) => node === document.querySelector(`[data-panel=${id}] .xterm`), i ? 'b' : 'a'));
        assert.equal(await page.locator('.layout-cycle').getAttribute('data-mode'), test.invalid || test.unchanged ? '1' : '0');
        assert.equal(await page.locator('.resizing-panel, .panel-dragging, .dock-preview').count(), 0);
        if (test.name === 'move and shrink') await page.screenshot({ path: 'test-results/resize-move-and-shrink.png' });
        await page.waitForTimeout(350); await page.reload(); await item('b').locator('.terminal-view[data-state=connected]').waitFor();
        for (let i = 0; i < panels.length; i++) assert.deepEqual(await rect(panels[i].id), expected[i], `${test.name} persists`);
    }
    for (const cancel of ['Escape', 'blur', 'pointercancel', 'resize']) {
        await fixture([panel('a', 0, 0, 1, 1), panel('b', 1, 0, 1, 1)], false, 1);
        const bounds = await page.locator('.grid-stack').boundingBox(), grip = await resizePoint(item('a').locator('.panel-resize-se'));
        await page.mouse.move(grip.x, grip.y); await page.mouse.down();
        await page.mouse.move(grip.x + bounds.width * .2, grip.y, { steps: 4 });
        await page.locator('.dock-preview[data-edge=resize]:not(.invalid)').waitFor();
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        else if (cancel === 'pointercancel') await item('a').locator('.panel-resize-se').dispatchEvent('pointercancel');
        else if (cancel === 'resize') await page.setViewportSize({ width: 1500, height: 1000 });
        else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await page.mouse.up(); await page.waitForTimeout(220);
        assert.deepEqual(await rect('a'), [0, 0, 1, 1]); assert.deepEqual(await rect('b'), [1, 0, 1, 1]);
        assert.equal(await page.locator('.layout-cycle').getAttribute('data-mode'), '1');
        assert.equal(await page.locator('.resizing-panel, .panel-dragging, .dock-preview').count(), 0);
    }
    assert.equal((await (await api(`/terminals/${neighbor.id}`)).json()).pid, neighbor.pid);
    await fixture([panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)]);
    const fileNode = await item('b').locator('.file-view').elementHandle();
    const fileGrip = await resizePoint(item('b').locator('.panel-resize-sw')), fileGrid = await page.locator('.grid-stack').boundingBox();
    await page.mouse.move(fileGrip.x, fileGrip.y); await page.mouse.down();
    await page.mouse.move(fileGrip.x - fileGrid.width * .2, fileGrip.y, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(220);
    assert.deepEqual(await rect('a'), [0, 0, 1, 2]); assert.deepEqual(await rect('b'), [1, 0, 3, 2]);
    assert.ok(await fileNode.evaluate(node => node === document.querySelector('[data-panel=b] .file-view')));
    console.log('PASS panel edge/corner resize: trim, relocate, move/shrink, two blockers, bounds/minimums, rejection, cancellation, animation, DOM/PTY identity and persistence');
    await fixture([panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)]);
    assert.equal(await page.locator('.layout-cycle').getAttribute('title'), 'Auto layout');
    await page.locator('.monitor-controls').waitFor({ state: 'visible' });
    for (const section of ['.panel-additions', '.monitor-controls']) {
        const spacing = await page.locator(section).evaluate(node => {
            const style = getComputedStyle(node), next = node.nextElementSibling;
            return { margin: parseFloat(style.marginRight), padding: parseFloat(style.paddingRight), gap: next.getBoundingClientRect().left - node.getBoundingClientRect().right };
        });
        assert.deepEqual(spacing, { margin: 0, padding: 3, gap: 3 }, `${section} separator has equal compact spacing on either side`);
    }
    const node = await item('a').elementHandle(), grid = await page.locator('.grid-stack').boundingBox();
    await drag(page.locator('.workspace-divider:not(.divider-junction)'), grid.width * .19, 0);
    assert.deepEqual(await rect('a'), [0, 0, 3, 2]); assert.deepEqual(await rect('b'), [3, 0, 1, 2]);
    assert.ok(await node.evaluate(node => node === document.querySelector('[data-panel=a]')), 'original terminal DOM survives');
    await drag(page.locator('.workspace-divider:not(.divider-junction)'), -grid.width / 4, 0, true);
    assert.deepEqual(await rect('a'), [0, 0, 3, 2]);
    await drag(page.locator('.workspace-divider:not(.divider-junction)'), grid.width, 0, true);
    assert.deepEqual(await rect('a'), [0, 0, 3, 2], 'clamped highlight follows the panels rather than the pointer');
    await page.locator('.workspace-divider:not(.divider-junction)').press('ArrowLeft');
    assert.deepEqual(await rect('a'), [0, 0, 2, 2]);
    await page.waitForTimeout(350); await page.reload(); await page.locator('.workspace-divider').waitFor();
    assert.deepEqual(await rect('b'), [2, 0, 2, 2]);
    console.log('PASS live divider resize, snap animation, stable terminal, cancellation, keyboard and persistence');
    for (const four of [false, true]) for (const portrait of [false, true]) {
        const panels = [panel('a', 0, 0, 2, four ? 1 : 2), panel('b', 2, 0, 2, 1), panel('c', 2, 1, 2, 1), ...(four ? [panel('d', 0, 1, 2, 1)] : [])];
        await fixture(portrait ? panels.map(p => ({ ...p, x: p.y, y: p.x, w: p.h, h: p.w })) : panels, portrait);
        const handle = page.getByRole('separator', { name: 'Resize panels', exact: true }), box = await handle.boundingBox();
        for (const theme of ['dark', 'light']) {
            if (theme === 'light') await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
            for (const offset of [-30, 0, 30]) {
                await page.mouse.move(box.x + box.width / 2 + (portrait ? offset : 0), box.y + box.height / 2 + (portrait ? 0 : offset));
                await page.waitForTimeout(150);
                if (!offset) await page.screenshot({ path: `test-results/divider-hover-${four ? 'four' : 'three'}-${portrait ? 'portrait' : 'landscape'}-${theme}.png` });
                assert.ok(await handle.evaluate(node => node.matches(':hover') && getComputedStyle(node, '::after').opacity === '0.4'), 'the full divider stays highlighted across the junction');
            }
        }
        assert.equal(await page.locator('.divider-junction').count(), 0, 'a locked axis needs no separate junction handle');
        const bounds = await page.locator('.grid-stack').boundingBox();
        await drag(handle, portrait ? 90 : bounds.width / 4, portrait ? bounds.height / 4 : 90);
        assert.equal((await rect('a'))[portrait ? 3 : 2], 3); assert.equal((await rect('b'))[portrait ? 3 : 2], 1); assert.equal((await rect('c'))[portrait ? 3 : 2], 1);
        if (four) assert.deepEqual(await rect('d'), portrait ? [1, 0, 1, 3] : [0, 1, 3, 1]);
    }
    await fixture([panel('a', 0, 0, 2, 2), panel('b', 0, 2, 2, 2)], true);
    await drag(page.locator('.workspace-divider'), 0, (await page.locator('.grid-stack').boundingBox()).height / 4);
    assert.deepEqual(await rect('a'), [0, 0, 2, 3]); assert.deepEqual(await rect('b'), [0, 3, 2, 1]);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    assert.equal(await page.locator('.workspace-divider').count(), 0);
    assert.equal(await page.locator('.panel-resize:visible').count(), 0);
    console.log('PASS three/four-panel junctions, locked minimum height, portrait and mobile');
    for (const side of [-10, 10]) {
        await fixture([panel('a', 0, 0, 1, 1), panel('b', 2, 0, 2, 2)]);
        const grid = await page.locator('.grid-stack').boundingBox(), head = await item('a').locator('.panel-header').boundingBox();
        await page.mouse.move(head.x + 45, head.y + head.height / 2); await page.mouse.down();
        await page.mouse.move(grid.x + grid.width / 2 + side, grid.y + grid.height / 4, { steps: 5 });
        assert.equal(await page.locator('.dock-preview').evaluate(node => node.classList.contains('invalid')), false);
        await page.mouse.up(); await page.waitForTimeout(220);
        assert.deepEqual(await rect('a'), [1, 0, 2, 1]); assert.deepEqual(await rect('b'), [3, 0, 1, 2]);
    }
    console.log('PASS overlapping grid drops from both sides of boundary shrink neighbors without replacing terminal');
    await mkdir('test-results', { recursive: true });
    for (const size of ['desktop', 'wide', 'portrait']) for (const direction of ['bottom', 'right']) {
        const portrait = size === 'portrait';
        await fixture([panel('a', 0, 0, 1, 2), { ...panel('b', 1, 1, 1, 1), kind: 'terminal', terminal: neighbor.id },
            portrait ? panel('c', 0, 2, 2, 2) : panel('c', 2, 0, 2, 2)], portrait);
        if (size === 'wide') { await page.setViewportSize({ width: 2560, height: 1080 }); await page.waitForTimeout(250); }
        await item('b').locator('.terminal-view[data-state=connected]').waitFor();
        const originalA = await item('a').locator('.xterm').elementHandle(), originalB = await item('b').locator('.xterm').elementHandle();
        const fixed = await rect('c'), bounds = await page.locator('.grid-stack').boundingBox();
        const columns = portrait ? 2 : 4, rows = portrait ? 4 : 2;
        const expectedA = direction === 'bottom' ? [0, 1, 2, 1] : [1, 0, 1, 2];
        const expectedB = direction === 'bottom' ? [1, 0, 1, 1] : [0, 1, 1, 1];
        for (const cancel of [true, false]) {
            const head = await item('a').locator('.panel-header').boundingBox();
            await page.mouse.move(head.x + 45, head.y + head.height / 2); await page.mouse.down();
            const x = direction === 'bottom' ? 1 : 1.5, y = direction === 'bottom' ? 1.5 : 1;
            const offset = cancel ? -8 : 8;
            await page.mouse.move(bounds.x + x * bounds.width / columns + (direction === 'bottom' ? offset : 0),
                bounds.y + y * bounds.height / rows + (direction === 'right' ? offset : 0), { steps: 6 });
            const preview = page.locator('.dock-preview[data-edge=empty]:not(.invalid)'); await preview.waitFor();
            await page.waitForTimeout(140);
            const cover = await preview.boundingBox();
            assert.ok(Math.abs(cover.width - expectedA[2] * bounds.width / columns) < 2);
            assert.ok(Math.abs(cover.height - expectedA[3] * bounds.height / rows) < 2);
            assert.deepEqual(await rect('b'), [1, 1, 1, 1], 'preview does not move a live neighbor');
            if (cancel) await page.keyboard.press('Escape');
            const saved = cancel ? undefined : page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
            await page.mouse.up(); await page.waitForTimeout(220);
            if (cancel) {
                assert.deepEqual(await rect('a'), [0, 0, 1, 2]); assert.deepEqual(await rect('b'), [1, 1, 1, 1]); continue;
            }
            assert.equal((await saved).status(), 200);
            assert.deepEqual(await rect('a'), expectedA); assert.deepEqual(await rect('b'), expectedB); assert.deepEqual(await rect('c'), fixed);
            assert.ok(await page.evaluate(() => window.geometryFrames.b?.some(frame => frame.transform && frame.transform !== 'none')), 'blocking terminal animates to the free cell');
            assert.ok(await originalA.evaluate(node => node === document.querySelector('[data-panel=a] .xterm')));
            assert.ok(await originalB.evaluate(node => node === document.querySelector('[data-panel=b] .xterm')));
        }
        if (size === 'desktop') await page.screenshot({ path: `test-results/drop-relocate-${direction}.png` });
        await page.reload(); await item('b').locator('.terminal-view[data-state=connected]').waitFor();
        assert.deepEqual(await rect('a'), expectedA); assert.deepEqual(await rect('b'), expectedB);
        assert.equal((await (await api(`/terminals/${neighbor.id}`)).json()).pid, neighbor.pid);
    }
    await fixture([panel('a', 0, 0, 1, 1), { ...panel('b', 2, 1, 2, 1), kind: 'terminal', terminal: neighbor.id },
        panel('c', 1, 0, 1, 1), panel('d', 0, 1, 1, 1), panel('e', 3, 0, 1, 1)]);
    const shrinkGrid = await page.locator('.grid-stack').boundingBox(), shrinkHead = await item('a').locator('.panel-header').boundingBox();
    await page.mouse.move(shrinkHead.x + 45, shrinkHead.y + 15); await page.mouse.down();
    await page.mouse.move(shrinkGrid.x + shrinkGrid.width * .75, shrinkGrid.y + shrinkGrid.height / 2, { steps: 6 });
    await page.locator('.dock-preview[data-edge=empty]:not(.invalid)').waitFor(); await page.mouse.up(); await page.waitForTimeout(220);
    assert.deepEqual(await rect('a'), [2, 0, 2, 2]); assert.deepEqual(await rect('b'), [1, 1, 1, 1]);
    assert.deepEqual(await rect('e'), [0, 0, 1, 1]); assert.deepEqual(await rect('c'), [1, 0, 1, 1]); assert.deepEqual(await rect('d'), [0, 1, 1, 1]);
    await page.screenshot({ path: 'test-results/drop-move-and-shrink.png' });
    await fixture([panel('a', 0, 0, 1, 1), panel('b', 1, 1, 1, 1), panel('c', 2, 0, 2, 2)]);
    const addGrid = await page.locator('.grid-stack').boundingBox(), addButton = await page.getByRole('button', { name: 'Add file browser', exact: true }).boundingBox();
    await page.mouse.move(addButton.x + addButton.width / 2, addButton.y + addButton.height / 2); await page.mouse.down();
    await page.mouse.move(addGrid.x + addGrid.width * .375, addGrid.y + addGrid.height / 2, { steps: 6 });
    await page.locator('.dock-preview[data-edge=empty]:not(.invalid)').waitFor(); await page.mouse.up(); await page.waitForTimeout(220);
    assert.equal(await page.locator('[data-panel]').count(), 4);
    assert.deepEqual(await rect('a'), [0, 0, 1, 1]); assert.deepEqual(await rect('b'), [0, 1, 1, 1]); assert.deepEqual(await rect('c'), [2, 0, 2, 2]);
    await fixture([panel('a', 2, 0, 1, 1), panel('b', 1, 0, 1, 1), panel('c', 3, 0, 1, 1),
        ...Array.from({ length: 4 }, (_, x) => panel(`d${x}`, x, 1, 1, 1))]);
    const fullGrid = await page.locator('.grid-stack').boundingBox(), add = await page.getByRole('button', { name: 'Add file browser', exact: true }).boundingBox();
    await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2); await page.mouse.down();
    await page.mouse.move(fullGrid.x + fullGrid.width / 4, fullGrid.y + fullGrid.height / 4, { steps: 6 });
    await page.locator('.dock-preview[data-edge=empty].invalid').waitFor(); await page.mouse.up(); await page.waitForTimeout(220);
    assert.equal(await page.locator('[data-panel]').count(), 7, 'insufficient space never removes a window');
    console.log('PASS bottom/right relocation, occupied/vacant-side previews, cancellation, animations, original terminals, persistence, full-grid rejection and compact header spacing');
    await fixture([panel('a', 2, 0, 2, 2), panel('b', 0, 0, 2, 1), panel('c', 0, 1, 2, 1)], false, 1);
    const survivingTerminal = await item('a').locator('.terminal-view').elementHandle(), survivingFiles = await item('b').locator('.file-view').elementHandle();
    const previousFiles = await item('b').boundingBox(), previousTerminal = await item('a').boundingBox();
    const savedClose = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.request().postDataJSON().workspaces[0].panels.length === 2);
    await item('c').getByRole('button', { name: 'Close panel', exact: true }).click();
    await item('c').waitFor({ state: 'detached' });
    assert.deepEqual(await rect('b'), [0, 0, 2, 2]); assert.deepEqual(await rect('a'), [2, 0, 2, 2]);
    const frames = await page.evaluate(() => window.geometryFrames.b);
    assert.ok(frames?.length, 'expand the neighbor with the existing geometry animation');
    assert.ok(Math.abs(parseFloat(frames[0].height) - previousFiles.height) < 2);
    assert.ok(parseFloat(frames.at(-1).height) > previousFiles.height);
    assert.ok(await survivingFiles.evaluate(node => node === document.querySelector('[data-panel=b] .file-view')));
    assert.ok(await survivingTerminal.evaluate(node => node === document.querySelector('[data-panel=a] .terminal-view')));
    assert.deepEqual(await item('a').boundingBox(), previousTerminal);
    assert.equal(await page.locator('.layout-cycle').getAttribute('data-mode'), '0');
    assert.equal((await savedClose).status(), 200);
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').waitFor();
    assert.deepEqual(await rect('b'), [0, 0, 2, 2]);
    console.log('PASS closing a stacked file browser expands its neighbor smoothly, preserves views and persists a Custom layout');
    await fixture([panel('a', 2, 0, 2, 2), panel('b', 0, 0, 2, 1), panel('c', 0, 1, 2, 1)]);
    await page.evaluate(() => ['b', 'c'].forEach(id => document.querySelector(`[data-panel=${id}] [aria-label="Close panel"]`).click()));
    await item('b').waitFor({ state: 'detached' }); await item('c').waitFor({ state: 'detached' });
    assert.deepEqual(await rect('a'), [0, 0, 4, 2], 'concurrent closures do not expand or cancel another closing window');
    await fixture([panel('a', 1, 0, 1, 1), panel('b', 0, 0, 1, 1), panel('c', 3, 1, 1, 1)]);
    await item('b').getByRole('button', { name: 'Close panel', exact: true }).click(); await item('b').waitFor({ state: 'detached' });
    assert.deepEqual(await rect('a'), [0, 0, 2, 1]); assert.deepEqual(await rect('c'), [3, 1, 1, 1]);
    await fixture([panel('a', 1, 0, 1, 1), panel('b', 0, 0, 1, 1)]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compact-board').waitFor(); await page.locator('[data-component-name=b]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click(); await item('b').waitFor({ state: 'detached' });
    assert.deepEqual(await rect('a'), [0, 1, 1, 1], 'compact closure preserves the transposed geometry without expansion');
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(350);
    assert.deepEqual(await rect('a'), [1, 0, 1, 1], 'returning to landscape restores the original geometry');
    assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    assert.deepEqual(errors, []);
    console.log('PASS close expands only toward the gap, leaves unrelated windows alone and preserves compact geometry and terminal PID');
} finally {
    await page.waitForTimeout(350); await page.goto('about:blank');
    if (original) await api('/settings', 'PUT', original);
    await api(`/terminals/${terminal.id}`, 'DELETE');
    await api(`/terminals/${neighbor.id}`, 'DELETE');
    for (const id of addedTerminals) await api(`/terminals/${id}`, 'DELETE');
    await browser.close();
}
