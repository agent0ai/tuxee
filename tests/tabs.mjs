import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', container = process.env.TUXEE_TEST_CONTAINER;
const run = (command, args, input) => spawnSync(container ? 'docker' : command,
    container ? ['exec', '-i', container, command, ...args] : args, { input, encoding: 'utf8' });
const fields = run('getent', ['passwd', user]).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(run('chpasswd', [], `${user}:${password}\n`).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', {
    data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' },
})).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, {
    method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
});
const panels = Array.from({ length: 8 }, (_, index) => ({
    id: `panel-${index}`, kind: index < 6 ? 'files' : 'terminal', path: '/tmp',
    x: index % 4, y: Math.floor(index / 4), w: 1, h: 1,
}));
const settings = {
    theme: 'dark', current: 'work',
    workspaces: [
        { id: 'work', name: 'Work', columns: 4, rows: 2, active: panels[0].id, panels },
        ...Array.from({ length: 5 }, (_, index) => ({
            id: `other-${index}`, name: `Other ${index}`, columns: 4, rows: 2, active: '', panels: [],
        })),
    ],
};
assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
const page = await context.newPage(), errors = [], external = [], sockets = [];
page.on('websocket', socket => sockets.push(socket));
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (!request.url().startsWith(base + '/') && !/^(data|blob):/.test(request.url())) external.push(request.url());
});
const touch = await context.newCDPSession(page);
const menu = page.locator('.menu-actions.popover-menu');
const panel = id => page.locator(`[data-panel="${id}"]`);
const tab = id => page.locator(`[data-component-name="${id}"]`);
const snapshot = async () => (await (await api('/me')).json()).settings;
const saved = () => page.waitForResponse(response => response.url() === base + '/api/settings' && response.request().method() === 'PUT');
const check = text => console.log('PASS ' + text);
async function reveal(id) {
    if (!await tab(id).isVisible()) await page.getByRole('button', { name: 'More components', exact: true }).tap();
    return tab(id);
}
async function press(target) {
    const box = await target.boundingBox();
    assert.ok(box);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    return point;
}
async function hold(target, canRename = true) {
    const component = await target.evaluate(node => node.hasAttribute('data-component-name'));
    await press(target);
    await page.waitForTimeout(600);
    await menu.waitFor();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    assert.ok(await menu.isVisible(), 'releasing a hold must leave its menu open');
    assert.equal(await page.locator('dialog').count(), 0, 'release must not invoke a menu action');
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Activate', ...(component ? ['Add terminal', 'Add file browser', 'Move to workspace'] : []), ...(canRename ? ['Rename'] : []), ...(component ? [] : ['Default directory']), 'Close']);
}
async function renameDialog(kind, name) {
    const dialog = page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
    await dialog.getByRole('textbox').fill(name);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
}
async function resetDialog(kind) {
    const dialog = page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
    assert.ok(await dialog.getByRole('button', { name: 'Reset', exact: true }).isVisible());
    await page.screenshot({ path: `test-results/tabs-reset-${kind.replaceAll(' ', '-')}.png` });
    await dialog.getByRole('button', { name: 'Reset', exact: true }).tap();
    await dialog.waitFor({ state: 'detached' });
}
await mkdir('test-results', { recursive: true });
try {
    await page.goto(base);
    await page.waitForFunction(() => [...document.querySelectorAll('.terminal-view')].length === 2 &&
        [...document.querySelectorAll('.terminal-view')].every(node => node.dataset.state === 'connected'));
    await page.waitForTimeout(700);
    const terminalID = (await snapshot()).workspaces[0].panels[6].terminal;
    assert.ok(terminalID);
    assert.equal(await panel('panel-0').getByRole('button', { name: 'Rename file browser', exact: true }).count(), 0);
    assert.equal((await snapshot()).workspaces[0].panels[0].name, undefined);
    let save;
    assert.equal(await panel('panel-6').locator('.panel-header').getByRole('button', { name: 'Rename terminal', exact: true }).count(), 0);
    const rename = panel('panel-6').locator('.terminal-footer').getByRole('button', { name: 'Rename terminal', exact: true });
    assert.equal(await rename.evaluate(node => node.nextElementSibling?.getAttribute('aria-label')), 'Reconnect terminal');
    await rename.click();
    await renameDialog('terminal', 'Build');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Build');
    await panel('panel-6').locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText("printf '\\033]2;Application\\007TITLE_%s\\n' IGNORED");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .xterm-rows')?.textContent.includes('TITLE_IGNORED'));
    assert.equal(await panel('panel-6').locator('.panel-title').textContent(), 'Build');
    assert.equal((await (await api(`/terminals/${terminalID}`)).json()).name, 'Build');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Build');
    assert.equal((await snapshot()).workspaces[0].panels[0].path, '/tmp');
    // File labels follow the current folder; only terminal sessions have editable names.
    const path = panel('panel-0').locator('.path-input');
    await path.fill('/var'); save = saved(); await path.press('Enter');
    assert.equal((await save).status(), 200);
    assert.equal(await path.inputValue(), '/var');
    check('footer rename precedes reconnect; manual names survive application titles, reload and file navigation');

    const workspace = id => page.locator(`.workspace-tab-item[data-workspace="${id}"]`);
    const workspaceOrder = async () => (await snapshot()).workspaces.map(ws => ws.id);
    const originalOrder = await workspaceOrder();
    const liveTerminal = await panel('panel-6').locator('.terminal-view').elementHandle();
    const connectionCount = sockets.length;
    const terminalPID = (await (await api(`/terminals/${terminalID}`)).json()).pid;
    await page.setViewportSize({ width: 1920, height: 1000 }); await page.waitForTimeout(250);
    await workspace('other-0').getByRole('button', { name: 'Workspace menu', exact: true }).click();
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Activate', 'Rename', 'Default directory', 'Close']);
    assert.ok(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isEnabled());
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    save = saved(); await renameDialog('workspace', 'A much wider workspace'); await save;
    assert.equal((await snapshot()).current, 'work', 'opening an inactive chevron does not activate it');
    await workspace('work').locator('.workspace-menu').click();
    assert.ok(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    assert.ok(await workspace('work').locator('.workspace-menu').evaluate(node => node === document.activeElement));

    async function dragWorkspace(from, to, vertical = false) {
        const source = await workspace(from).locator('.workspace-tab').boundingBox(), target = await workspace(to).boundingBox();
        const forward = vertical ? target.y > source.y : target.x > source.x;
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(vertical ? source.x + source.width / 2 : target.x + (forward ? target.width - 2 : 2),
            vertical ? target.y + (forward ? target.height - 2 : 2) : source.y + source.height / 2, { steps: 8 });
        assert.ok(await workspace(from).evaluate(node => node.classList.contains('tab-dragging')));
    }
    await dragWorkspace('work', 'other-4');
    assert.ok(await page.locator('.tab-shifting').evaluateAll(nodes => nodes.some(node => getComputedStyle(node).transform !== 'none' && parseFloat(getComputedStyle(node).transitionDuration) > 0)));
    await page.screenshot({ path: 'test-results/workspace-tabs-drag.png' });
    save = saved(); await page.mouse.up(); await save;
    assert.deepEqual(await workspaceOrder(), [...originalOrder.slice(1), 'work']);
    assert.equal((await snapshot()).current, 'work');
    assert.ok(await liveTerminal.evaluate(node => node === document.querySelector('[data-panel="panel-6"] .terminal-view')));
    assert.equal(sockets.length, connectionCount, 'reordering does not reconnect the terminal');
    assert.equal((await (await api(`/terminals/${terminalID}`)).json()).pid, terminalPID);
    await page.reload(); await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .terminal-view')?.dataset.state === 'connected');
    assert.deepEqual(await page.locator('.workspace-tabs .workspace-tab-item').evaluateAll(nodes => nodes.map(node => node.dataset.workspace)), [...originalOrder.slice(1), 'work']);
    await dragWorkspace('work', 'other-0'); save = saved(); await page.mouse.up(); await save;
    assert.deepEqual(await workspaceOrder(), originalOrder);

    for (const cancel of ['escape', 'pointercancel', 'blur', 'resize']) {
        await dragWorkspace('other-0', 'other-4');
        if (cancel === 'escape') await page.keyboard.press('Escape');
        else if (cancel === 'resize') await page.setViewportSize({ width: 1440, height: 1000 });
        else await page.evaluate(type => window.dispatchEvent(type === 'blur' ? new Event(type) : new PointerEvent(type)), cancel);
        await page.waitForFunction(() => !document.querySelector('.tab-dragging'));
        await page.mouse.up(); await page.waitForTimeout(300);
        assert.equal(await page.locator('.tab-dragging, .tab-shifting').count(), 0);
        assert.deepEqual(await workspaceOrder(), originalOrder, `${cancel} preserves order`);
        assert.equal((await snapshot()).current, 'work', 'a cancelled drag does not activate a workspace');
    }
    await page.setViewportSize({ width: 1024, height: 900 }); await page.waitForTimeout(250);
    await page.getByRole('button', { name: 'More workspaces', exact: true }).click();
    const hidden = await page.locator('.overflow-tabs .workspace-tab-item').evaluateAll(nodes => nodes.map(node => node.dataset.workspace));
    assert.ok(hidden.length >= 2);
    await dragWorkspace(hidden[0], hidden.at(-1), true);
    save = saved(); await page.mouse.up(); await save;
    const reordered = originalOrder.filter(id => id !== hidden[0]);
    reordered.splice(reordered.indexOf(hidden.at(-1)) + 1, 0, hidden[0]);
    assert.deepEqual(await workspaceOrder(), reordered, 'overflow entries reorder without losing hidden workspaces');
    assert.equal((await snapshot()).current, 'work');
    await page.setViewportSize({ width: 1920, height: 1000 }); await page.waitForTimeout(250);
    const keyboardTab = workspace('other-4').locator('.workspace-tab');
    const beforeKeyboard = await workspaceOrder(), keyboardIndex = beforeKeyboard.indexOf('other-4');
    await keyboardTab.focus(); save = saved(); await page.keyboard.press('Alt+ArrowLeft'); await save;
    const afterKeyboard = [...beforeKeyboard];
    afterKeyboard.splice(keyboardIndex, 1); afterKeyboard.splice(keyboardIndex - 1, 0, 'other-4');
    assert.deepEqual(await workspaceOrder(), afterKeyboard);
    assert.ok(await keyboardTab.evaluate(node => node === document.activeElement));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await dragWorkspace('other-4', 'work');
    assert.ok(await page.locator('.tab-shifting').evaluateAll(nodes => nodes.every(node => parseFloat(getComputedStyle(node).transitionDuration) === 0)));
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await workspace('other-0').locator('.workspace-menu').click();
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    save = saved(); await renameDialog('workspace', 'Other 0'); await save;
    await page.screenshot({ path: 'test-results/workspace-tabs-desktop.png' });
    check('workspace chevrons, animated/persisted reordering, stable terminals, cancellation, overflow, keyboard and reduced motion');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compact').waitFor(); await page.waitForTimeout(250);
    assert.equal(await page.locator('.component-tabs .panel-tools').count(), 0);
    assert.ok(await page.locator('.workspace-tabs .workspace-menu').first().isVisible());
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(250);
        for (const id of ['work', 'other-4']) {
            if (!await workspace(id).isVisible()) await page.getByRole('button', { name: 'More workspaces', exact: true }).tap();
            const arrow = workspace(id).getByRole('button', { name: 'Workspace menu', exact: true });
            const overflow = await arrow.evaluate(node => !!node.closest('.overflow-tabs'));
            const bounds = await arrow.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
            await arrow.tap(); await menu.waitFor();
            if (overflow) assert.ok(await page.locator('.overflow-tabs:popover-open').isVisible(), 'workspace options retain their overflow list');
            if (overflow) await page.screenshot({ path: `test-results/workspace-overflow-options-${width}.png` });
            assert.equal((await snapshot()).current, 'work', 'workspace arrow never activates its tab');
            assert.equal(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isDisabled(), id === 'work');
            await page.keyboard.press('Escape');
            assert.ok(await arrow.evaluate(node => node === document.activeElement));
            if (overflow) await page.keyboard.press('Escape');
        }
        for (const id of ['panel-0', 'panel-6']) {
            const label = await reveal(id), arrow = label.locator('..').getByRole('button', { name: 'Component menu', exact: true });
            const overflow = await arrow.evaluate(node => !!node.closest('.overflow-tabs'));
            const bounds = await arrow.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
            await arrow.tap(); await menu.waitFor(); assert.ok(await panel('panel-0').isVisible());
            if (overflow) assert.ok(await page.locator('.overflow-tabs:popover-open').isVisible(), 'component options retain their overflow list');
            if (overflow) await page.screenshot({ path: `test-results/component-overflow-options-${width}.png` });
            assert.equal(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isDisabled(), id === 'panel-0');
            await page.keyboard.press('Escape');
            assert.ok(await arrow.evaluate(node => node === document.activeElement));
            if (overflow) await page.keyboard.press('Escape');
        }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
    check('visible and overflow workspace/component arrows at 320/390px open menus without activation');
    await hold(await reveal('panel-0'), false);
    assert.ok(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isDisabled());
    await page.screenshot({ path: 'test-results/tabs-mobile-context.png' });
    await page.keyboard.press('Escape');
    assert.equal(await tab('panel-0').locator('.component-tab-title').textContent(), 'var');
    await path.fill('/tmp'); save = saved(); await path.press('Enter'); await save;
    assert.equal(await tab('panel-0').locator('.component-tab-title').textContent(), 'tmp');
    check('file component menu has no Rename and its label follows the folder');

    await hold(await reveal('panel-6'));
    assert.ok(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isEnabled());
    assert.ok(await panel('panel-0').isVisible(), 'holding an inactive overflow entry must not activate it');
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).tap();
    await resetDialog('terminal');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Terminal');
    assert.equal((await (await api(`/terminals/${terminalID}`)).json()).name, 'Terminal');
    await hold(await reveal('panel-6'));
    await menu.getByRole('menuitem', { name: 'Activate', exact: true }).tap();
    await panel('panel-6').waitFor({ state: 'visible' });
    assert.ok(!await panel('panel-0').isVisible());
    await rename.tap(); await renameDialog('terminal', 'Mobile');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Mobile');
    assert.equal(await tab('panel-6').locator('.component-tab-title').textContent(), 'Mobile');
    await rename.tap(); await resetDialog('terminal');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Terminal');
    assert.equal(await tab('panel-6').locator('.component-tab-title').textContent(), 'Terminal');
    assert.equal((await (await api(`/terminals/${terminalID}`)).json()).name, 'Terminal');
    await (await reveal('panel-0')).tap();
    await panel('panel-0').waitFor({ state: 'visible' });
    check('overflow long press, terminal Reset, compact footer rename, explicit activation and normal tap');

    const target = await reveal('panel-0'), point = await press(target);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: point.x + 30 }] });
    await page.waitForTimeout(600);
    assert.equal(await menu.count(), 0, 'moving a finger cancels long press');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await press(await reveal('panel-0'));
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(600); assert.equal(await menu.count(), 0);
    await press(await reveal('panel-0'));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForTimeout(600); assert.equal(await menu.count(), 0, 'resize disposes pending holds');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
    await (await reveal('panel-6')).focus(); await page.keyboard.press('Shift+F10');
    await menu.waitFor(); await page.keyboard.press('Escape');
    assert.ok(await tab('panel-6').evaluate(node => node === document.activeElement));
    assert.ok(await page.locator('.overflow-tabs:popover-open').isVisible());
    await page.keyboard.press('Escape');
    assert.ok(await page.getByRole('button', { name: 'More components', exact: true }).evaluate(node => node === document.activeElement));
    check('movement/cancel/resize cleanup and overflow keyboard focus restoration');

    await hold(page.locator('.workspace-tabs .workspace-tab.active'));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More workspaces', exact: true }).tap();
    const other = page.getByRole('button', { name: 'Other 4', exact: true });
    await hold(other);
    assert.equal(await page.locator('.workspace-tabs .workspace-tab.active').textContent(), 'Work');
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).tap();
    save = saved(); await renameDialog('workspace', 'Spare'); await save;
    await page.getByRole('button', { name: 'More workspaces', exact: true }).tap();
    await hold(page.getByRole('button', { name: 'Spare', exact: true }));
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).tap();
    await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
    assert.ok((await snapshot()).workspaces.some(ws => ws.name === 'Spare'));
    await page.getByRole('button', { name: 'More workspaces', exact: true }).tap();
    await hold(page.getByRole('button', { name: 'Spare', exact: true }));
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).tap();
    save = saved(); await page.keyboard.press('Enter'); await save;
    assert.ok(!(await snapshot()).workspaces.some(ws => ws.name === 'Spare'));
    check('visible/overflow workspace holds, inactive rename and confirmed/cancelled closure');

    await hold(await reveal('panel-6'));
    const killed = page.waitForResponse(response => response.url() === `${base}/api/terminals/${terminalID}` && response.request().method() === 'DELETE');
    await menu.getByRole('menuitem', { name: 'Close', exact: true }).tap();
    assert.equal((await killed).status(), 200);
    assert.equal((await api(`/terminals/${terminalID}`)).status(), 404);
    await panel('panel-6').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(250);
    assert.equal(await panel('panel-0').getByRole('button', { name: 'Rename file browser', exact: true }).count(), 0);
    assert.ok(await panel('panel-0').locator('.panel-header .path-input').isVisible());
    assert.ok(await page.locator('.workspace-tabs .workspace-menu').first().isVisible());
    assert.equal(await page.locator('.workspace-close, .workspace-rename').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    check('mobile Close kills the real terminal, desktop controls restore, no browser errors/external assets');
} catch (error) {
    await page.screenshot({ path: 'test-results/tabs-failure.png' });
    throw error;
} finally {
    await page.goto('about:blank');
    for (const terminal of await (await api('/terminals')).json()) await api(`/terminals/${terminal.id}`, 'DELETE');
    assert.equal((await api('/settings', 'PUT', original)).status(), 200);
    await browser.close();
}
