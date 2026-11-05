import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const catalog = JSON.parse(await readFile('internal/i18n/locales/en.json', 'utf8'));
const bundle = await build({ stdin: { contents: `
    import { modal, ask, confirmAction, button, el } from './web/ui';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: 'ltr', texts: ${JSON.stringify(catalog.texts)}, languages: [], cookie: '' });
    window.modalClosed = [];
    window.openModal = (id, scroll = false) => {
        const content = el('div');
        content.append(el('input'));
        if (scroll) for (let i = 0; i < 100; i++) content.append(el('p', '', 'Scrollable content ' + i));
        const { dialog } = modal(id, content); dialog.id = id;
        dialog.addEventListener('close', () => window.modalClosed.push(id));
        return dialog;
    };
    window.ask = () => ask('Rename', 'Name', 'Original').then(value => window.result = value);
    window.confirm = () => confirmAction('Delete?', 'Keep on cancellation').then(value => window.result = value);
    document.body.append(button('Open', undefined, () => openModal('parent')));
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox'] });
try {
    for (const viewport of [{ width: 1000, height: 700 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport, hasTouch: true }), errors = [];
        page.setDefaultTimeout(5000);
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<body></body>');
        await page.addStyleTag({ path: 'web/style.css' });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const count = async expected => assert.equal(await page.locator('dialog[open]').count(), expected);
        const backdrop = { x: 3, y: 3 };
        const clickOutside = () => page.mouse.click(backdrop.x, backdrop.y);
        const drag = async (start, end, back = false) => {
            await page.mouse.move(start.x, start.y); await page.mouse.down();
            await page.mouse.move(end.x, end.y, { steps: 8 });
            if (back) await page.mouse.move(start.x, start.y, { steps: 8 });
            await page.mouse.up();
        };
        await page.getByRole('button', { name: 'Open', exact: true }).click(); await count(1);
        const parent = page.locator('#parent');
        const rect = await parent.boundingBox();
        await page.mouse.click(rect.x + 5, rect.y + 5); await count(1); // Dialog padding is not its backdrop.
        const input = await parent.locator('input').boundingBox();
        await drag({ x: input.x + 10, y: input.y + 10 }, backdrop); await count(1);
        await drag(backdrop, { x: input.x + 10, y: input.y + 10 }); await count(1);
        await drag(backdrop, { x: 80, y: 3 }); await count(1);
        await drag(backdrop, { x: 80, y: 3 }, true); await count(1);
        await page.mouse.click(3, 3, { button: 'right' }); await count(1);
        for (const type of ['pointercancel', 'blur']) {
            await page.mouse.move(3, 3); await page.mouse.down();
            await page.evaluate(type => window.dispatchEvent(new Event(type)), type);
            await page.mouse.up(); await count(1);
        }
        await clickOutside(); await parent.waitFor({ state: 'detached' }); await count(0);
        assert.ok(await page.getByRole('button', { name: 'Open', exact: true }).evaluate(node => node === document.activeElement), 'dismissal restores focus without clicking through');

        await page.evaluate(() => { openModal('parent'); openModal('middle'); openModal('top'); });
        await clickOutside(); await page.locator('#top').waitFor({ state: 'detached' }); await count(2);
        await page.keyboard.press('Escape'); await page.locator('#middle').waitFor({ state: 'detached' }); await count(1);
        // A click over the lower dialog must still dismiss only the top one.
        await page.evaluate(() => { const top = openModal('small'); top.style.width = '160px'; });
        const lower = await parent.boundingBox();
        await page.mouse.click(lower.x + 5, lower.y + lower.height / 2);
        await page.locator('#small').waitFor({ state: 'detached' }); await count(1);
        await page.touchscreen.tap(3, 3); await parent.waitFor({ state: 'detached' }); await count(0);

        await page.evaluate(() => { const guarded = openModal('guarded'); guarded.oncancel = event => event.preventDefault(); });
        await clickOutside(); await count(1);
        await page.keyboard.press('Escape'); await count(1);
        await page.evaluate(() => document.querySelector('#guarded').oncancel = null);
        await clickOutside(); await page.locator('#guarded').waitFor({ state: 'detached' });

        await page.evaluate(() => openModal('scroll', true));
        const body = page.locator('#scroll .modal-body');
        const scroll = await body.boundingBox();
        await page.mouse.move(scroll.x + scroll.width - 4, scroll.y + 12); await page.mouse.down();
        await page.mouse.move(scroll.x + scroll.width - 4, scroll.y + 100, { steps: 8 });
        await page.waitForFunction(() => document.querySelector('#scroll .modal-body').scrollTop > 0);
        await page.mouse.move(3, 3, { steps: 8 }); await page.mouse.up(); await count(1);
        await clickOutside(); await page.locator('#scroll').waitFor({ state: 'detached' });

        await page.evaluate(() => { window.result = 'pending'; void ask(); });
        await page.locator('dialog input').fill('Unsaved');
        await clickOutside(); await page.waitForFunction(() => window.result === null); await count(0);
        await page.evaluate(() => { window.result = 'pending'; void confirm(); });
        await clickOutside(); await page.waitForFunction(() => window.result === false); await count(0);
        assert.deepEqual(await page.evaluate(() => window.modalClosed), ['parent', 'top', 'middle', 'small', 'parent', 'guarded', 'scroll']);
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log('PASS modal backdrop clicks/taps, topmost-only dismissal, drag/scrollbar/cancellation guards, focus and cancelled forms');
} finally { await browser.close(); }
