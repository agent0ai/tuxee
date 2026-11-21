import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const index = await readFile('web/index.html', 'utf8');
const catalog = JSON.parse(await readFile('internal/i18n/locales/en.json', 'utf8'));
const bundle = await build({ stdin: { contents: `
    import { button, el, notify, scopeNotifications } from './web/ui';
    import { operation } from './web/transfers';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: 'ltr', texts: ${JSON.stringify(catalog.texts)}, languages: [], cookie: '' });
    Object.assign(window, { button, el, notify, scopeNotifications });
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
        await page.setContent('<!doctype html>' + index.match(/<body>.*<\/body>/s)[0]);
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

        for (const toolbar of ['file-actions', 'inspector-toolbar']) {
            await page.evaluate(({ compact, toolbar }) => {
                document.querySelector('#app').classList.toggle('compact', compact);
                const body = document.querySelector('.panel-body');
                body.classList.add('file-view'); body.replaceChildren();
                const nav = el('form', 'file-nav'), path = el('input', 'path-input');
                path.value = '/home/test'; nav.append(path);
                const head = document.querySelector('.panel-header'); head.replaceChildren();
                (compact ? body : head).append(nav);
                const actions = el('div', toolbar), back = button('Back', 'ArrowLeft', () => { window.backClicked = true; });
                back.id = 'file-back'; actions.append(back);
                const host = toolbar === 'inspector-toolbar' ? el('div', 'file-inspector') : body;
                host.append(actions); if (host !== body) body.append(host);
                window.backClicked = false;
                notify('File operation completed', body);
            }, { compact, toolbar });
            const bar = await page.locator('.' + toolbar).boundingBox(), notice = await stack.boundingBox();
            assert.ok(notice.y >= bar.y + bar.height, `${toolbar} stays above notifications`);
            assert.ok(notice.y <= bar.y + bar.height + 16, 'notifications stay just below the toolbar');
            await page.locator('#file-back').click({ timeout: 1000 });
            assert.equal(await page.evaluate(() => backClicked), true, 'Back works while notifications are visible');
            await page.screenshot({ path: `test-results/notifications-${name}-${toolbar}.png` });
        }

        await page.evaluate(compact => {
            const detached = document.querySelector('#panel'); detached.remove();
            const app = document.querySelector('#app');
            app.className = compact ? 'compact' : ''; app.style.top = '0';
            const top = el('header', 'topbar'), bar = el('div', compact ? 'component-controls' : 'component-controls window-bar');
            top.append(button('Navbar', undefined, () => { window.topClicked = true; }));
            bar.append(button('Window tab', undefined, () => { window.tabClicked = true; }, 'component-tab'));
            app.replaceChildren(top, bar, el('main', 'workspace-viewport'));
            notify('Global first', detached); notify('Global second'); void startTransfer();
        }, compact);
        const global = page.locator('body > .notification-stack');
        const globalBox = await global.boundingBox();
        const barBox = await page.locator('.component-controls').boundingBox();
        assert.ok(globalBox.y >= barBox.y + barBox.height + 8, 'global stack clears both top bars');
        await page.getByRole('button', { name: 'Navbar', exact: true }).click();
        await page.getByRole('button', { name: 'Window tab', exact: true }).click();
        assert.equal(await page.evaluate(() => topClicked && tabClicked), true);
        assert.ok(Math.abs(globalBox.x + globalBox.width - viewport.width + 18) <= 1, 'global stack is right aligned');
        const transferBox = await global.locator('.transfer').boundingBox(), first = await global.locator('.toast').first().boundingBox();
        assert.ok(first.y >= transferBox.y + transferBox.height + 8, 'global progress and notices share a stack');
        await global.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
        await global.locator('.toast button').first().click();
        assert.equal(await global.locator('.toast').count(), 1);
        await page.evaluate(() => { for (let i = 0; i < 15; i++) notify('Queued global notification ' + i); });
        assert.ok(await global.evaluate(node => node.scrollHeight > node.clientHeight), 'long global stacks remain scrollable');
        const bounded = await global.boundingBox();
        assert.ok(bounded.y + bounded.height <= viewport.height - 18, 'global stack keeps its bottom margin');
        await page.screenshot({ path: `test-results/notifications-${name}-global.png` });
        for (const position of compact ? ['bottom'] : ['bottom', 'left', 'right']) {
            await page.locator('#app').evaluate((node, position) => {
                node.dataset.panelPosition = position; const vertical = position === 'left' || position === 'right'; node.classList.toggle('side-panel', vertical);
                const bar = node.querySelector('.component-controls');
                if (vertical) node.querySelector('.topbar').append(bar); else node.insertBefore(bar, node.querySelector('.workspace-viewport'));
            }, position);
            for (const hidden of [false, true]) {
                await page.locator('.component-controls').evaluate((node, hidden) => node.hidden = hidden, hidden);
                const stack = await global.boundingBox();
                for (const selector of hidden ? ['.topbar'] : ['.topbar', '.component-controls']) {
                    const rail = await page.locator(selector).boundingBox();
                    assert.ok(stack.x + stack.width <= rail.x || stack.x >= rail.x + rail.width || stack.y + stack.height <= rail.y || stack.y >= rail.y + rail.height, `${position}: notifications never cover either rail`);
                }
                await page.getByRole('button', { name: 'Navbar', exact: true }).click();
            }
            await page.locator('.component-controls').evaluate(node => node.hidden = false);
        }
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${name}: top placement, file/inspector toolbar clearance, mixed stacks, scoped routing, bottom input, scrolling, dismiss and cancel`);
    }
} finally { await browser.close(); }
