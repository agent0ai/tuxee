import './shared-layout.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
const user = 'tuxee-poc-a';
assert.equal(spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const terminal = await (await api('/terminals', 'POST', { directory: '/tmp', name: 'Divider test' })).json();
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const panel = (id, x, y, w, h) => ({ id, kind: id === 'a' ? 'terminal' : 'files', path: '/tmp', ...(id === 'a' ? { terminal: terminal.id } : {}), x, y, w, h });
const item = id => page.locator(`[data-panel="${id}"]`);
const rect = id => item(id).evaluate(node => ['x', 'y', 'w', 'h'].map(key => Number(node.getAttribute('gs-' + key) || (key === 'w' || key === 'h' ? 1 : 0))));
async function fixture(panels, portrait = false) {
    await page.waitForTimeout(350); await page.goto('about:blank');
    await page.setViewportSize(portrait ? { width: 900, height: 1200 } : { width: 1440, height: 1000 });
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', idleHours: 36, current: 'work', workspaces: [{ id: 'work', name: 'Work', columns: portrait ? 2 : 4, rows: portrait ? 4 : 2, active: 'a', panels }] })).status(), 200);
    await page.goto(base);
    await page.locator('.terminal-view[data-state=connected]').waitFor();
}
async function drag(handle, dx, dy, cancel = false) {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 4 });
    const live = await item('a').boundingBox();
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (!cancel) {
        const frames = await item('a').evaluate(node => node.getAnimations()[0]?.effect.getKeyframes());
        assert.ok(frames?.length, 'resize animates from its released geometry');
        assert.ok(Math.abs(parseFloat(frames[0].width) - live.width) < 2);
    }
    await page.waitForTimeout(200);
}
try {
    await fixture([panel('a', 0, 0, 2, 2), panel('b', 2, 0, 2, 2)]);
    const node = await item('a').elementHandle(), grid = await page.locator('.grid-stack').boundingBox();
    await drag(page.locator('.workspace-divider:not(.divider-junction)'), grid.width * .19, 0);
    assert.deepEqual(await rect('a'), [0, 0, 3, 2]); assert.deepEqual(await rect('b'), [3, 0, 1, 2]);
    assert.ok(await node.evaluate(node => node === document.querySelector('[data-panel=a]')), 'original terminal DOM survives');
    await drag(page.locator('.workspace-divider:not(.divider-junction)'), -grid.width / 4, 0, true);
    assert.deepEqual(await rect('a'), [0, 0, 3, 2]);
    await page.locator('.workspace-divider:not(.divider-junction)').press('ArrowLeft');
    assert.deepEqual(await rect('a'), [0, 0, 2, 2]);
    await page.waitForTimeout(350); await page.reload(); await page.locator('.workspace-divider').waitFor();
    assert.deepEqual(await rect('b'), [2, 0, 2, 2]);
    console.log('PASS live divider resize, snap animation, stable terminal, cancellation, keyboard and persistence');
    for (const four of [false, true]) {
        await fixture([panel('a', 0, 0, 2, four ? 1 : 2), panel('b', 2, 0, 2, 1), panel('c', 2, 1, 2, 1), ...(four ? [panel('d', 0, 1, 2, 1)] : [])]);
        await drag(page.locator('.divider-junction'), grid.width / 4, 90);
        assert.equal((await rect('a'))[2], 3); assert.equal((await rect('b'))[2], 1); assert.equal((await rect('c'))[2], 1);
        if (four) assert.deepEqual(await rect('d'), [0, 1, 3, 1]);
    }
    await fixture([panel('a', 0, 0, 2, 2), panel('b', 0, 2, 2, 2)], true);
    await drag(page.locator('.workspace-divider'), 0, (await page.locator('.grid-stack').boundingBox()).height / 4);
    assert.deepEqual(await rect('a'), [0, 0, 2, 3]); assert.deepEqual(await rect('b'), [0, 3, 2, 1]);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    assert.equal(await page.locator('.workspace-divider').count(), 0);
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
    assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    assert.deepEqual(errors, []);
    console.log('PASS overlapping grid drops from both sides of boundary shrink neighbors without replacing terminal');
} finally {
    await page.waitForTimeout(350); await page.goto('about:blank');
    if (original) await api('/settings', 'PUT', original);
    await api(`/terminals/${terminal.id}`, 'DELETE');
    await browser.close();
}
