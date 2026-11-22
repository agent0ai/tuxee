import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const base = process.env.TUXEE_TEST_URL, user = process.env.TUXEE_TEST_USER, password = process.env.TUXEE_TEST_PASSWORD;
assert.ok(base && user && password, 'supply a fresh marked test account and isolated server');
const container = process.env.TUXEE_TEST_CONTAINER;
const account = spawnSync(container ? 'docker' : 'getent', container ? ['exec', container, 'getent', 'passwd', user] : ['passwd', user], { encoding: 'utf8' });
assert.equal(account.status, 0); assert.equal(account.stdout.trim().split(':')[4], 'Tuxee prototype test');
const output = 'test-results/panel-startup', results = [], errors = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
let page, api;
try {
    page = await appPage(context); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    if (process.env.TUXEE_TEST_LANGUAGE) {
        await page.locator('[name=language]').selectOption(process.env.TUXEE_TEST_LANGUAGE);
        await page.waitForFunction(language => document.documentElement.lang === language && !document.querySelector('[name=language]').disabled, process.env.TUXEE_TEST_LANGUAGE);
    }
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.locator('button[type=submit]').click();
    await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    const me = await (await context.request.get(base + '/api/me')).json();
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf } });
    const snapshot = async () => (await (await api('/me')).json()).settings;
    assert.equal((await snapshot()).workspaces.length, 1, 'start with the real first-login desktop');
    async function settled() {
        await page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.target?.matches?.('.grid-stack-item, .workspace-track')));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    }
    async function choose(position) {
        await page.locator('.user-menu-button').click(); await page.locator('.account-menu [data-action=Settings]').click();
        await page.locator('[name=panelPosition]').selectOption(position);
        await page.screenshot({ path: `${output}/settings-${position}-${await page.locator('html').getAttribute('data-theme')}.png` });
        await page.locator('dialog:has(.settings-form) .modal-footer button[type=submit]').click();
        await page.locator('.settings-form').waitFor({ state: 'detached' });
        await page.locator(`#app[data-panel-position=${position}]`).waitFor(); await settled();
    }
    async function capture(name, expected, windows = 0) {
        await settled();
        const geometry = await page.evaluate(() => {
            const list = document.querySelector('.workspace-tabs > .visible-tabs'), active = list.querySelector(':scope > .active');
            const rect = n => n.getBoundingClientRect().toJSON();
            const rows = [...list.children].map(n => ({ id: n.dataset.workspace, rect: rect(n) }));
            const tab = active?.querySelector('.workspace-tab'), more = document.querySelector('.workspace-tab-actions > .overflow-toggle, .workspace-tabs > .overflow-toggle');
            const topbar = document.querySelector('.topbar'), controls = document.querySelector('.topbar-right');
            return { rows, active: active && rect(active), label: tab && rect(tab), list: rect(list), overflow: !more.hidden,
                bottomGap: rect(topbar).bottom - rect(controls).bottom - parseFloat(getComputedStyle(topbar).paddingBottom),
                plus: rect(document.querySelector('.workspace-add')), vertical: document.querySelector('#app').classList.contains('side-panel'),
                windows: document.querySelectorAll('.component-tabs > .visible-tabs > .component-tab-item').length,
                windowOverflow: !document.querySelector('.component-tabs > .overflow-toggle').hidden, origin: [scrollX, scrollY] };
        });
        const png = await page.screenshot({ path: `${output}/${name}.png` });
        assert.equal(geometry.rows.length, expected, name + ': all sparse desktop tabs remain visible');
        assert.equal(geometry.overflow, false, name + ': no unnecessary desktop overflow');
        assert.ok(geometry.active, name + ': active desktop is visible');
        assert.deepEqual(geometry.origin, [0, 0]);
        if (geometry.vertical) {
            assert.ok(Math.abs(geometry.bottomGap) < .1, name + ': bottom controls remain anchored to the viewport bottom');
            assert.equal(geometry.windows, windows, name + ': all sparse window rows remain visible');
            assert.equal(geometry.windowOverflow, false, name + ': no unnecessary window overflow');
            assert.ok(geometry.plus.y >= geometry.rows.at(-1).rect.bottom && geometry.plus.y - geometry.rows.at(-1).rect.bottom <= 5, name + ': Plus immediately follows the tabs');
            const missing = await page.evaluate(async ({ png, geometry }) => {
                const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
                const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
                const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
                const node = document.querySelector('.workspace-tabs > .visible-tabs > .active');
                const style = getComputedStyle(node, '::before'), color = style.borderBottomColor.match(/\d+/g).slice(0, 3).map(Number);
                const { active: r, label } = geometry, bottom = label.bottom + 1, scale = image.width / innerWidth;
                return [['top', r.x + r.width / 2, r.y + .5], ['bottom', r.x + r.width / 2, bottom - .5],
                    ['left', r.x + .5, r.y + 15], ['right', r.right - .5, r.y + 15]].filter(([, x, y]) => {
                    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                        const pixel = ctx.getImageData(Math.floor(x * scale) + dx, Math.floor(y * scale) + dy, 1, 1).data;
                        if (color.every((v, i) => Math.abs(v - pixel[i]) <= 8)) return false;
                    }
                    return true;
                }).map(([edge]) => edge);
            }, { png: png.toString('base64'), geometry });
            assert.deepEqual(missing, [], name + ': all four highlight borders appear in the screenshot');
        }
        results.push({ name, ...geometry });
    }
    for (const theme of ['dark', 'light']) {
        if ((await snapshot()).theme !== theme) await page.locator('.theme-toggle').click();
        for (const position of ['left', 'right', 'bottom', 'top']) {
            await choose(position); await capture(`fresh-${theme}-${position}`, 1);
            await page.reload(); await page.locator('.terminal-view[data-state=connected]').first().waitFor();
            await capture(`reload-${theme}-${position}`, 1);
        }
    }
    await choose('left'); await page.locator('.workspace-add').click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-tab-item').length === 2);
    await page.locator('.board:not([inert]) .terminal-view[data-state=connected]').first().waitFor();
    for (const theme of ['dark', 'light']) {
        if ((await snapshot()).theme !== theme) await page.locator('.theme-toggle').click();
        for (const position of ['left', 'right']) {
            await choose(position);
            for (const index of [0, 1]) {
                await page.locator('.workspace-tabs > .visible-tabs > .workspace-tab-item > .workspace-tab').nth(index).click();
                await capture(`two-${theme}-${position}-active${index}`, 2);
            }
            const minimize = page.locator('.board:not([inert]) .window-minimize:visible');
            for (const count of [1, 2]) {
                await minimize.first().click(); await capture(`minimized-${theme}-${position}-${count}`, 2, count);
            }
            for (const count of [1, 0]) {
                await page.locator('.component-tabs > .visible-tabs [data-component-name]').first().click();
                await capture(`restored-${theme}-${position}-${count}`, 2, count);
            }
        }
    }
    const empty = await snapshot();
    empty.workspaces.forEach(workspace => { workspace.panels = []; delete workspace.maximized; });
    for (const count of [2, 1]) {
        empty.workspaces = empty.workspaces.slice(0, count); empty.current = empty.workspaces.at(-1).id;
        await page.goto('about:blank'); assert.equal((await api('/settings', 'PUT', empty)).status(), 200);
        await page.goto(base); await page.locator('.workspace-tabs .workspace-tab-item.active').waitFor();
        for (const theme of ['dark', 'light']) {
            if ((await snapshot()).theme !== theme) await page.locator('.theme-toggle').click();
            for (const position of ['left', 'right']) {
                await choose(position); await capture(`empty-${count}-${theme}-${position}`, count);
            }
        }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${results.length} fresh-login/Settings/reload/activation/minimize/restore/empty screenshots, both themes and all panel positions; complete border pixels.`);
} catch (error) {
    await page?.screenshot({ path: output + '/failure.png' }).catch(() => {}); throw error;
} finally {
    await writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    await page?.goto('about:blank').catch(() => {});
    if (api) for (const terminal of await (await api('/terminals')).json()) await api('/terminals/' + terminal.id, 'DELETE');
    await browser.close();
}
