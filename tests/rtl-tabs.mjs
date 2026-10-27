import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
    import { overflowTabs } from './web/overflow';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: document.documentElement.dir, texts: {}, languages: [], cookie: '' });
    const host = document.querySelector('#host');
    const items = ['first', 'second', 'third'].map((id, i) => {
        const item = document.createElement('div'), handle = document.createElement('button');
        item.id = id; handle.textContent = id; handle.style.width = [70, 150, 90][i] + 'px';
        item.append(handle); return item;
    });
    window.order = items.map(item => item.id);
    overflowTabs(host, items, 'More', next => { window.order = next.map(item => item.id); });
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    for (const dir of ['ltr', 'rtl']) {
        const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
        await page.setContent(`<html dir="${dir}"><style>
            #host { width: 500px; display: flex; gap: 4px; }
            .visible-tabs { display: flex; gap: 4px; min-width: 0; }
            .visible-tabs > *, .overflow-toggle { flex-shrink: 0; }
            button { height: 35px; }
            [hidden] { display: none !important; }
            .popover-menu { position: fixed; inset: auto; margin: 0; }
            .overflow-tabs:popover-open { display: flex; flex-direction: column; gap: 4px; }
        </style><div id="host"></div></html>`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const order = () => page.evaluate(() => window.order);
        await page.locator('#first button').focus();
        await page.keyboard.press(dir === 'rtl' ? 'Alt+ArrowLeft' : 'Alt+ArrowRight');
        assert.deepEqual(await order(), ['second', 'first', 'third'], `${dir}: physical arrow follows visual order`);
        await page.keyboard.press(dir === 'rtl' ? 'Alt+ArrowRight' : 'Alt+ArrowLeft');
        assert.deepEqual(await order(), ['first', 'second', 'third']);
        const drag = async (source, target, cancel = false) => {
            await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
            const a = await page.locator(`#${source} button`).boundingBox(), b = await page.locator(`#${target} button`).boundingBox();
            await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
            if (cancel) await page.keyboard.press('Escape');
            await page.mouse.up();
        };
        await drag('first', 'third', true); assert.deepEqual(await order(), ['first', 'second', 'third']);
        await drag('first', 'third'); assert.deepEqual(await order(), ['second', 'third', 'first'], `${dir}: unequal-width pointer reorder`);
        await drag('first', 'second'); assert.deepEqual(await order(), ['first', 'second', 'third'], `${dir}: reverse pointer reorder`);
        await page.locator('#host').evaluate(node => node.style.width = '50px');
        await page.getByRole('button', { name: 'More', exact: true }).click();
        await drag('third', 'first'); assert.deepEqual(await order(), ['third', 'first', 'second'], `${dir}: vertical overflow stays top-to-bottom`);
        await page.close();
    }
    console.log('i18n: LTR/RTL pointer and keyboard tab reordering, cancellation and vertical overflow passed.');
} finally { await browser.close(); }
