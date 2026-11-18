import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

const styles = await readFile('web/style.css', 'utf8');
const catalog = JSON.parse(await readFile('internal/i18n/locales/en.json', 'utf8'));

const bundle = await build({ stdin: { contents: `
    import { overflowTabs } from './web/overflow';
    import { button } from './web/ui';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: document.documentElement.dir, texts: ${JSON.stringify(catalog.texts)}, languages: [], cookie: '' });
    const host = document.querySelector('#host');
    const items = ['first', 'second', 'third'].map((id, i) => {
        const item = document.createElement('div'), handle = document.createElement('button');
        item.id = id; item.className = 'workspace-tab-item'; handle.className = 'workspace-tab';
        handle.textContent = id; handle.style.width = [40, 120, 60][i] + 'px';
        item.append(handle, button('Menu', 'ChevronDown', undefined, 'workspace-menu')); return item;
    });
    window.order = items.map(item => item.id);
    overflowTabs(host, items, 'More', next => { window.order = next.map(item => item.id); });
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    for (const dir of ['ltr', 'rtl']) for (const theme of ['dark', 'light']) {
        const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
        await page.setContent(`<html dir="${dir}" data-theme="${theme}"><style>
            #host { width: 500px; display: flex; gap: 4px; }
            .visible-tabs { display: flex; gap: 4px; min-width: 0; }
            .visible-tabs > *, .overflow-toggle { flex-shrink: 0; }
            button { height: 35px; }
            [hidden] { display: none !important; }
            .popover-menu { position: fixed; inset: auto; margin: 0; }
            .overflow-tabs:popover-open { display: flex; flex-direction: column; gap: 4px; }
        </style><div id="host"></div></html>`);
        await page.addStyleTag({ content: styles });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const order = () => page.evaluate(() => window.order);
        await page.locator('#first .workspace-tab').focus();
        await page.keyboard.press(dir === 'rtl' ? 'Alt+ArrowLeft' : 'Alt+ArrowRight');
        assert.deepEqual(await order(), ['second', 'first', 'third'], `${dir}: physical arrow follows visual order`);
        await page.keyboard.press(dir === 'rtl' ? 'Alt+ArrowRight' : 'Alt+ArrowLeft');
        assert.deepEqual(await order(), ['first', 'second', 'third']);
        async function checkPreview(zone, name) {
            await page.waitForTimeout(220);
            const preview = page.locator('.tab-drag-preview');
            assert.equal(await preview.locator('button').count(), 2, 'preview retains label and menu button');
            assert.equal(await preview.locator('svg').count(), 1, 'preview retains chevron artwork');
            assert.equal(await preview.evaluate((n, zone) => n.parentElement.classList.contains(zone), zone), true);
            assert.equal(await preview.locator('[id], [data-workspace]').count(), 0, 'preview does not duplicate tab identity');
            const gap = await page.locator('.tab-placeholder').boundingBox(), rect = await preview.boundingBox();
            assert.ok(Math.abs(gap.width - rect.width) < 1 && Math.abs(gap.height - rect.height) < 1, 'preview morphs to destination size');
            assert.equal(await page.locator('.tab-drop-before, .tab-drop-after').count(), 0, 'placement uses a full gap');
            await mkdir('test-results', { recursive: true });
            await page.screenshot({ path: `test-results/tab-morph-${name}.png` });
        }
        const drag = async (source, target, cancel = false) => {
            await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
            const a = await page.locator(`#${source} .workspace-tab`).boundingBox(), b = await page.locator(`#${target} .workspace-tab`).boundingBox();
            await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
            if (cancel) await page.keyboard.press('Escape');
            await page.mouse.up();
        };
        await drag('first', 'third', true); assert.deepEqual(await order(), ['first', 'second', 'third']);
        await drag('first', 'third'); assert.deepEqual(await order(), ['second', 'third', 'first'], `${dir}: unequal-width pointer reorder`);
        await drag('first', 'second'); assert.deepEqual(await order(), ['first', 'second', 'third'], `${dir}: reverse pointer reorder`);
        await page.locator('#host').evaluate(node => node.style.width = '280px');
        await page.waitForFunction(() => document.querySelector('.visible-tabs').children.length === 2);
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await drag('third', 'first', true);
        assert.deepEqual(await order(), ['first', 'second', 'third'], `${dir}: cancelled overflow-to-bar drag`);
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
        const source = await page.locator('#third .workspace-tab').boundingBox(), target = await page.locator('#first').boundingBox();
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
        await page.mouse.move(target.x + (dir === 'rtl' ? target.width - 2 : 2), target.y + target.height / 2, { steps: 12 });
        await checkPreview('visible-tabs', `${dir}-${theme}-to-bar`);
        await page.mouse.up();
        assert.deepEqual(await order(), ['third', 'first', 'second'], `${dir}: lone overflow entry moves into the bar`);
        assert.equal(await page.locator('.visible-tabs #third').count(), 1);
        await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
        const back = await page.locator('#third .workspace-tab').boundingBox(), more = await page.locator('.overflow-toggle').boundingBox();
        await page.mouse.move(back.x + back.width / 2, back.y + back.height / 2); await page.mouse.down();
        await page.mouse.move(more.x + more.width / 2, more.y + more.height / 2, { steps: 12 });
        await page.locator('.overflow-tabs:popover-open').waitFor();
        const last = await page.locator('#second').boundingBox();
        await page.mouse.move(last.x + last.width / 2, last.y + last.height - 2, { steps: 12 });
        await checkPreview('overflow-tabs', `${dir}-${theme}-to-overflow`);
        await page.mouse.up();
        assert.deepEqual(await order(), ['first', 'second', 'third'], `${dir}: bar-to-overflow drag opens the menu and inserts after its last entry`);
        assert.equal(await page.locator('.tab-drag-preview, .tab-placeholder, .tab-drop-before, .tab-drop-after').count(), 0);
        await page.locator('#host').evaluate(node => node.style.width = '50px');
        await page.waitForFunction(() => document.querySelector('.visible-tabs').children.length === 0);
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await drag('third', 'first'); assert.deepEqual(await order(), ['third', 'first', 'second'], `${dir}: vertical overflow stays top-to-bottom`);
        await page.close();
    }
    console.log('i18n: LTR/RTL pointer and keyboard tab reordering, cancellation and bidirectional overflow transfers passed.');
} finally { await browser.close(); }
