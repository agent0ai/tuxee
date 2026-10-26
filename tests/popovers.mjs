import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `
    import { button, el, popover } from './web/ui';
    const root = button('Overflow'), unrelated = button('Unrelated');
    document.body.append(root, unrelated);
    function open(anchor, label, pointed = false) {
        const menu = el('div'); menu.id = label;
        const first = button(label + ' first'), next = button(label + ' next');
        menu.append(first, next);
        first.onclick = () => open(first, label + '-child', true);
        next.onclick = () => open(next, label + '-sibling');
        const rect = anchor.getBoundingClientRect();
        return popover(pointed ? {x: rect.right + 5, y: rect.top} : anchor, menu, anchor);
    }
    root.onclick = () => window.rootMenu = open(root, 'root');
    unrelated.onclick = () => open(unrelated, 'unrelated');
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>.popover-menu {position:fixed;inset:auto;margin:0;padding:8px} button {display:block} [aria-label=Unrelated] {position:absolute;left:600px;top:8px}</style>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const button = name => page.getByRole('button', { name, exact: true });
    const count = async expected => assert.equal(await page.locator(':popover-open').count(), expected);
    const focused = async name => assert.ok(await button(name).evaluate(node => node === document.activeElement), name + ' has focus');

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
    assert.deepEqual(errors, []);
    console.log('PASS nested popovers: parents, siblings, keyboard/focus, outside click, resize and disposal');
} finally { await browser.close(); }
