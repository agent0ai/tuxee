import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', {
    data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' },
})).status(), 200);
const { csrf } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, {
    method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
});
const panels = Array.from({ length: 8 }, (_, index) => ({
    id: `panel-${index}`, kind: index < 6 ? 'files' : 'terminal', path: '/tmp',
    x: index % 4, y: Math.floor(index / 4), w: 1, h: 1,
}));
const settings = {
    theme: 'dark', idleHours: 36, current: 'work',
    workspaces: [
        { id: 'work', name: 'Work', columns: 4, rows: 2, active: panels[0].id, panels },
        ...Array.from({ length: 5 }, (_, index) => ({
            id: `other-${index}`, name: `Other ${index}`, columns: 4, rows: 2, active: '', panels: [],
        })),
    ],
};
assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
const page = await context.newPage(), errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (!request.url().startsWith(base + '/') && !/^(data|blob):/.test(request.url())) external.push(request.url());
});
const touch = await context.newCDPSession(page);
const menu = page.locator('.menu-actions.popover-menu');
const panel = id => page.locator(`[data-panel="${id}"]`);
const tab = id => page.locator(`[data-component-name="${id}"]`);
const title = id => panel(id).locator('.panel-title');
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
async function hold(target) {
    await press(target);
    await page.waitForTimeout(600);
    await menu.waitFor();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    assert.ok(await menu.isVisible(), 'releasing a hold must leave its menu open');
    assert.equal(await page.locator('dialog').count(), 0, 'release must not invoke a menu action');
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Activate', 'Rename', 'Close']);
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
    const alias = 'Projects <&>';
    await panel('panel-0').getByRole('button', { name: 'Rename file browser', exact: true }).click();
    let save = saved();
    await renameDialog('file browser', alias);
    assert.equal((await save).status(), 200);
    assert.equal(await title('panel-0').textContent(), alias);
    assert.equal((await snapshot()).workspaces[0].panels[0].name, alias);
    await panel('panel-6').getByRole('button', { name: 'Rename terminal', exact: true }).click();
    await renameDialog('terminal', 'Build');
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Build');
    assert.equal((await (await api(`/terminals/${terminalID}`)).json()).name, 'Build');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-panel="panel-6"] .panel-title')?.textContent === 'Build');
    assert.equal(await title('panel-0').textContent(), alias);
    assert.equal((await snapshot()).workspaces[0].panels[0].path, '/tmp');
    // Navigation retains an override without renaming any filesystem entry.
    const path = panel('panel-0').locator('.path-input');
    await path.fill('/var'); save = saved(); await path.press('Enter');
    assert.equal((await save).status(), 200);
    assert.equal(await title('panel-0').textContent(), alias);
    check('desktop file/terminal rename icons, saved labels, reload and folder navigation');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compact').waitFor(); await page.waitForTimeout(250);
    assert.equal(await page.locator('.component-tabs .panel-tools, .workspace-close, .workspace-rename').count(), 0);
    await hold(await reveal('panel-0'));
    assert.ok(await menu.getByRole('menuitem', { name: 'Activate', exact: true }).isDisabled());
    await page.screenshot({ path: 'test-results/tabs-mobile-context.png' });
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).tap();
    save = saved(); await resetDialog('file browser'); assert.equal((await save).status(), 200);
    assert.equal(await title('panel-0').textContent(), 'var');
    assert.equal((await snapshot()).workspaces[0].panels[0].name, undefined);
    await path.fill('/tmp'); save = saved(); await path.press('Enter'); await save;
    assert.equal(await title('panel-0').textContent(), 'tmp');
    check('visible mobile long press opens menu without activation; Reset follows current folder');

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
    await (await reveal('panel-0')).tap();
    await panel('panel-0').waitFor({ state: 'visible' });
    check('overflow long press, terminal Reset, explicit activation and normal tap');

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
    assert.ok(await panel('panel-0').getByRole('button', { name: 'Rename file browser', exact: true }).isVisible());
    assert.ok(await page.locator('.workspace-tabs .workspace-close').first().isVisible());
    assert.ok(await page.locator('.workspace-tabs .workspace-rename').first().isVisible());
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    check('mobile Close kills the real terminal, desktop controls restore, no browser errors/external assets');
} catch (error) {
    await page.screenshot({ path: 'test-results/tabs-failure.png' });
    throw error;
} finally {
    await page.goto('about:blank');
    for (const terminal of await (await api('/terminals')).json()) await api(`/terminals/${terminal.id}`, 'DELETE');
    await browser.close();
}
