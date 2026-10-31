import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires disposable Linux accounts');
const state = await mkdtemp('/tmp/tuxee-howto-'), accounts = [];
let server, stopped, browser, base;
async function start(bind = '127.0.0.1:0') {
    server = spawn(state + '/tuxee', ['serve', '--http', '--bind', bind, '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => server.once('exit', resolve));
    base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
}
try {
    await chmod(state, 0o755); await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
    for (const suffix of ['a', 'b']) {
        const home = await mkdtemp('/tmp/tuxee-howto-home-'), name = `tuxee-howto-${process.pid}-${suffix}`, password = randomBytes(24).toString('base64url');
        run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', name]);
        const fields = run('getent', ['passwd', name]).split(':'); const uid = Number(fields[2]), gid = Number(fields[3]);
        accounts.push({ home, name, password, uid, gid }); await chown(home, uid, gid); run('chpasswd', [], `${name}:${password}\n`);
    }
    await start();
    const env = { ...process.env }; for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete env[key];
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], env });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors = [], external = [], screenshotRequests = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base) && !/^(data|blob):/.test(request.url())) external.push(request.url()); });
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/assets/howto-')) screenshotRequests.push(request.url()); });
    const login = async (ctx, account = accounts[0], language = 'en') => {
        const response = await ctx.request.post(base + '/api/login', { data: { username: account.name, password: account.password, language }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(response.status(), 200); return (await response.json()).csrf;
    };
    const me = async ctx => (await (await ctx.request.get(base + '/api/me')).json());
    const seenSave = target => target.waitForResponse(response => response.url() === base + '/api/settings' && response.request().postDataJSON()?.howToSeen === true);
    const put = async (ctx, settings) => {
        const response = await ctx.request.put(base + '/api/settings', { data: settings, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': (await me(ctx)).csrf } });
        assert.equal(response.status(), 200, await response.text());
    };
    const open = async target => { await target.locator('.user-menu-button').click(); assert.equal(await target.locator('.account-menu [role=menuitem]').first().getAttribute('data-action'), 'BookOpen'); await target.locator('[data-action=BookOpen]').click(); await target.locator('.howto-modal').waitFor(); };
    const settled = async (target, index) => target.waitForFunction(index => {
        const dialog = document.querySelector('.howto-modal');
        return dialog?.dataset.page === String(index) && dialog.querySelectorAll('.howto-page').length === 1 && !dialog.getAnimations({ subtree: true }).length;
    }, index);
    const paginationPositions = new WeakMap();
    const bounds = async target => {
        const problems = await target.locator('.howto-modal').evaluate(dialog => {
            const bad = [], box = dialog.getBoundingClientRect(), close = dialog.querySelector('.modal-head > button').getBoundingClientRect();
            for (const [selector, disabled] of [['.howto-previous', dialog.dataset.page === '0'], ['.howto-next', dialog.dataset.page === '5']]) {
                const button = dialog.querySelector(selector);
                if (button.disabled !== disabled || (getComputedStyle(button).display === 'none') !== disabled) bad.push(`${selector} endpoint visibility`);
            }
            const header = dialog.querySelector('.modal-head').getBoundingClientRect(), dots = dialog.querySelector('.howto-dots').getBoundingClientRect();
            const width = innerWidth <= 600 ? dots.width : dialog.querySelector('.howto-nav').getBoundingClientRect().width;
            const center = (header.left + header.right) / 2;
            const expected = document.documentElement.dir === 'rtl' ? Math.max(center, header.left + 48 + width / 2) : Math.min(center, header.right - 48 - width / 2);
            if (Math.abs((dots.left + dots.right) / 2 - expected) > 1) bad.push('dots are not centered with Close clearance');
            if (Math.abs((dots.top + dots.bottom) / 2 - (close.top + close.bottom) / 2) > 1) bad.push('dots and Close are not vertically aligned');
            if (box.left < 0 || box.right > innerWidth + 1 || box.top < 0 || box.bottom > innerHeight + 1) bad.push('dialog bounds');
            for (const node of dialog.querySelectorAll('.howto-nav, .howto-page, .howto-chapters, .howto-copy, .howto-detail, .howto-shortcuts, .howto-terminal-pair, .howto-tip-processes, .howto-tip-updates')) if (node.scrollWidth > node.clientWidth + 1) bad.push(node.className);
            for (const row of dialog.querySelectorAll('.howto-terminal-pair')) {
                const copy = row.querySelector('.howto-detail').getBoundingClientRect(), image = row.querySelector('img').getBoundingClientRect();
                const retained = row.classList.contains('howto-terminal-retained');
                if (image.width > (retained ? 300 : 360) + 1) bad.push('terminal screenshot too wide');
                if (innerWidth <= 600) {
                    if (image.top < copy.bottom + 20) bad.push('terminal screenshot must stack after its copy');
                } else if (Math.abs(copy.top + copy.height / 2 - image.top - image.height / 2) > 1) bad.push('terminal copy and screenshot must sit alongside');
            }
            for (const node of [dialog, ...dialog.querySelectorAll('.modal-body, .howto-content, .howto-viewport')]) if (node.scrollHeight > node.clientHeight + 1) bad.push(`${node.className} has outer vertical overflow`);
            for (const nav of dialog.querySelectorAll('.howto-nav')) for (const button of nav.querySelectorAll('button:not(:disabled)')) {
                const rect = button.getBoundingClientRect(); if (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom) bad.push('navigation clipped');
                if (rect.left < close.right && rect.right > close.left && rect.top < close.bottom && rect.bottom > close.top) bad.push('navigation overlaps Close');
            }
            return bad;
        }); assert.deepEqual(problems, []);
        const placement = await target.locator('.howto-modal').evaluate(dialog => ({
            key: `${innerWidth}/${innerHeight}/${document.documentElement.lang}`,
            dots: [...dialog.querySelectorAll('.howto-dot')].map(node => { const { x, y } = node.getBoundingClientRect(); return { x, y }; }),
        }));
        const previous = paginationPositions.get(target);
        if (previous?.key === placement.key) placement.dots.forEach((dot, n) => {
            assert.ok(Math.abs(dot.x - previous.dots[n].x) < 1 && Math.abs(dot.y - previous.dots[n].y) < 1, 'dot hit targets stay fixed across page names');
        });
        else paginationPositions.set(target, placement);
    };
    const checkTips = async target => {
        const guide = target.locator('.howto-modal'), customization = guide.locator('.howto-tip-customization');
        assert.equal(await customization.count(), 1);
        assert.equal(await guide.locator('.howto-tip, .howto-scene').count(), 0, 'old Tips cards and illustrations are removed');
        const image = customization.locator('img');
        await image.scrollIntoViewIfNeeded(); await image.evaluate(node => node.decode());
        assert.deepEqual(await image.evaluate(node => [node.naturalWidth, node.naturalHeight]), [1086, 242]);
        assert.equal(await customization.locator('[data-shortcut="app.settings"] kbd').textContent(), 'Alt+Shift+S');
        const processes = guide.locator('.howto-tip-processes'), processImage = processes.locator('img');
        assert.equal(await processes.count(), 1);
        assert.ok(await processes.evaluate(node => node.previousElementSibling.classList.contains('howto-tip-customization')), 'Process Manager is the second Tips section');
        await processImage.scrollIntoViewIfNeeded(); await processImage.evaluate(node => node.decode());
        assert.deepEqual(await processImage.evaluate(node => [node.naturalWidth, node.naturalHeight]), [1834, 1624]);
        assert.equal(await processes.locator('[data-shortcut="app.monitor"] kbd').textContent(), 'Alt+Shift+M');
        const updates = guide.locator('.howto-tip-updates'), updateImage = updates.locator('img');
        assert.equal(await updates.count(), 1);
        assert.ok(await updates.evaluate(node => node.previousElementSibling.classList.contains('howto-tip-processes')), 'Updates is the third Tips section');
        await updateImage.scrollIntoViewIfNeeded(); await updateImage.evaluate(node => node.decode());
        assert.deepEqual(await updateImage.evaluate(node => [node.naturalWidth, node.naturalHeight]), [1186, 1226]);
        assert.equal(await updates.locator('[data-shortcut="app.about"] kbd').textContent(), 'Alt+Shift+H');
        for (const tip of [processes, updates]) assert.ok(await tip.evaluate(node => {
            const copy = node.querySelector('.howto-detail').getBoundingClientRect(), image = node.querySelector('img').getBoundingClientRect();
            if (innerWidth <= 600) return image.top >= copy.bottom + 19;
            const imageFirst = node.classList.contains('howto-tip-updates') !== (document.documentElement.dir === 'rtl');
            const ordered = imageFirst ? image.right < copy.left : copy.right < image.left;
            return ordered && Math.abs(copy.top + copy.height / 2 - image.top - image.height / 2) < 1;
        }), 'tip screenshots alternate sides on desktop, mirror for RTL and stack below copy on phones');
        const keyboard = guide.locator('.howto-tip-shortcuts');
        assert.equal(await keyboard.count(), 1);
        assert.ok(await keyboard.evaluate(node => node.previousElementSibling.classList.contains('howto-tip-updates') && !node.nextElementSibling), 'Keyboard shortcuts is the final tip');
        assert.equal(await keyboard.locator('img').count(), 0);
        assert.equal(await keyboard.locator('p .howto-inline-control svg').count(), 1);
        assert.equal(await keyboard.locator('.howto-inline-control').innerText(), await keyboard.locator('[data-shortcut="app.shortcuts"] th').textContent());
        assert.ok(!(await keyboard.textContent()).includes('\uFFFC'), 'the inline menu control replaces the localized placeholder');
        assert.equal(await keyboard.locator('[data-shortcut="app.shortcuts"] kbd').textContent(), 'Alt+Shift+K');
        await guide.locator('.howto-page').evaluate(node => node.scrollTop = 0);
    };
    await mkdir('test-results', { recursive: true });
    // Showing or reloading the guide does not mark it closed, including existing accounts.
    await page.goto(base); await page.locator('[name=username]').fill(accounts[0].name); await page.locator('[name=password]').fill(accounts[0].password); await page.locator('.login-form button[type=submit]').click();
    const dialog = page.locator('.howto-modal'); await dialog.waitFor(); await settled(page, 0);
    assert.deepEqual(screenshotRequests, [], 'guide screenshots are not fetched on login or Introduction');
    assert.equal((await me(context)).settings.howToSeen, undefined);
    await page.reload(); await dialog.waitFor(); await settled(page, 0);
    assert.equal((await me(context)).settings.howToSeen, undefined);
    assert.equal(await dialog.locator('.modal-head h2').count(), 0);
    assert.equal(await dialog.locator('.modal-head > .howto-nav').count(), 1);
    assert.equal(await dialog.locator('.howto-intro-points li').count(), 4);
    assert.equal(await dialog.locator('.howto-chapters button').count(), 5);
    const stored = accounts[0].home + '/.config/tuxee/settings.json';
    const titles = ['Introduction', 'Desktops', 'Terminals', 'Files', 'GUI Apps', 'Tips'];
    const terminalIDs = (await me(context)).settings.workspaces.flatMap(ws => ws.panels.flatMap(p => p.terminal ? [p.terminal] : []));
    for (let n = 0; n < titles.length; n++) {
        await settled(page, n); await bounds(page);
        assert.equal(await dialog.locator('.howto-nav').count(), 1);
        assert.equal(await dialog.locator('.howto-eyebrow').count(), 0);
        assert.equal(await dialog.locator('.howto-dot[aria-current]').count(), 1);
        for (const nav of await dialog.locator('.howto-nav').all()) {
            assert.equal(await nav.locator('.howto-dot[aria-current]').getAttribute('data-page'), String(n));
            if (n < titles.length - 1) assert.equal(await nav.locator('.howto-next').getAttribute('aria-label'), titles[n + 1]);
            if (n) assert.equal(await nav.locator('.howto-previous').getAttribute('aria-label'), titles[n - 1]);
            else assert.equal(await nav.locator('.howto-previous').isDisabled(), true);
        }
        const sizes = await dialog.locator('.howto-dot span').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, outline: getComputedStyle(node).outlineStyle })));
        assert.deepEqual(sizes.map(dot => dot.width), titles.map((_, i) => i === n ? 16 : 8));
        assert.ok(sizes.every(dot => dot.outline === 'none'), `dots use one filled circle: ${JSON.stringify(sizes)}`);
        if (n >= 1 && n <= 5) {
            const images = dialog.locator('.howto-screenshot'); assert.equal(await images.count(), [0, 3, 6, 4, 2, 3][n]);
            let bytes = 0;
            for (const image of await images.all()) {
                await image.scrollIntoViewIfNeeded();
                await image.evaluate(node => node.decode());
                const src = await image.getAttribute('src'); assert.match(src, /^\/assets\/howto-[a-z-]+-[A-Z0-9]+\.webp$/);
                assert.ok(src.startsWith(`/assets/howto-${['', 'desktop', 'terminal', 'files', 'gui', 'tips'][n]}`));
                assert.equal(await image.getAttribute('loading'), 'lazy');
                const response = await context.request.get(base + src);
                assert.equal(response.status(), 200); assert.match(response.headers()['content-type'], /image\/webp/);
                assert.match(response.headers()['cache-control'], /immutable/); bytes += (await response.body()).length;
                assert.ok(await image.getAttribute('alt'));
            }
            assert.ok(bytes < (n === 2 ? 320 : 200) * 1024, 'screenshot sets stay within their size budgets');
            await dialog.locator('.howto-page').evaluate(node => node.scrollTop = 0);
        }
        if (n === 1) {
            assert.ok(screenshotRequests.every(url => !url.includes('/howto-terminal-')), 'terminal screenshots wait until their page opens');
            assert.equal(await dialog.locator('[data-shortcut="desktop.previous"] kbd').textContent(), 'Alt+Shift+←');
            assert.equal(await dialog.locator('[data-shortcut="panel.next"] kbd').textContent(), 'Alt+Shift+↓');
            assert.match(await dialog.locator('.howto-desktop-arrangement').innerText(), /4 × 2.*2 × 4.*8/);
            assert.equal(await dialog.locator('.howto-desktop-auto .howto-inline-control svg').count(), 1);
            assert.equal(await dialog.locator('.howto-desktop-auto .howto-inline-control').innerText(), 'Auto layout');
            assert.ok(!(await dialog.innerText()).includes('\uFFFC'), 'the localized control placeholder is replaced with its icon and label');
            await dialog.locator('.howto-page').evaluate(node => node.scrollTop = 0);
        }
        if (n === 2) {
            assert.match(await dialog.locator('.howto-copy').innerText(), /AI agent/);
            for (const name of ['archive', 'retained', 'drawer', 'text', 'files', 'settings']) assert.equal(await dialog.locator(`.howto-terminal-${name}`).count(), 1);
            assert.match(await dialog.locator('.howto-terminal-archive').innerText(), /accidentally closed.*server restarts.*transcript.*Post mortem.*analyze.*copy/s);
            assert.match(await dialog.locator('.howto-terminal-retained').innerText(), /Retained terminals.*user menu.*lost or closed/s);
            assert.ok(!(await dialog.innerText()).includes('The snapshot is read-only.'));
            assert.ok(!(await dialog.innerText()).includes('Submit the input when you are ready.'));
            assert.deepEqual(await dialog.locator('.howto-screenshot').evaluateAll(images => images.map(image => [image.naturalWidth, image.naturalHeight])), [[1364, 822], [1368, 836], [674, 626], [682, 822], [680, 820], [1360, 824]]);
            assert.match(await dialog.locator('.howto-terminal-files').innerText(), /~\/uploads/);
            assert.equal(await dialog.locator('[data-shortcut="app.retained"] kbd').innerText(), 'Alt+Shift+R');
            assert.equal(await dialog.locator('[data-shortcut="app.settings"] kbd').innerText(), 'Alt+Shift+S');
            assert.ok(await dialog.locator('.howto-page').evaluate(node => node.scrollHeight > node.clientHeight * 3));
            for (const name of ['archive', 'retained', 'drawer', 'text', 'files', 'settings']) {
                await dialog.locator(`.howto-terminal-${name}`).scrollIntoViewIfNeeded(); await bounds(page);
                await page.screenshot({ path: `test-results/howto-terminals-${name}.png` });
            }
            await dialog.locator('.howto-page').evaluate(node => node.scrollTop = 0);
        }
        if (n < 3) assert.ok(screenshotRequests.every(url => !url.includes('/howto-files-')), 'file screenshots wait until their page opens');
        if (n < 3) assert.ok(screenshotRequests.every(url => !url.includes('/howto-gui-')), 'GUI screenshots wait until their page opens');
        if (n === 3) {
            assert.match(await dialog.locator('.howto-copy').innerText(), /server and agent/);
            assert.deepEqual(await dialog.locator('.howto-files-transfers kbd').allTextContents(), ['← ↑ → ↓', 'F2', 'Enter']);
            assert.deepEqual(await dialog.locator('.howto-files-pair').first().locator('kbd').allTextContents(), ['Ctrl+click', 'Shift+click', 'Ctrl+A']);
            assert.match(await dialog.locator('.howto-files-transfers p').innerText(), /Cut, copy and paste.*local device.*download/s);
            assert.deepEqual(await dialog.locator('.howto-files-editor kbd').allTextContents(), ['Ctrl+F', 'Ctrl+S']);
            assert.match(await dialog.locator('.howto-files-terminal').innerText(), /another unpinned browser/);
            assert.deepEqual(await dialog.locator('.howto-files-terminal img').evaluate(image => [image.naturalWidth, image.naturalHeight]), [1356, 820]);
            for (const name of ['transfers', 'pair', 'editor', 'terminal']) {
                await dialog.locator(`.howto-files-${name}`).first().scrollIntoViewIfNeeded(); await bounds(page);
                await page.screenshot({ path: `test-results/howto-files-${name}.png` });
            }
            const platform = await page.evaluate(() => navigator.platform);
            await page.evaluate(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
            await dialog.locator('.howto-dot[data-page="4"]').click(); await settled(page, 4);
            await dialog.locator('.howto-dot[data-page="3"]').click(); await settled(page, 3);
            assert.deepEqual(await dialog.locator('.howto-files-transfers kbd').allTextContents(), ['← ↑ → ↓', 'F2', 'Enter']);
            assert.deepEqual(await dialog.locator('.howto-files-pair').first().locator('kbd').allTextContents(), ['Cmd+click', 'Shift+click', 'Cmd+A']);
            assert.deepEqual(await dialog.locator('.howto-files-editor kbd').allTextContents(), ['Cmd+F', 'Cmd+S']);
            assert.match(await dialog.locator('.howto-files-transfers p').innerText(), /Hold Ctrl.*copy instead of move/);
            assert.match(await dialog.locator('.howto-files-terminal').innerText(), /Hold Cmd/);
            await page.evaluate(value => Object.defineProperty(navigator, 'platform', { configurable: true, value }), platform);
            await dialog.locator('.howto-dot[data-page="4"]').click(); await settled(page, 4);
            await dialog.locator('.howto-dot[data-page="3"]').click(); await settled(page, 3);
            await dialog.locator('.howto-page').evaluate(node => node.scrollTop = 0);
        }
        if (n === 4) {
            assert.match(await dialog.locator('.howto-copy').innerText(), /Chromium.*GIMP.*audio.*headless/s);
            assert.deepEqual(await dialog.locator('pre code').allTextContents(), ['apt install chromium', 'chromium', 'chromium --no-sandbox', 'gimp &\nchromium --no-sandbox &']);
            assert.ok(await dialog.locator('pre').evaluateAll(nodes => nodes.every(node => node.dir === 'ltr')));
            assert.equal(await dialog.locator('[data-shortcut="audio.mute"] kbd').innerText(), 'Alt+Shift+V');
            assert.ok(await dialog.locator('.howto-page').evaluate(node => node.scrollHeight > node.clientHeight * 2));
            for (const name of ['launch', 'tabs', 'local', 'persistent', 'audio']) {
                await dialog.locator(`.howto-gui-${name}`).scrollIntoViewIfNeeded(); await bounds(page);
                await page.screenshot({ path: `test-results/howto-gui-${name}.png` });
            }
            await dialog.locator('.howto-page').evaluate(node => node.scrollTop = 0);
        }
        if (n < 5) assert.ok(screenshotRequests.every(url => !url.includes('/howto-tips-')), 'Tips screenshot waits until its page opens');
        if (n === 5) {
            await checkTips(page);
            assert.equal(await dialog.locator('.howto-tip-customization h4').textContent(), 'Customization');
            assert.match(await dialog.locator('.howto-tip-customization p').textContent(), /name and color marker.*Settings.*servers/);
            assert.equal(await dialog.locator('.howto-tip-processes h4').textContent(), 'Process Manager');
            assert.match(await dialog.locator('.howto-tip-processes p').textContent(), /Resource monitor.*resources widget.*top bar.*user menu.*Processes.*terminate individual processes.*overloaded.*unresponsive/);
            assert.equal(await dialog.locator('.howto-tip-updates h4').textContent(), 'Updates');
            assert.match(await dialog.locator('.howto-tip-updates p').textContent(), /Check for updates.*About.*user menu.*Tuxee logo.*top bar/);
            assert.equal(await dialog.locator('.howto-tip-shortcuts h4').textContent(), 'Keyboard shortcuts');
            assert.equal(await dialog.locator('.howto-tip-shortcuts p').textContent(), 'You can customize keyboard shortcuts with the Shortcuts button in the user menu.');
        }
        await page.screenshot({ path: `test-results/howto-desktop-${n}.png` });
        if (n < titles.length - 1) {
            const forward = await dialog.locator('.howto-next').boundingBox();
            await dialog.locator('.howto-next').click();
            assert.equal(await dialog.locator('.howto-track').evaluate(node => node.getAnimations()[0]?.effect.getTiming().duration), 220);
            if (n === titles.length - 2) {
                await page.mouse.click(forward.x + forward.width / 2, forward.y + forward.height / 2, { clickCount: 3, delay: 20 });
                await page.keyboard.press('ArrowRight');
                await settled(page, titles.length - 1);
                assert.equal(await dialog.isVisible(), true, 'repeated forward clicks never dismiss the guide');
                assert.equal((await me(context)).settings.howToSeen, undefined, 'reaching the last page does not mark the guide seen');
            }
        } else {
            const saved = seenSave(page);
            await dialog.locator('.modal-head > button').click();
            assert.equal((await saved).status(), 200);
        }
    }
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await me(context)).settings.howToSeen, true);
    assert.equal(JSON.parse(await readFile(stored, 'utf8')).howToSeen, true);
    const metadata = await stat(stored); assert.equal(metadata.uid, accounts[0].uid); assert.equal(metadata.mode & 0o777, 0o600);
    for (const id of terminalIDs) assert.equal((await context.request.get(base + '/api/terminals/' + id)).status(), 200);
    await page.reload(); await page.locator('.topbar').waitFor(); assert.equal(await dialog.count(), 0);
    await open(page); await dialog.locator('.howto-chapters button').last().click(); await settled(page, 5);
    await page.keyboard.press('Home'); await settled(page, 0);
    await dialog.locator('.howto-chapters button').first().click(); await settled(page, 1);
    await page.keyboard.press('ArrowRight'); await settled(page, 2);
    await dialog.locator('.howto-nav').first().locator('[data-page="1"]').click(); await settled(page, 1);
    await dialog.locator('.howto-previous').first().click(); await settled(page, 0);
    await page.keyboard.press('ArrowRight'); await settled(page, 1);
    await page.keyboard.press('End'); await settled(page, 5); await page.keyboard.press('Home'); await settled(page, 0);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); await settled(page, 1);
    await dialog.locator('.howto-nav').last().locator('[data-page="4"]').click(); await settled(page, 4);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }); assert.equal(await dialog.count(), 0);
    await page.locator('.user-menu-button').click(); await page.locator('[data-action=LogOut]').click(); await page.locator('.login-form').waitFor();
    await login(context); await page.goto(base); await page.locator('.topbar').waitFor(); assert.equal(await dialog.count(), 0);
    const freshBrowser = await browser.newContext(); await login(freshBrowser); const freshPage = await freshBrowser.newPage(); await freshPage.goto(base); await freshPage.locator('.topbar').waitFor(); assert.equal(await freshPage.locator('.howto-modal').count(), 0); await freshBrowser.close();
    const originalSettings = (await me(context)).settings;
    await put(context, { ...originalSettings, shortcuts: {
        'desktop.previous': [['Control+KeyY', 'KeyZ'], ['Alt+KeyY']], 'desktop.next': [[], []], 'panel.terminal': [[], ['Control+KeyB']],
    } });
    await page.reload(); await open(page);
    await dialog.locator('.howto-dot[data-page="1"]').click(); await settled(page, 1);
    assert.deepEqual(await dialog.locator('[data-shortcut="desktop.previous"] kbd').allTextContents(), ['Ctrl+Y → Z', 'Alt+Y']);
    assert.equal(await dialog.locator('[data-shortcut="desktop.next"]').count(), 0, 'disabled shortcuts are not advertised');
    assert.equal(await dialog.locator('[data-shortcut="desktop.add"] kbd').textContent(), 'Alt+Shift+D');
    assert.equal(await dialog.locator('[data-shortcut="panel.terminal"] kbd').textContent(), 'Ctrl+B');
    await dialog.locator('.howto-dot[data-page="2"]').click(); await settled(page, 2);
    assert.equal(await dialog.locator('[data-shortcut="panel.terminal"] kbd').textContent(), 'Ctrl+B');
    await page.keyboard.press('Escape'); await put(context, originalSettings);
    // A failed save must not claim persistence or block reading; another account starts unseen.
    const second = await browser.newContext(), secondPage = await second.newPage();
    await login(second, accounts[1]); assert.equal((await me(second)).settings.howToSeen, undefined);
    await put(second, { howToSeen: false, theme: 'dark', current: 'files', workspaces: [{ id: 'files', name: 'Files', columns: 4, rows: 2, active: 'file', panels: [{ id: 'file', kind: 'files', path: accounts[1].home, x: 0, y: 0, w: 4, h: 2 }] }] });
    await secondPage.route('**/api/settings', route => route.fulfill({ status: 400, json: { error: 'fixture save failure' } }));
    await secondPage.goto(base); await secondPage.locator('.howto-modal').waitFor();
    assert.equal((await me(second)).settings.howToSeen, undefined);
    await secondPage.keyboard.press('Escape');
    await secondPage.waitForFunction(() => document.body.textContent.includes('fixture save failure'));
    assert.equal((await me(second)).settings.howToSeen, undefined);
    await secondPage.unroute('**/api/settings');
    await secondPage.reload(); await secondPage.locator('.howto-modal').waitFor();
    const secondSave = seenSave(secondPage);
    await secondPage.locator('.howto-modal .modal-head > button').click();
    assert.equal((await secondSave).status(), 200); assert.equal((await me(second)).settings.howToSeen, true); await second.close();
    // Restart the actual server and sign in again with a fresh session.
    const bind = new URL(base).host; server.kill('SIGTERM'); await stopped; await start(bind);
    await login(context); await page.goto(base); await page.locator('.topbar').waitFor(); assert.equal(await dialog.count(), 0);
    // Every built-in catalog and theme fits at 320px; real login selects each immutable catalog.
    const codes = (await readdir('internal/i18n/locales')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    for (const code of codes) {
        const ctx = await browser.newContext({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' }); await login(ctx, accounts[0], code);
        const translated = await ctx.newPage(); translated.on('pageerror', error => errors.push(error.message));
        for (const theme of ['dark', 'light']) {
            await translated.goto('about:blank'); await put(ctx, { ...(await me(ctx)).settings, theme });
            await translated.goto(base); await open(translated);
            for (let n = 0; n < 6; n++) {
                await translated.locator('.howto-nav').first().locator(`[data-page="${n}"]`).click(); await settled(translated, n); try { await bounds(translated); } catch (error) { await translated.screenshot({ path: 'test-results/howto-overflow.png' }); throw new Error(`${code} ${theme} page ${n}: ${error.message}`); }
                assert.ok(!(await translated.locator('.howto-modal').innerText()).includes('[!'));
                if (n === 5) await checkTips(translated);
                if (['en', 'cs', 'ar', 'ja'].includes(code) && [0, 1, 4, 5].includes(n)) await translated.screenshot({ path: `test-results/howto-${code}-${theme}-${n}-320.png` });
            }
            const rtl = ['ar', 'fa', 'he'].includes(code);
            await translated.locator('.howto-dot[aria-current]').focus();
            await translated.keyboard.press('Home'); await settled(translated, 0);
            await translated.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight'); await settled(translated, 1);
            assert.equal(await translated.locator('.howto-track').evaluate(node => node.getAnimations().length), 0);
            await translated.keyboard.press('Escape');
        }
        for (const width of [600, 601]) {
            await translated.setViewportSize({ width, height: 740 }); await open(translated);
            for (let n = 0; n < 6; n++) {
                await translated.locator(`.howto-dot[data-page="${n}"]`).click(); await settled(translated, n);
                try { await bounds(translated); } catch (error) { throw new Error(`${code} ${width}px page ${n}: ${error.message}`); }
            }
            await translated.keyboard.press('Escape');
        }
        await ctx.close();
    }
    await page.goto('about:blank'); await login(context); await put(context, { ...(await me(context)).settings, theme: 'light' });
    for (const [width, height] of [[390, 844], [320, 740], [844, 390], [1440, 900]]) {
        await page.setViewportSize({ width, height }); await page.goto(base); await open(page);
        for (let n = 0; n < 6; n++) {
            await dialog.locator(`.howto-dot[data-page="${n}"]`).click(); await settled(page, n); await bounds(page);
            if (n === 0 && width === 1440) assert.equal(await dialog.locator('.howto-page').evaluate(node => node.scrollHeight > node.clientHeight + 1), false, 'short pages fit without scrolling');
            if (n === 5) await checkTips(page);
            await page.screenshot({ path: `test-results/howto-light-${width}-${n}.png` });
            if (n === 5) {
                for (const name of ['processes', 'updates', 'shortcuts']) {
                    await dialog.locator(`.howto-tip-${name}`).scrollIntoViewIfNeeded(); await bounds(page);
                    await page.screenshot({ path: `test-results/howto-tips-${name}-${width}.png` });
                }
            }
        }
        await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []); assert.deepEqual(external.filter(url => url !== 'about:blank'), []);
    console.log('How to: first login, private disk flag, reload/logout/new browser/restart persistence, account isolation, failed-save retry, six pages, top-only pagination with stable centered dots and Close clearance, 8/16px solid dots, no outer scrolling, Customization, Process Manager, Updates and Keyboard shortcuts tips with supplied screenshots and current shortcuts, inline Shortcuts menu control, responsive alternating layout, keyboard/rapid slides, retained terminals, all 43 languages and both themes at 320px, all languages at 600/601px, desktop/mobile/short views passed.');
} finally {
    await browser?.close(); if (server?.exitCode === null) { server.kill('SIGTERM'); await stopped; }
    for (const account of accounts) { run('userdel', [account.name]); await rm(account.home, { recursive: true, force: true }); }
    await rm(state, { recursive: true, force: true });
}
