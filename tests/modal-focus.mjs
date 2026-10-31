import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-modal-focus-');
await writeFile(dir + '/keep.txt', 'Keep this file.\n');
await chown(dir, Number(fields[2]), Number(fields[3]));
await chown(dir + '/keep.txt', Number(fields[2]), Number(fields[3]));
const state = await mkdtemp('/tmp/tuxee-modal-focus-');
const server = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, context, api, originalSettings;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => {
            const match = String(data).match(/listening at (http:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    context = await browser.newContext();
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const me = await (await context.request.get(base + '/api/me')).json();
    originalSettings = me.settings;
    api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const page = await appPage(context), errors = [], failures = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await mkdir('test-results', { recursive: true });

    async function focusRing(dialog, name, label) {
        const target = dialog.getByRole('button', { name, exact: true });
        for (let i = 0; i < 20 && !await target.evaluate(node => node === document.activeElement && node.matches(':focus-visible')); i++)
            await page.keyboard.press('Tab');
        assert.ok(await target.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), `keyboard focus: ${label}`);
        const bounds = await target.boundingBox();
        const png = (await page.screenshot({ path: `test-results/modal-focus-${label}.png` })).toString('base64');
        const missing = await target.evaluate(async (node, { png, bounds }) => {
            const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            const color = getComputedStyle(node).outlineColor.match(/\d+/g).slice(0, 3).map(Number);
            const edges = [
                ['top', bounds.x + bounds.width / 2, bounds.y - 3],
                ['right', bounds.x + bounds.width + 3, bounds.y + bounds.height / 2],
                ['bottom', bounds.x + bounds.width / 2, bounds.y + bounds.height + 3],
                ['left', bounds.x - 3, bounds.y + bounds.height / 2],
            ];
            return edges.filter(([, x, y]) => {
                const pixel = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
                return color.some((value, i) => Math.abs(value - pixel[i]) > 15);
            }).map(([edge]) => edge);
        }, { png, bounds });
        if (missing.length) failures.push(`${label}: clipped ${missing.join(', ')}`);
        assert.ok(await dialog.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth;
        }), `modal must stay inside viewport: ${label}`);
    }

    for (const theme of ['dark', 'light']) {
        assert.equal((await api('/settings', 'PUT', {
            ...originalSettings, theme, current: 'focus',
            workspaces: [{ id: 'focus', name: 'Focus', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }],
        })).status(), 200);
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 360 }]) {
            await page.setViewportSize(viewport); await page.goto(base);
            const row = page.locator('.file-entry').filter({ hasText: 'keep.txt' });
            await row.waitFor(); await row.click(); await page.keyboard.press('Delete');
            const deletion = page.getByRole('dialog', { name: 'Delete selected items?', exact: true });
            await deletion.waitFor();
            const label = `${theme}-${viewport.width}x${viewport.height}`;
            await focusRing(deletion, 'Move to bin', `${label}-delete`);
            await page.keyboard.press('Shift+Tab');
            await focusRing(deletion, 'Cancel', `${label}-cancel`);
            await page.keyboard.press('Enter'); await deletion.waitFor({ state: 'detached' });
            assert.equal(await readFile(dir + '/keep.txt', 'utf8'), 'Keep this file.\n');

            await row.focus(); await page.keyboard.press('F2');
            const rename = page.getByRole('dialog', { name: 'Rename', exact: true });
            await rename.waitFor(); await focusRing(rename, 'Continue', `${label}-rename`);
            await page.keyboard.press('Escape'); await rename.waitFor({ state: 'detached' });

            await row.click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
            const properties = page.getByRole('dialog', { name: 'Properties', exact: true });
            await properties.waitFor(); await focusRing(properties, 'Apply', `${label}-permissions`);
            await page.keyboard.press('Escape'); await properties.waitFor({ state: 'detached' });

            await page.getByRole('button', { name: 'User menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
            const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
            await settings.waitFor();
            const head = await settings.locator('.modal-head').boundingBox();
            await focusRing(settings, 'Save', `${label}-save`);
            assert.deepEqual(await settings.locator('.modal-head').boundingBox(), head, 'scrolling must keep the header in place');
            if (viewport.height === 360) assert.ok(await settings.locator('.modal-body').evaluate(node => node.scrollHeight > node.clientHeight && node.scrollTop > 0), 'short screens exercise scrolling to Save');
            await focusRing(settings, 'Close dialog', `${label}-close`);
            await page.keyboard.press('Escape'); await settings.waitFor({ state: 'detached' });
        }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, [], 'all four sides of each keyboard focus ring must be visible');
    console.log('PASS modal focus screenshots: Delete/Cancel, Rename, Properties and Settings, both themes, desktop/mobile/short screens, scrolling and keyboard cancellation.');
} finally {
    try { if (originalSettings && api) assert.equal((await api('/settings', 'PUT', originalSettings)).status(), 200); }
    finally {
        await browser?.close();
        server.kill('SIGTERM'); await stopped;
        await rm(state, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
    }
}
