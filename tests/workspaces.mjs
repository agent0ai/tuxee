import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, chown, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp('/tmp/tuxee-warm-');
await chown(dir, Number(fields[2]), Number(fields[3]));
await writeFile(`${dir}/draft.txt`, 'original\n', { mode: 0o600 });
await chown(`${dir}/draft.txt`, Number(fields[2]), Number(fields[3]));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
async function login() {
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    return (await (await context.request.get(base + '/api/me')).json()).csrf;
}
let csrf = await login();
const original = (await (await context.request.get(base + '/api/me')).json()).settings;
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await appPage(context), sockets = [], terminals = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => {
    if (!/\/api\/terminals\/[^/]+\/ws$/.test(socket.url())) return;
    const record = { url: socket.url(), closed: false, snapshots: 0 };
    sockets.push(record);
    socket.on('close', () => { record.closed = true; });
    socket.on('framereceived', event => { if (typeof event.payload === 'string' && JSON.parse(event.payload).type === 'snapshot') record.snapshots++; });
});
const connections = index => sockets.filter(socket => socket.url.includes(`/terminals/${terminals[index].id}/ws`));
const tab = index => page.locator('.workspace-tab').filter({ hasText: new RegExp(`^Warm ${index}$`) });
async function select(index) {
    if (!await tab(index).isVisible()) await page.getByRole('button', { name: 'More desktops', exact: true }).click();
    await tab(index).click();
}
async function settled(index) {
    await page.locator(`[data-workspace="warm-${index}"] .terminal-view[data-state=connected]`).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.board').length === 1 && !document.querySelector('.workspace-track').getAnimations().length);
}
async function visit(index) { await select(index); await settled(index); }
try {
    for (let i = 0; i < 9; i++) {
        const response = await api('/terminals', 'POST', { directory: dir, name: `Warm ${i}`, columns: 80, rows: 24 });
        assert.equal(response.status(), 201);
        terminals.push(await response.json());
    }
    const workspaces = terminals.map((terminal, i) => ({
        id: `warm-${i}`, name: `Warm ${i}`, columns: 4, rows: 2, active: `term-${i}`,
        panels: [
            { id: `term-${i}`, kind: 'terminal', terminal: terminal.id, path: dir, x: 0, y: 0, w: i === 0 ? 2 : 4, h: 2 },
            ...(i === 0 ? [{ id: 'files', kind: 'files', path: dir, x: 2, y: 0, w: 2, h: 2 }] : []),
        ],
    }));
    // Load an actual legacy settings file: POST only admits the new eight-cell contract.
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'warm-0', workspaces })).status(), 200);
    const legacy = { theme: 'dark', current: 'legacy', workspaces: [{
        id: 'legacy', name: 'Legacy', columns: 8, rows: 2, active: 'term-8',
        panels: workspaces.map((ws, i) => ({ ...ws.panels[0], x: i % 8, y: Math.floor(i / 8), w: 1, h: 1 })),
    }] };
    assert.equal((await api('/settings', 'PUT', legacy)).status(), 400);
    await writeFile(`${fields[5]}/.config/tuxee/settings.json`, JSON.stringify(legacy));
    const migrated = (await (await api('/me')).json()).settings;
    assert.equal(migrated.workspaces.length, 2);
    assert.ok(migrated.workspaces.every(ws => ws.columns === 4 && ws.rows === 2 && ws.panels.length <= 8));
    assert.deepEqual(migrated.workspaces.flatMap(ws => ws.panels.map(p => p.terminal)), terminals.map(t => t.id));
    await page.goto(base);
    await page.locator('[data-panel=term-8] .terminal-view[data-state=connected]').waitFor();
    assert.equal((await (await api(`/terminals/${terminals[8].id}`)).json()).pid, terminals[8].pid);
    await page.waitForTimeout(400); await page.goto('about:blank');
    sockets.length = 0;
    console.log('PASS real legacy-file migration preserves all nine terminals and the active overflow panel');
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'warm-0', workspaces })).status(), 200);
    await page.goto(base); await settled(0);
    const first = await page.locator('[data-panel=term-0] .terminal-view').elementHandle();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("sleep 1; printf 'WARM_%s\\n' 'OUTPUT'"); await page.keyboard.press('Enter');
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved');
    await visit(1);
    assert.equal(await page.getByRole('dialog').count(), 0, 'switching keeps unsaved drafts in memory');
    assert.equal(await first.evaluate(node => node.isConnected), false, 'inactive board is removed from the visible page');
    assert.equal((await (await api(`/terminals/${terminals[0].id}`)).json()).attached, 1, 'hidden terminal stays attached');
    await page.setViewportSize({ width: 1200, height: 900 });
    await visit(0);
    assert.ok(await first.evaluate(node => node === document.querySelector('[data-panel=term-0] .terminal-view')), 'reuse the original terminal UI');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('WARM_OUTPUT'));
    assert.ok((await page.locator('.cm-content').textContent()).includes('unsaved'));
    assert.equal(connections(0).length, 1); assert.equal(connections(0)[0].snapshots, 1);
    const geometry = () => page.locator('.grid-stack-item').evaluateAll(nodes => nodes.map(node =>
        ['x', 'y', 'w', 'h'].map(key => Number(node.getAttribute(`gs-${key}`) || (key === 'w' || key === 'h' ? 1 : 0)))));
    const originalGeometry = await geometry();
    for (const [width, height] of [[5120, 1440], [1024, 768], [900, 1200], [390, 844], [844, 390], [1440, 1000]]) {
        await visit(1); // Exercise rotation of cached boards as well as the visible board.
        await page.setViewportSize({ width, height }); await page.waitForTimeout(350);
        await visit(0); await page.waitForTimeout(350);
        const saved = (await (await api('/me')).json()).settings.workspaces.find(ws => ws.id === 'warm-0');
        assert.deepEqual([saved.columns, saved.rows], height > width ? [2, 4] : [4, 2]);
        assert.equal(saved.panels.length, 2);
        assert.ok(await first.evaluate(node => node === document.querySelector('[data-panel=term-0] .terminal-view')));
        assert.ok((await page.locator('.cm-content').textContent()).includes('unsaved'));
        assert.equal(connections(0).length, 1, 'orientation must not reconnect terminals');
    }
    assert.deepEqual(await geometry(), originalGeometry);
    assert.equal((await (await api(`/terminals/${terminals[0].id}`)).json()).pid, terminals[0].pid);
    console.log('PASS orientation and screen-size round trips retain geometry, cached views, drafts and terminal connections');
    await visit(1);
    for (let i = 2; i < 8; i++) await visit(i);
    assert.equal(sockets.filter(socket => !socket.closed).length, 8);
    await visit(0); await visit(7); // Revisiting must not change FIFO order.
    await select(8);
    await page.getByRole('dialog', { name: 'Discard changes?', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.locator('.workspace-tab.active').textContent(), 'Warm 7');
    assert.equal(connections(8).length, 0, 'cancelled eviction never creates a ninth view');
    await select(8);
    await page.getByRole('button', { name: 'Discard', exact: true }).click(); await settled(8);
    await page.waitForFunction(id => fetch(`/api/terminals/${id}`).then(r => r.json()).then(info => info.attached === 0), terminals[0].id);
    assert.ok(connections(0)[0].closed, 'evict the first visited workspace, even after revisiting');
    assert.equal(sockets.filter(socket => !socket.closed).length, 8);
    assert.equal((await (await api(`/terminals/${terminals[0].id}`)).json()).pid, terminals[0].pid);
    await visit(0);
    assert.equal(connections(0).length, 2); assert.equal(connections(0)[1].snapshots, 1, 'evicted views use normal snapshot restoration');
    assert.equal(await first.evaluate(node => node === document.querySelector('[data-panel=term-0] .terminal-view')), false);
    await first.dispose();
    await page.waitForFunction(id => fetch(`/api/terminals/${id}`).then(r => r.json()).then(info => info.attached === 0), terminals[1].id);
    assert.ok(connections(1)[0].closed, 'next eviction follows insertion order');
    if (!await tab(2).isVisible()) await page.getByRole('button', { name: 'More desktops', exact: true }).click();
    await tab(2).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Close desktop', exact: true }).click();
    await page.waitForFunction(id => fetch(`/api/terminals/${id}`).then(r => r.status === 404), terminals[2].id);
    assert.ok(connections(2)[0].closed, 'closing an inactive cached workspace cleans up its connection');
    const beforeReload = sockets.length;
    await page.reload(); await settled(0);
    assert.equal(connections(0).length, 3); assert.equal(connections(0)[2].snapshots, 1);
    await page.locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('logout draft');
    await visit(3);
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('dialog', { name: 'Discard changes?', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.locator('.workspace-tab.active').textContent(), 'Warm 3', 'logout protects drafts in inactive workspaces');
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    csrf = await login();
    await page.waitForFunction(ids => fetch('/api/terminals').then(r => r.json()).then(sessions => sessions.filter(session => ids.includes(session.id)).every(session => !session.attached)), terminals.map(terminal => terminal.id));
    assert.ok(sockets.slice(beforeReload).every(socket => socket.closed), 'logout closes active and inactive connections in the current document');
    assert.deepEqual(errors, []);
    console.log('PASS warm workspace reuse, hidden output, FIFO limit, dirty eviction, closure, reload and logout');
} finally {
    page.on('dialog', dialog => dialog.accept());
    await page.goto('about:blank');
    csrf = await login();
    await api('/settings', 'PUT', original);
    for (const terminal of terminals) await api(`/terminals/${terminal.id}`, 'DELETE');
    await browser.close();
    await rm(dir, { recursive: true, force: true });
}
