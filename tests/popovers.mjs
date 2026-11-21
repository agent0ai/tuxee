import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
    import { button, el, popover } from './web/ui';
    const root = button('Overflow'), unrelated = button('Unrelated'), positioned = button('Positioned');
    document.body.append(root, unrelated, positioned);
    function open(anchor, label, pointed = false) {
        const menu = el('div'); menu.id = label;
        const first = button(label + ' first'), next = button(label + ' next');
        menu.append(first, next);
        first.onclick = () => open(first, label + '-child', true);
        next.onclick = () => open(next, label + '-sibling');
        const rect = anchor.getBoundingClientRect();
        return popover(pointed ? {x: rect.right + 5, y: rect.top, opener: window.pointedOpeners ? anchor : undefined} : anchor, menu, anchor);
    }
    root.onclick = () => window.rootMenu = open(root, 'root');
    unrelated.onclick = () => open(unrelated, 'unrelated');
    positioned.onclick = () => {
        const rect = positioned.getBoundingClientRect();
        popover({x: rect.right + 5, y: rect.top, opener: positioned}, button('Positioned action'), positioned);
    };
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, hasTouch: true }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>.popover-menu {position:fixed;inset:auto;margin:0;padding:8px} button {display:block} [aria-label=Unrelated] {position:absolute;left:600px;top:8px}</style>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const button = name => page.getByRole('button', { name, exact: true });
    const count = async expected => assert.equal(await page.locator(':popover-open').count(), expected);
    const focused = async name => assert.ok(await button(name).evaluate(node => node === document.activeElement), name + ' has focus');

    for (const name of ['Overflow', 'Positioned']) for (const gesture of ['click', 'tap', 'Enter', 'Space']) {
        const opener = button(name);
        const activate = async () => {
            if (gesture === 'click' || gesture === 'tap') await opener[gesture]();
            else { await opener.focus(); await page.keyboard.press(gesture); }
        };
        for (const expected of [1, 0, 1, 0]) {
            await activate(); await count(expected);
            assert.equal(await opener.getAttribute('aria-expanded'), String(!!expected), `${name}: ${gesture} toggles expanded state`);
        }
        await focused(name);
    }
    await button('Overflow').click(); await button('root first').click();
    await button('Overflow').click(); await count(0); await focused('Overflow');

    await button('Overflow').click();
    await button('root first').click();
    await count(2); assert.ok(await page.locator('#root').isVisible(), 'opening a child keeps its parent visible');
    await page.keyboard.press('ArrowDown'); await focused('root-child next');
    await page.keyboard.press('Home'); await focused('root-child first');
    await page.keyboard.press('Enter'); await count(3);
    await page.keyboard.press('Escape'); await count(2); await focused('root-child first');
    await page.keyboard.press('Escape'); await count(1); await focused('root first');
    await page.keyboard.press('Escape'); await count(0); await focused('Overflow');

    await button('Overflow').click(); await button('root first').click();
    await button('root next').click(); await count(2);
    assert.equal(await page.locator('#root-child').count(), 0, 'a sibling replaces only the child');
    await page.keyboard.press('Escape'); await count(1); await focused('root next');
    await button('root first').click();
    await button('Unrelated').click(); await count(1);
    assert.ok(await page.locator('#unrelated').isVisible(), 'an unrelated menu replaces the whole branch');
    await page.mouse.click(900, 650); await page.locator('#unrelated').waitFor({ state: 'detached' }); await count(0);

    await button('Overflow').click(); await button('root first').click();
    await page.mouse.click(900, 650); await page.locator('#root').waitFor({ state: 'detached' }); await count(0);
    await button('Overflow').click(); await button('root first').click();
    await page.setViewportSize({ width: 900, height: 700 }); await page.locator('#root').waitFor({ state: 'detached' }); await count(0);
    await button('Overflow').click(); await button('root first').click();
    await page.evaluate(() => { rootMenu.close(); rootMenu.close(); }); await count(0); await focused('Overflow');
    await button('Overflow').click(); await button('root first').click();
    await page.evaluate(() => { document.querySelector('#root').remove(); rootMenu.close(); });
    await button('Unrelated').click(); await count(1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.pointedOpeners = true);
    await page.addStyleTag({ content: '.popover-menu { box-sizing:border-box; width:190px; max-height:calc(100vh - 8px); overflow-y:auto } .popover-menu > button { width:100%; height:36px } #root > .popover-menu > button { height:120px } [aria-label=Overflow] { position:fixed; left:4px }' });
    for (const width of [320, 390]) for (const top of [8, 250]) {
        await page.setViewportSize({ width, height: 320 });
        await button('Overflow').evaluate((node, top) => node.style.top = `${top}px`, top);
        await button('Overflow').tap();
        for (const name of ['root first', 'root next']) {
            const opener = button(name);
            await opener.tap(); await count(2);
            const control = await opener.boundingBox(), child = await page.locator('#root > .popover-menu').boundingBox();
            assert.ok(child.x + child.width <= control.x || child.x >= control.x + control.width || child.y + child.height <= control.y || child.y >= control.y + control.height, 'narrow nested menus keep their opener uncovered');
            assert.ok(child.y >= 4 && child.y + child.height <= 316, 'nested menu stays inside the short viewport');
            await opener.tap(); await count(1);
        }
        await page.keyboard.press('Escape'); await count(0);
    }
    assert.deepEqual(errors, []);
    console.log('PASS nested popovers: parents, siblings, keyboard/focus, outside click, resize and disposal');
} finally { await browser.close(); }
