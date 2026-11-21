import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    const styles = await readFile('web/style.css', 'utf8');
    for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
        const page = await context.newPage();
        await page.route('http://tuxee.test/', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>${styles}</style><div id="app"><header class="topbar">Header</header><div class="workspace-viewport">
            <div id="inside" style="height:100%;overflow:auto"><div style="height:2000px"></div><button id="last">Last row</button></div>
            </div></div><button id="outside" style="position:absolute;top:100%;left:100%">Overflow</button>` }));
        await page.goto('http://tuxee.test/');
        // A rounding error or an overflowing child must never turn the document into a scroller.
        await page.evaluate(() => document.documentElement.style.setProperty('--viewport-height', `${innerHeight + 8}px`));
        const pinned = async () => assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, document.body.scrollTop, document.querySelector('#app').getBoundingClientRect().top]), [0, 0, 0, 0], `${width}px: application stays at the viewport origin`);
        await page.evaluate(() => { window.scrollTo(20, 20); document.querySelector('#outside').focus(); });
        await page.keyboard.press('PageDown'); await pinned();
        await page.mouse.move(width / 2, 20); await page.mouse.wheel(0, 300); await page.waitForTimeout(100); await pinned();
        const touch = await context.newCDPSession(page);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: width / 2, y: 30, id: 1 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: width / 2, y: 5, id: 1 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(100); await pinned();
        await page.mouse.move(width / 2, 200); await page.mouse.wheel(0, 300);
        await page.waitForFunction(() => document.querySelector('#inside').scrollTop > 0);
        await page.locator('#last').focus();
        assert.ok(await page.locator('#inside').evaluate(n => n.scrollTop > 1000), 'internal focus scrolling stays available');
        await pinned();
        await page.evaluate(() => {
            document.documentElement.style.overflow = 'visible';
            Object.assign(document.body.style, { position: 'static', overflow: 'hidden' });
            window.scrollTo(20, 20);
        });
        assert.ok(await page.evaluate(() => scrollX > 0 && scrollY > 0), 'simulate an old page offset on both axes');
        await page.reload(); await pinned();
        await context.close();
    }
    console.log('PASS desktop/mobile document lock on both axes under overflow, focus, wheel, keyboard, touch and restored offsets after refresh; internal scrolling remains available.');
} finally { await browser.close(); }
