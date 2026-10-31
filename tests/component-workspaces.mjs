import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm, chown } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-components-');
await chown(dir, Number(fields[2]), Number(fields[3]));
await writeFile(dir + '/draft.txt', 'original\n'); await chown(dir + '/draft.txt', Number(fields[2]), Number(fields[3]));
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, hasTouch: true });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const response = await api('/terminals', 'POST', { directory: dir, name: 'Keep running', columns: 80, rows: 24 });
assert.equal(response.status(), 201); const terminal = await response.json();
const sessions = [terminal.id];
const page = await appPage(context), errors = [], sockets = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => { if (socket.url().includes(`/terminals/${terminal.id}/ws`)) sockets.push(socket); });
page.setDefaultTimeout(10000);
const item = id => page.locator(`[data-panel="${id}"]`), tab = name => page.getByRole('button', { name, exact: true }).and(page.locator('.workspace-tab'));
const menu = page.locator('.menu-actions.popover-menu');
const snapshot = async () => (await (await api('/me')).json()).settings;
const panel = (id, x, y, w, h, kind = 'files') => ({ id, kind, path: dir, x, y, w, h, ...(kind === 'terminal' ? { terminal: terminal.id } : {}) });
const ws = (id, name, panels) => ({ id, name, columns: 4, rows: 2, active: panels[0]?.id || '', panels });
async function select(name) {
    if (!await tab(name).isVisible()) await page.getByRole('button', { name: 'More desktops', exact: true }).click();
    await tab(name).click();
    await page.waitForFunction(() => document.querySelectorAll('.board').length === 1 && !document.querySelector('.workspace-track').getAnimations().length);
}
async function moved(id, target) {
    await page.locator('.component-flight').waitFor({ state: 'detached' });
    for (let attempt = 0; attempt < 50; attempt++) {
        const settings = await snapshot();
        if (settings.workspaces.find(ws => ws.name === target).panels.some(panel => panel.id === id)) return settings;
        await page.waitForTimeout(50);
    }
    assert.fail(`${id} did not move to ${target}`);
}
async function headerMenu(id) { await item(id).locator('.panel-header').click({ button: 'right', position: { x: 20, y: 10 } }); }
async function moveMenu(target) {
    await menu.getByRole('menuitem', { name: 'Move to desktop', exact: true }).click();
    await menu.getByRole('menuitem', { name: target, exact: true }).click();
}
async function drag(id, name, finish = true) {
    await item(id).evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    const head = await item(id).locator('.panel-header').boundingBox(), target = await tab(name).boundingBox();
    await page.mouse.move(head.x + 20, head.y + head.height / 2);
    const tabStyles = () => page.locator('.workspace-tab-item').evaluateAll(tabs => tabs.map(tab => {
        const style = getComputedStyle(tab);
        return { id: tab.dataset.workspace, border: style.border, background: style.backgroundColor, opacity: style.opacity, shadow: style.boxShadow };
    }));
    const before = await tabStyles();
    await page.mouse.down();
    await page.mouse.move(head.x + 40, head.y + 30, { steps: 4 });
    assert.equal(await page.locator('[data-component-drop]').count(), 0, 'starting a drag does not mark workspace tabs');
    assert.deepEqual(await tabStyles(), before, 'unhovered tabs retain their normal appearance');
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    const hovered = await tab(name).locator('..').getAttribute('data-workspace');
    assert.equal(await page.locator('[data-component-drop]').count(), 1, 'only the hovered tab is marked');
    assert.deepEqual((await tabStyles()).filter(tab => tab.id !== hovered), before.filter(tab => tab.id !== hovered));
    const normal = before.find(tab => tab.id === hovered), highlighted = (await tabStyles()).find(tab => tab.id === hovered);
    assert.equal(highlighted.border, normal.border, 'drop feedback adds no border');
    assert.equal(highlighted.shadow, normal.shadow, 'drop feedback adds no outline shadow');
    assert.notEqual(highlighted.background, normal.background, 'drop feedback keeps its background highlight');
    if (finish) await page.mouse.up();
}
try {
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'origin', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 5 }, workspaces: [
        ws('origin', 'Origin', [panel('files', 0, 0, 1, 2), panel('shell', 1, 0, 1, 2, 'terminal')]),
        ws('destination', 'Destination', [panel('neighbor', 0, 0, 1, 2)]),
        ws('full', 'Full', Array.from({ length: 8 }, (_, i) => panel(`full-${i}`, i % 4, Math.floor(i / 4), 1, 1))),
        ws('fresh', 'Fresh', []),
        ...Array.from({ length: 8 }, (_, i) => ws(`extra-${i}`, `Extra ${i}`, [])),
    ] })).status(), 200);
    await page.goto(base); await item('shell').locator('[data-state=connected]').waitFor();
    const shellDOM = await item('shell').locator('.xterm').elementHandle(), filesDOM = await item('files').elementHandle();
    const grid = await page.locator('.grid-stack').boundingBox();
    await page.mouse.click(grid.x + grid.width * .88, grid.y + grid.height * .75, { button: 'right' });
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Add terminal', 'Add file browser']);
    await page.screenshot({ path: 'test-results/component-add-menu.png' });
    const save = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.request().postDataJSON().workspaces[0].panels.length === 3);
    await menu.getByRole('menuitem', { name: 'Add file browser', exact: true }).click(); await save;
    const added = (await snapshot()).workspaces[0].panels.find(panel => !['files', 'shell'].includes(panel.id));
    assert.deepEqual([added.x, added.y, added.w, added.h], [3, 0, 1, 2]);
    assert.ok(await shellDOM.evaluate(node => node === document.querySelector('[data-panel=shell] .xterm')));
    await page.mouse.click(grid.x + grid.width * .625, grid.y + grid.height * .75, { button: 'right' });
    const terminalSave = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.request().postDataJSON().workspaces[0].panels.length === 4);
    await menu.getByRole('menuitem', { name: 'Add terminal', exact: true }).click(); await terminalSave;
    const addedTerminal = (await snapshot()).workspaces[0].panels.find(panel => !['files', 'shell', added.id].includes(panel.id));
    await item(addedTerminal.id).locator('[data-state=connected]').waitFor();
    sessions.push(await item(addedTerminal.id).locator('[data-terminal]').getAttribute('data-terminal'));
    assert.deepEqual([addedTerminal.x, addedTerminal.y, addedTerminal.w, addedTerminal.h], [2, 0, 1, 2]);
    console.log('PASS blank-space menu places a component at the closest cell and expands it without replacing neighbors');

    await headerMenu('shell');
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Add terminal', 'Add file browser', 'Move to desktop', 'Rename', 'Close']);
    await menu.getByRole('menuitem', { name: 'Move to desktop', exact: true }).press('ArrowRight');
    assert.ok(await menu.getByRole('menuitem', { name: 'Origin', exact: true }).isDisabled());
    assert.ok(await menu.getByRole('menuitem', { name: 'Full', exact: true }).isDisabled());
    await page.screenshot({ path: 'test-results/component-header-menu.png' });
    await page.keyboard.press('Escape');
    const terminalTab = item('shell').locator('.terminal-tab');
    await terminalTab.focus(); await terminalTab.press('Shift+F10'); await menu.waitFor(); await page.keyboard.press('Escape');
    assert.ok(await terminalTab.evaluate(node => node === document.activeElement), 'header context menu must restore keyboard focus');
    await drag('shell', 'Origin', false);
    assert.equal(await tab('Origin').locator('..').getAttribute('data-component-drop'), 'blocked');
    await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height / 2, { steps: 8 });
    assert.equal(await page.locator('[data-component-drop]').count(), 0, 'leaving a tab clears its highlight');
    await page.keyboard.press('Escape'); await page.mouse.up();
    await drag('shell', 'Full', false);
    assert.equal(await tab('Full').locator('..').getAttribute('data-component-drop'), 'blocked');
    assert.equal(await tab('Full').locator('..').evaluate(node => getComputedStyle(node).boxShadow), 'none');
    await page.screenshot({ path: 'test-results/component-drop-full.png' });
    await page.mouse.up(); await page.waitForTimeout(250);
    assert.equal((await snapshot()).workspaces[0].panels.find(panel => panel.id === 'shell').terminal, terminal.id);
    await drag('shell', 'Destination', false);
    assert.equal(await tab('Destination').locator('..').getAttribute('data-component-drop'), 'allowed');
    await page.screenshot({ path: 'test-results/component-drop-allowed.png' });
    await page.mouse.up(); await page.locator('.component-flight').waitFor();
    await page.screenshot({ path: 'test-results/component-drop-flight.png' });
    const result = await moved('shell', 'Destination');
    assert.equal(result.current, 'origin'); assert.equal(await item('shell').count(), 0);
    assert.equal(sockets.length, 1);
    await select('Destination'); await item('shell').locator('[data-state=connected]').waitFor();
    assert.ok(await shellDOM.evaluate(node => node === document.querySelector('[data-panel=shell] .xterm')));
    assert.equal((await (await api('/terminals')).json()).find(info => info.id === terminal.id).pid, terminal.pid);
    const input = item('shell').locator('.xterm-helper-textarea');
    await input.focus(); await page.keyboard.type(`printf alive > '${dir}/alive'`); await page.keyboard.press('Enter');
    for (let n = 0; n < 50 && await readFile(dir + '/alive', 'utf8').catch(() => '') !== 'alive'; n++) await page.waitForTimeout(50);
    assert.equal(await readFile(dir + '/alive', 'utf8'), 'alive');
    await headerMenu('shell'); await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Moved terminal'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    console.log('PASS valid/blocked drops, slide-and-shrink animation, unchanged active workspace, same terminal DOM/socket/PID and real input after moving');

    await select('Origin');
    await item('files').locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
    const editor = item('files').locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('unsaved');
    const draftDOM = await editor.elementHandle();
    await headerMenu('files'); assert.equal(await menu.getByRole('menuitem', { name: 'Rename', exact: true }).count(), 0);
    await moveMenu('Fresh'); await moved('files', 'Fresh');
    assert.equal((await snapshot()).current, 'origin'); assert.equal(await page.getByRole('dialog').count(), 0);
    await select('Fresh');
    assert.ok(await filesDOM.evaluate(node => node === document.querySelector('[data-panel=files]')));
    assert.ok(await draftDOM.evaluate(node => node === document.querySelector('[data-panel=files] .cm-content')));
    assert.match(await editor.textContent(), /unsaved/); assert.equal(await readFile(dir + '/draft.txt', 'utf8'), 'original\n');
    await item('files').locator('.panel-header').dblclick({ position: { x: 20, y: 10 } });
    assert.equal(await item('files').getAttribute('gs-w'), '4', 'moved header expands in its new workspace');
    await headerMenu('files'); await menu.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.match(await editor.textContent(), /unsaved/);
    console.log('PASS menu moves preserve file/editor identity and drafts, with header actions owned by the destination');

    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
    await page.locator('[data-component-menu=files]').click();
    await menu.getByRole('menuitem', { name: 'Move to desktop', exact: true }).click();
    await page.screenshot({ path: 'test-results/component-move-mobile.png' });
    await menu.getByRole('menuitem', { name: 'Destination', exact: true }).click(); await moved('files', 'Destination');
    assert.equal((await snapshot()).current, 'fresh');
    await select('Destination'); assert.match(await editor.textContent(), /unsaved/);
    assert.ok(await draftDOM.evaluate(node => node === document.querySelector('[data-panel=files] .cm-content')));
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('.board:not(.compact-board)').waitFor();
    await headerMenu('files'); await moveMenu('Origin'); await moved('files', 'Origin');
    await select('Origin'); assert.match(await editor.textContent(), /unsaved/);
    console.log('PASS compact chevron moves to a warm workspace, keeps the original workspace active and preserves unsaved edits through orientation changes');

    await select('Destination');
    await page.setViewportSize({ width: 800, height: 700 }); await page.waitForTimeout(200);
    const head = await item('shell').locator('.panel-header').boundingBox();
    const more = page.getByRole('button', { name: 'More desktops', exact: true }), moreBox = await more.boundingBox();
    await page.mouse.move(head.x + 20, head.y + 10); await page.mouse.down(); await page.mouse.move(head.x + 40, head.y + 40, { steps: 4 });
    await page.mouse.move(moreBox.x + moreBox.width / 2, moreBox.y + moreBox.height / 2, { steps: 10 });
    await page.locator('.overflow-tabs:popover-open').waitFor();
    assert.equal(await page.locator('[data-component-drop]').count(), 0, 'opening overflow does not mark all its tabs');
    const target = await tab('Fresh').boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    assert.equal(await tab('Fresh').locator('..').getAttribute('data-component-drop'), 'allowed');
    assert.equal(await page.locator('[data-component-drop]').count(), 1);
    await page.screenshot({ path: 'test-results/component-drop-overflow.png' });
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.component-flight').count(), 0);
    assert.ok(await item('shell').isVisible(), 'Escape must cancel dragging even when the overflow menu has keyboard focus');
    assert.ok((await snapshot()).workspaces.find(ws => ws.id === 'destination').panels.some(panel => panel.id === 'shell'));
    assert.equal(await page.locator('[data-component-drop]').count(), 0);
    console.log('PASS hovering workspace overflow exposes drop targets; Escape restores the original component and clears feedback');

    await page.setViewportSize({ width: 1440, height: 1000 });
    for (let i = 0; i < 5; i++) await select(`Extra ${i}`);
    await select('Origin');
    await headerMenu('files'); await moveMenu('Extra 5'); await moved('files', 'Extra 5');
    assert.equal((await snapshot()).current, 'origin');
    assert.equal(await page.getByRole('dialog').count(), 0, 'moving the active draft must not prompt for discard');
    await select('Extra 5'); assert.match(await editor.textContent(), /unsaved/);
    assert.ok(await draftDOM.evaluate(node => node === document.querySelector('[data-panel=files] .cm-content')));
    for (let n = 0; n < 50 && !sockets[0].isClosed(); n++) await page.waitForTimeout(50);
    assert.ok(sockets[0].isClosed(), 'a full cache evicts its oldest inactive workspace');
    assert.equal((await (await api('/terminals')).json()).find(info => info.id === terminal.id).pid, terminal.pid);
    console.log('PASS background moves respect the eight-workspace cache, preserve the active draft and retain an evicted terminal process');
    await select('Full');
    const fullGrid = await page.locator('.board .grid-stack').boundingBox();
    await page.mouse.click(fullGrid.x + 1, fullGrid.y + 1, { button: 'right' });
    assert.ok(await menu.getByRole('menuitem', { name: 'Add terminal', exact: true }).isDisabled());
    assert.ok(await menu.getByRole('menuitem', { name: 'Add file browser', exact: true }).isDisabled());
    await page.keyboard.press('Escape');

    const geometry = ({ x, y, w, h }) => [x, y, w, h];
    for (const [name, columns, rows, w, h, kind, addition, expectedTarget, expectedNew, options = {}] of [
        ['terminal-square', 4, 2, 2, 2, 'terminal', 'terminal', [0, 0, 2, 1], [0, 1, 2, 1]],
        ['terminal-square-files', 4, 2, 2, 2, 'terminal', 'files', [0, 0, 2, 1], [0, 1, 2, 1]],
        ['files-square', 4, 2, 2, 2, 'files', 'files', [0, 0, 2, 1], [0, 1, 2, 1]],
        ['files-square-terminal', 4, 2, 2, 2, 'files', 'terminal', [0, 0, 2, 1], [0, 1, 2, 1]],
        ['wide', 4, 2, 4, 2, 'terminal', 'files', [0, 0, 2, 2], [2, 0, 2, 2]],
        ['wide-odd', 4, 2, 3, 2, 'terminal', 'terminal', [0, 0, 1, 2], [1, 0, 2, 2]],
        ['tall-odd', 2, 4, 2, 3, 'files', 'files', [0, 0, 1, 3], [1, 0, 1, 3]],
        ['tall', 2, 4, 2, 4, 'files', 'terminal', [0, 0, 2, 2], [0, 2, 2, 2]],
        ['thin', 4, 2, 1, 2, 'terminal', 'files', [0, 0, 1, 1], [0, 1, 1, 1]],
        ['short', 4, 2, 2, 1, 'files', 'terminal', [0, 0, 1, 1], [1, 0, 1, 1]],
        ['compact', 2, 4, 2, 2, 'terminal', 'files', [0, 0, 1, 2], [1, 0, 1, 2], { compact: true }],
        ['ultrawide-terminal', 4, 2, 2, 2, 'terminal', 'files', [0, 0, 1, 2], [1, 0, 1, 2], { width: 3440, height: 1440 }],
        ['ultrawide-files', 4, 2, 2, 2, 'files', 'terminal', [0, 0, 1, 2], [1, 0, 1, 2], { width: 3440, height: 1440 }],
        ['wide-locked', 4, 2, 1, 2, 'terminal', 'files', [0, 0, 1, 1], [0, 1, 1, 1], { width: 5120, height: 1080 }],
        ['tall-locked', 2, 4, 2, 1, 'files', 'files', [0, 0, 1, 1], [1, 0, 1, 1], { width: 900, height: 4200 }],
        ['navbar-wide-terminal', 4, 2, 3, 2, 'terminal', 'terminal', [0, 0, 1, 2], [1, 0, 2, 2], { navbar: true, width: 3440, height: 1440 }],
        ['navbar-wide-files', 4, 2, 3, 2, 'files', 'files', [0, 0, 1, 2], [1, 0, 2, 2], { navbar: true, width: 3440, height: 1440 }],
        ['navbar-tall', 4, 2, 3, 2, 'files', 'terminal', [0, 0, 3, 1], [0, 1, 3, 1], { navbar: true, width: 1000, height: 1000 }],
        ['terminal-cell', 4, 2, 1, 1, 'terminal', 'files', null, null],
        ['files-cell', 4, 2, 1, 1, 'files', 'terminal', null, null],
    ]) {
        const compact = options.compact || false;
        await page.goto('about:blank');
        await page.setViewportSize(options.width ? { width: options.width, height: options.height } : compact ? { width: 390, height: 844 } : columns === 4 ? { width: 1440, height: 1000 } : { width: 900, height: 1200 });
        const target = panel('target', 0, 0, w, h, kind);
        const neighbor = w < columns ? panel('fixed', w, 0, columns - w, rows) : h < rows ? panel('fixed', 0, h, columns, rows - h) : undefined;
        const panels = neighbor ? options.navbar ? [neighbor, target] : [target, neighbor] : [target];
        const layout = { mode: 1, custom: panels.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) };
        const settings = { theme: 'dark', current: 'split', workspaces: [{ ...ws('split', 'Split', panels), columns, rows, layout }] };
        assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
        await page.goto(base); await item('target').waitFor();
        if (kind === 'terminal') await item('target').locator('[data-state=connected]').waitFor();
        const targetDOM = await item('target').elementHandle(), neighborDOM = neighbor && await item('fixed').elementHandle();
        let draft;
        if (name === 'files-square') {
            await item('target').locator('.file-name').filter({ hasText: 'draft.txt' }).dblclick();
            const editor = item('target').locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('split draft');
            draft = await editor.elementHandle();
        }
        const connected = sockets.length;
        if (!options.navbar) {
            if (compact) await page.locator('[data-component-menu=target]').click(); else await headerMenu('target');
            const actions = await menu.getByRole('menuitem').allTextContents();
            assert.deepEqual(actions.slice(actions.indexOf('Add terminal'), actions.indexOf('Move to desktop') + 1), ['Add terminal', 'Add file browser', 'Move to desktop']);
        }
        if (!expectedTarget) {
            for (const label of ['Add terminal', 'Add file browser']) assert.ok(await menu.getByRole('menuitem', { name: label, exact: true }).isDisabled());
            await page.keyboard.press('Escape');
            assert.deepEqual((await snapshot()).workspaces[0].panels.map(geometry), panels.map(geometry));
            continue;
        }
        const saved = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PUT' && r.request().postDataJSON().workspaces[0].panels.length === panels.length + 1);
        const label = addition === 'terminal' ? 'Add terminal' : 'Add file browser';
        await (options.navbar ? page.getByRole('button', { name: label, exact: true }) : menu.getByRole('menuitem', { name: label, exact: true })).click(); await saved;
        const result = (await snapshot()).workspaces[0], added = result.panels.find(panel => !panels.some(before => before.id === panel.id));
        assert.deepEqual(geometry(result.panels.find(panel => panel.id === target.id)), expectedTarget, name);
        assert.deepEqual(geometry(added), expectedNew, name); assert.equal(added.kind, addition);
        assert.equal(result.layout, undefined, 'splitting switches to Custom'); assert.equal(result.active, added.id);
        assert.ok(await targetDOM.evaluate(node => node === document.querySelector('[data-panel=target]')), 'reuse the clicked component');
        if (neighbor) {
            assert.deepEqual(geometry(result.panels.find(panel => panel.id === neighbor.id)), geometry(neighbor));
            assert.ok(await neighborDOM.evaluate(node => node === document.querySelector('[data-panel=fixed]')), 'reuse neighboring components');
        }
        if (draft) {
            assert.ok(await draft.evaluate(node => node === document.querySelector('[data-panel=target] .cm-content')));
            assert.match(await draft.textContent(), /split draft/);
            assert.equal(await readFile(dir + '/draft.txt', 'utf8'), 'original\n');
        }
        if (addition === 'terminal') {
            await item(added.id).locator('[data-state=connected]').waitFor();
            sessions.push(await item(added.id).locator('[data-terminal]').getAttribute('data-terminal'));
        }
        if (kind === 'terminal') {
            assert.equal(sockets.length, connected, 'splitting keeps the existing terminal connection');
            assert.equal((await (await api('/terminals')).json()).find(info => info.id === terminal.id).pid, terminal.pid);
        }
        if (!compact) {
            await page.locator('.grid-stack-item').evaluateAll(nodes => Promise.allSettled(nodes.flatMap(node => node.getAnimations()).map(animation => animation.finished)));
            const before = await item('target').boundingBox(), after = await item(added.id).boundingBox();
            assert.ok(expectedNew[0] > 0 ? before.x + before.width <= after.x + 1 : before.y + before.height <= after.y + 1, `${name}: split panes do not overlap after settling`);
        }
        if (['terminal-square', 'files-square', 'ultrawide-terminal', 'navbar-wide-files'].includes(name)) await page.screenshot({ path: `test-results/component-split-${name}.png` });
        if (name === 'wide') {
            await page.reload(); await item(added.id).waitFor();
            const restored = (await snapshot()).workspaces[0];
            assert.deepEqual(restored.panels.map(geometry), result.panels.map(geometry));
            assert.equal(restored.layout, undefined);
        }
    }
    console.log('PASS pixel-based header/navbar splits, largest-panel selection, ultrawide/portrait/odd panes, locked-axis fallback, compact actions, disabled cells, Custom persistence and live component/draft preservation');
    assert.deepEqual(errors, []);
} catch (error) {
    await page.screenshot({ path: 'test-results/component-failure.png' }); throw error;
} finally {
    await page.goto('about:blank'); await api('/settings', 'PUT', original);
    for (const id of sessions) await api(`/terminals/${id}`, 'DELETE');
    await browser.close(); await rm(dir, { recursive: true, force: true });
}
