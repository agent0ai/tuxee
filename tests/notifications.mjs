import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const index = await readFile('web/index.html', 'utf8');
const catalog = JSON.parse(await readFile('internal/i18n/locales/en.json', 'utf8'));
const bundle = await build({ stdin: { contents: `
    import { notify, scopeNotifications } from './web/ui';
    import { operation } from './web/transfers';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: 'ltr', texts: ${JSON.stringify(catalog.texts)}, languages: [], cookie: '' });
    Object.assign(window, { notify, scopeNotifications });
    window.startTransfer = owner => operation('Upload', 10, (signal, progress) => new Promise((resolve, reject) => {
        progress(2);
        signal.addEventListener('abort', () => { window.cancelled = true; reject(signal.reason); });
    }), owner).catch(() => {});
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
await mkdir('test-results', { recursive: true });
try {
    for (const [name, viewport, compact] of [
        ['desktop', { width: 1440, height: 900 }, false],
        ['mobile', { width: 390, height: 844 }, true],
        ['short', { width: 640, height: 360 }, true],
    ]) {
        const page = await browser.newPage({ viewport }), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(index.match(/<body>.*<\/body>/s)[0]);
        await page.addStyleTag({ path: 'web/style.css' });
        await page.addStyleTag({ content: `
            #app { position: absolute; inset: 60px 0 0; height: auto; }
            #panel { position: absolute; inset: 0; width: min(600px, 100%); }
            #bottom-input { position: absolute; bottom: 8px; left: 8px; right: 8px; }
        ` });
        await page.locator('#app').evaluate((app, compact) => {
            app.className = compact ? 'compact-board' : '';
            app.innerHTML = '<section id="panel" class="grid-stack-item-content panel"><header class="panel-header"><button id="header-button">Panel</button></header><div class="panel-body"><input id="bottom-input" aria-label="Command"></div></section>';
        }, compact);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        assert.ok(await page.locator('#notifications').evaluate(node => node.getAttribute('aria-live') === 'polite' && getComputedStyle(node).display !== 'none'), 'empty live regions remain available');
        await page.evaluate(() => {
            const input = document.querySelector('#bottom-input');
            const menu = document.createElement('div'); document.body.append(menu);
            scopeNotifications(menu, document.querySelector('#panel'));
            notify('First notification with enough text to wrap on a narrow screen.', input);
            notify('Second notification', menu);
            void startTransfer(menu);
        });
        const stack = page.locator('.component-notification-stack');
        assert.equal(await stack.count(), 1);
        assert.equal(await stack.locator('.toast').count(), 2);
        assert.equal(await stack.locator('.transfer').count(), 1);
        assert.equal(await page.locator('#notifications .toast, #transfers .transfer').count(), 0);
        const panelBox = await page.locator('#panel').boundingBox(), stackBox = await stack.boundingBox();
        assert.ok(Math.abs(stackBox.y - panelBox.y - (compact ? 8 : 44)) <= 1, 'stack starts at the panel top, below any header');
        assert.ok(stackBox.y + stackBox.height < (await page.locator('#bottom-input').boundingBox()).y, 'bottom input stays clear');
        const cards = await stack.locator('.toast, .transfer').evaluateAll(nodes => nodes.map(node => {
            const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
        }));
        for (let i = 1; i < cards.length; i++) assert.ok(cards[i].top >= cards[i - 1].bottom + 5, 'mixed notices never overlap');
        await page.locator('#bottom-input').fill('input remains usable');
        if (!compact) await page.locator('#header-button').click();
        await stack.locator('.toast button').first().click();
        assert.equal(await stack.locator('.toast').count(), 1);
        await stack.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
        assert.equal(await page.evaluate(() => cancelled), true);
        await page.evaluate(() => {
            for (let i = 0; i < 15; i++) notify('Queued notification ' + i, document.querySelector('#bottom-input'));
        });
        assert.ok(await stack.evaluate(node => node.scrollHeight > node.clientHeight), 'long stacks are bounded');
        await stack.locator('.toast').first().hover(); await page.mouse.wheel(0, 1000);
        await page.waitForFunction(() => document.querySelector('.component-notification-stack').scrollTop > 0);
        await page.locator('#bottom-input').click();
        await page.screenshot({ path: `test-results/notifications-${name}.png` });

        await page.evaluate(() => {
            const detached = document.querySelector('#panel'); detached.remove();
            notify('Global first', detached); notify('Global second'); void startTransfer();
        });
        const global = page.locator('body > .notification-stack');
        const globalBox = await global.boundingBox();
        assert.equal(globalBox.y, 18);
        assert.ok(Math.abs(globalBox.x + globalBox.width - viewport.width + 18) <= 1, 'global stack is right aligned');
        const transferBox = await global.locator('.transfer').boundingBox(), first = await global.locator('.toast').first().boundingBox();
        assert.ok(first.y >= transferBox.y + transferBox.height + 8, 'global progress and notices share a stack');
        await global.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
        await global.locator('.toast button').first().click();
        assert.equal(await global.locator('.toast').count(), 1);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${name}: top placement, mixed stacks, scoped routing, bottom input, scrolling, dismiss and cancel`);
    }
} finally { await browser.close(); }
