import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-selection-');
await mkdir(dir + '/folder');
for (let i = 0; i < 70; i++) await writeFile(`${dir}/row-${String(i).padStart(2, '0')}.txt`, `file ${i}`);
assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: true, viewport: { width: 390, height: 844 } });
for (const [asset, type] of [['favicon.png', 'image/png'], ['social-preview.jpg', 'image/jpeg']]) {
    const response = await context.request.get(`${base}/${asset}`);
    assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], type);
    assert.deepEqual(await response.body(), await readFile(`web/${asset}`), 'public asset is the reviewed static artwork');
}
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const settings = { theme: 'dark', current: 'selection', workspaces: [{ id: 'selection', name: 'Selection', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }] };
assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const touch = await context.newCDPSession(page);
const file = page.locator('.file-view'), list = file.locator('.file-list');
const row = name => file.locator('.file-entry').filter({ has: page.getByRole('checkbox', { name: `Select ${name}`, exact: true, includeHidden: true }) });
const box = name => row(name).locator('.file-select');
const all = file.getByRole('checkbox', { name: 'Select all visible files', exact: true });
const selected = () => file.locator('.file-entry[aria-selected=true] .file-name span').allTextContents();
const menu = page.locator('.menu-actions.popover-menu');
const check = message => console.log('PASS ' + message);
async function point(target) { const r = await target.boundingBox(); assert.ok(r); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }; }
async function start(target) { const p = await point(target); await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] }); return p; }
async function move(p) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); }
async function end(cancel = false) { await touch.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] }); }
async function ready() { await list.locator('.file-entry').first().waitFor(); await file.locator('.file-list:not(.loading)').waitFor(); }
async function navigate(path) { await page.locator('.path-input').fill(path); await page.locator('.path-input').press('Enter'); await page.waitForFunction(path => document.querySelector('.path-input')?.value === path && !document.querySelector('.file-list.loading'), path); }
try {
    await page.goto(base); await ready();
    assert.equal(await page.locator('meta[property="og:image"]').getAttribute('content'), base + '/social-preview.jpg');
    assert.equal(await page.locator('meta[name="twitter:card"]').getAttribute('content'), 'summary_large_image');
    const dimensions = await page.evaluate(async () => Promise.all(['/favicon.png', '/social-preview.jpg'].map(async src => { const img = new Image(); img.src = src; await img.decode(); return [img.naturalWidth, img.naturalHeight]; })));
    assert.deepEqual(dimensions, [[64, 64], [1200, 630]]);
    check('public favicon and social preview bytes, MIME types, dimensions and metadata');

    await touch.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await row('folder').locator('.file-name svg').tap();
    assert.deepEqual(await selected(), ['folder']);
    assert.equal(await page.locator('.path-input').inputValue(), dir, 'one tap only selects');
    await page.waitForTimeout(150);
    await row('folder').locator('.file-name span').tap();
    await page.waitForFunction(path => document.querySelector('.path-input').value === path, dir + '/folder', { timeout: 3000 });
    await navigate(dir); await ready();
    await row('folder').locator('.file-name').tap(); await page.waitForTimeout(450);
    await row('folder').locator('.file-name').tap();
    assert.equal(await page.locator('.path-input').inputValue(), dir, 'separate taps do not open');
    await row('row-00.txt').locator('.file-name').tap();
    assert.equal(await file.locator('.file-inspector').count(), 0, 'tapping another row only selects');
    await row('folder').getByRole('checkbox').tap();
    await row('folder').locator('.file-name').tap();
    assert.equal(await page.locator('.path-input').inputValue(), dir, 'checkbox taps do not count toward opening');
    await all.check(); await all.uncheck();
    await touch.send('Emulation.clearDeviceMetricsOverride');
    await page.setViewportSize({ width: 390, height: 844 });
    check('touch double-tap across icon/text opens a folder after single-tap selection');

    await box('row-00.txt').tap(); assert.deepEqual(await selected(), ['row-00.txt']);
    assert.ok(await all.evaluate(input => input.indeterminate));
    await box('row-00.txt').tap(); assert.deepEqual(await selected(), []);
    await all.tap(); assert.equal((await selected()).length, 71); assert.ok(await all.isChecked());
    await all.tap(); assert.deepEqual(await selected(), []);
    await row('row-00.txt').getByRole('checkbox').focus(); await page.keyboard.press('Space');
    assert.deepEqual(await selected(), ['row-00.txt']); await page.keyboard.press('Space'); assert.deepEqual(await selected(), []);
    check('independent checkbox taps, all/none/mixed and keyboard Space');

    await start(box('row-00.txt')); await move(await point(box('row-03.txt'))); await move(await point(box('row-01.txt'))); await move(await point(box('row-04.txt'))); await end();
    assert.deepEqual(await selected(), ['row-00.txt', 'row-01.txt', 'row-02.txt', 'row-03.txt', 'row-04.txt']);
    assert.equal(await file.locator('.file-inspector, .file-drag-group, .file-selection-box').count(), 0);
    await start(box('row-04.txt')); await move(await point(box('row-02.txt'))); await move(await point(box('row-03.txt'))); await end();
    assert.deepEqual(await selected(), ['row-00.txt', 'row-01.txt']);
    await start(box('row-02.txt')); await move(await point(box('row-05.txt'))); await end(true);
    assert.deepEqual(await selected(), ['row-00.txt', 'row-01.txt']);
    await row('row-02.txt').getByRole('checkbox').focus(); await page.keyboard.press('Space');
    assert.deepEqual(await selected(), ['row-00.txt', 'row-01.txt', 'row-02.txt'], 'keyboard input after touch cancellation must work without a new pointerdown');
    await page.keyboard.press('Space'); assert.deepEqual(await selected(), ['row-00.txt', 'row-01.txt']);
    check('select/deselect sweeps include skipped rows, reverse without toggling twice and roll back cancellation');

    // Existing selected-item actions must consume exactly the checkbox-selected entries.
    await file.getByRole('button', { name: 'File actions', exact: true }).tap();
    await menu.getByRole('menuitem', { name: 'Copy selected', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Copy selected items', exact: true });
    await dialog.getByRole('textbox').fill(dir + '/folder'); await dialog.getByRole('button', { name: 'Continue', exact: true }).tap();
    await page.waitForFunction(() => !document.querySelector('.transfer:not(.done)'));
    for (let i = 0; i < 100; i++) { try { await readFile(dir + '/folder/row-01.txt'); break; } catch { await page.waitForTimeout(25); } }
    assert.equal(await readFile(dir + '/folder/row-00.txt', 'utf8'), 'file 0');
    assert.equal(await readFile(dir + '/folder/row-01.txt', 'utf8'), 'file 1');
    await assert.rejects(readFile(dir + '/folder/row-02.txt'));
    await ready();
    await file.getByRole('button', { name: 'Filter files', exact: true }).tap();
    await file.getByRole('searchbox').fill('row-00'); assert.ok(await all.isChecked());
    await all.tap(); assert.deepEqual(await selected(), []);
    await file.getByRole('searchbox').fill('row-01'); assert.ok(await all.isChecked(), 'filtered select-all preserves hidden selection');
    await file.getByRole('searchbox').press('Escape');
    await rm(dir + '/row-01.txt'); await file.getByRole('button', { name: 'Refresh files', exact: true }).tap(); await ready(); assert.deepEqual(await selected(), []);
    await box('row-00.txt').tap(); await navigate(dir + '/folder'); await ready(); assert.deepEqual(await selected(), []); assert.ok(!await all.isChecked());
    await navigate(dir); await ready();
    check('selected actions operate on exact files; header follows filtering, refresh and navigation');

    await start(row('row-00.txt').locator('.file-name')); await page.waitForTimeout(620); await menu.waitFor(); await end();
    assert.equal(await menu.getByRole('menuitem', { name: 'Open', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => getSelection().toString()), '');
    assert.equal(await file.locator('.file-inspector').count(), 0);
    await page.keyboard.press('Escape');
    const p = await start(row('row-03.txt').locator('.file-name'));
    for (let i = 1; i <= 8; i++) { await move({ ...p, y: p.y - i * 20 }); await page.waitForTimeout(20); }
    await end(); await page.waitForTimeout(650);
    assert.ok(await list.evaluate(node => node.scrollTop > 0)); assert.equal(await menu.count(), 0);
    assert.equal(await file.locator('.file-inspector').count(), 0);
    await list.evaluate(node => { node.scrollTop = 0; }); await page.waitForTimeout(200);
    await start(row('row-00.txt').locator('.file-name')); await end(true); await page.waitForTimeout(600); assert.equal(await menu.count(), 0);
    await row('row-00.txt').focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor(); await page.keyboard.press('Escape');
    assert.ok(await row('row-00.txt').evaluate(node => node === document.activeElement));
    check('file long press, native-scroll/cancel exclusion and keyboard context menus');

    await all.tap(); await all.tap();
    await start(box('row-00.txt')); const bounds = await list.boundingBox(); const edge = { ...(await point(box('row-00.txt'))), y: bounds.y + bounds.height - 2 };
    await move(edge); await page.waitForFunction(() => document.querySelector('.file-list').scrollTop > 200); await end();
    assert.ok((await selected()).length > 15); const stopped = await list.evaluate(node => node.scrollTop); await page.waitForTimeout(100); assert.equal(await list.evaluate(node => node.scrollTop), stopped);
    await list.evaluate(node => { node.scrollTop = 0; });
    check('selection-column edge scrolling stops at release');

    for (const theme of ['dark', 'light']) {
        if (theme === 'light') await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).tap();
        await page.setViewportSize({ width: 320, height: 568 }); await page.waitForTimeout(200);
        await page.getByRole('button', { name: 'About Tuxee', exact: true }).tap();
        const about = page.getByRole('dialog', { name: 'About Tuxee', exact: true }), close = about.getByRole('button', { name: 'Close dialog', exact: true });
        await about.getByRole('rowheader', { name: 'Shell', exact: true }).waitFor();
        const before = await close.boundingBox();
        await about.locator('.modal-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
        assert.deepEqual(await close.boundingBox(), before);
        assert.ok(await close.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node || node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
        await mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/mobile-modal-${theme}.png` });
        await close.focus(); await page.keyboard.press('Enter'); await about.waitFor({ state: 'detached' });
        await page.screenshot({ path: `test-results/mobile-selection-${theme}.png` });
    }
    check('shared modal close stays fixed, clickable and keyboard-accessible while About scrolls in both themes');
    await page.setViewportSize({ width: 390, height: 844 });
    await list.evaluate(node => { node.scrollTop = 0; });
    for (const preselected of [false, true]) {
        await all.check(); await all.uncheck();
        if (preselected) {
            await row('row-00.txt').getByRole('checkbox').check();
            await row('row-02.txt').getByRole('checkbox').check();
        }
        const previous = await selected(), startBox = await point(box('row-00.txt')), endBox = await point(box('row-04.txt'));
        await page.mouse.move(startBox.x, startBox.y); await page.mouse.down();
        await page.mouse.move(endBox.x, endBox.y, { steps: 8 });
        await page.mouse.move(startBox.x, startBox.y, { steps: 8 });
        assert.notDeepEqual(await selected(), previous);
        await page.keyboard.press('Escape'); assert.deepEqual(await selected(), previous);
        // The button may remain held after Escape, even when the sweep returns to its start.
        await page.waitForTimeout(100); await page.mouse.up();
        assert.deepEqual(await selected(), previous, 'cancelled sweep must stay cancelled after delayed release');
        assert.equal(await row('row-00.txt').getByRole('checkbox').isChecked(), preselected);
        await box('row-00.txt').click();
        assert.deepEqual(await selected(), preselected ? ['row-02.txt'] : ['row-00.txt'], 'next independent click must work');
        await row('row-00.txt').getByRole('checkbox').focus(); await page.keyboard.press('Space');
        assert.deepEqual(await selected(), previous, 'keyboard selection must still work');
    }
    check('Escape preserves empty/nonempty selections through delayed reversed-sweep release and subsequent input');
    const beforeResize = await selected();
    for (const [width, height, compact] of [[1440, 1000, false], [759, 844, true], [760, 844, false], [1440, 479, true], [1440, 480, false], [390, 844, true], [1440, 1000, false]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(compact => document.querySelector('.board').classList.contains('compact-board') === compact, compact);
        assert.equal(await file.locator('.file-select:visible').count(), compact ? await list.locator('.file-entry').count() + 1 : 0);
        assert.equal(await file.getByRole('checkbox').count(), compact ? await list.locator('.file-entry').count() + 1 : 0, 'desktop checkboxes must also be absent from the accessibility tree');
        assert.deepEqual(await selected(), beforeResize, 'resizing preserves selection');
    }
    await row('row-00.txt').click();
    const offsets = await file.evaluate(node => {
        const row = node.querySelector('.file-entry'), name = row.querySelector('.file-name').getBoundingClientRect();
        return [node.querySelector('[data-column=name]').getBoundingClientRect().x - name.x, name.x - row.getBoundingClientRect().x];
    });
    assert.ok(Math.abs(offsets[0]) < 1); assert.ok(Math.abs(offsets[1] - 8) < 1, 'desktop has no empty checkbox column');
    await row('row-02.txt').click({ modifiers: ['Control'] });
    assert.deepEqual(await selected(), ['row-00.txt', 'row-02.txt']);
    await row('row-04.txt').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selected(), ['row-02.txt', 'row-03.txt', 'row-04.txt']);
    await row('row-00.txt').click();
    const rectangleStart = await point(row('row-02.txt').locator('.file-size')), rectangleEnd = await point(row('row-04.txt').locator('.file-size'));
    await page.mouse.move(rectangleStart.x, rectangleStart.y); await page.mouse.down();
    await page.mouse.move(rectangleEnd.x + 10, rectangleEnd.y, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await selected(), ['row-02.txt', 'row-03.txt', 'row-04.txt']);
    await row('row-04.txt').focus(); await page.keyboard.press('Space');
    assert.deepEqual(await selected(), ['row-02.txt', 'row-03.txt']);
    check('checkboxes are compact-only across viewport changes; desktop click, modifier, rectangle and keyboard selection work');
    await row('row-00.txt').click({ button: 'right' }); await menu.waitFor(); await page.keyboard.press('Escape');
    await row('row-00.txt').locator('.file-name').dblclick(); await file.locator('.cm-content').waitFor();
    await file.locator('.cm-content').click(); await page.keyboard.press('Control+a');
    assert.equal(await page.evaluate(() => getSelection().toString()), 'file 0');
    assert.deepEqual(errors, []);
    check('desktop right-click and editor text selection remain usable');
} catch (error) {
    console.log('Browser errors:', errors); await page.screenshot({ path: 'test-results/mobile-files-failure.png' }); throw error;
} finally {
    await page.goto('about:blank'); await api('/settings', 'PUT', me.settings);
    await browser.close(); await rm(dir, { recursive: true, force: true });
}
