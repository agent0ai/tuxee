import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const container = process.env.TUXEE_TEST_CONTAINER, base = process.env.TUXEE_TEST_URL;
assert.ok(container && base, 'Use a disposable Docker preview and its forwarded URL');
const output = 'test-results/start-inbox';
await mkdir(output, { recursive: true });
const nonce = randomBytes(4).toString('hex');
const accounts = ['a', 'b'].map(letter => ({ name: 'tuxee-inbox-' + letter + nonce, password: randomBytes(18).toString('hex') }));
const created = [];
function exec(args, input) {
    return spawnSync('docker', ['exec', '-i', container, ...args], { input, encoding: 'utf8' });
}
function docker(args, input) {
    const result = exec(args, input);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
    for (const account of accounts) {
        docker(['useradd', '-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', account.name]);
        created.push(account.name);
        docker(['chpasswd'], `${account.name}:${account.password}\n`);
        account.context = await browser.newContext({ viewport: { width: 1440, height: 950 }, hasTouch: true });
        const login = await account.context.request.post(base + '/api/login', {
            headers: { 'X-Tuxee-Client': 'web' }, data: { username: account.name, password: account.password },
        });
        assert.equal(login.status(), 200);
        account.csrf = (await (await account.context.request.get(base + '/api/me')).json()).csrf;
    }
    const [a, b] = accounts;
    const api = (account, path, method = 'GET', data, csrf = account.csrf) => account.context.request.fetch(base + '/api' + path, {
        method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
    });
    const feed = async account => {
        const response = await api(account, '/notifications');
        assert.equal(response.status(), 200);
        return response.json();
    };
    const preferences = {
        howToSeen: true, theme: 'dark', panelPosition: 'top', current: 'work',
        workspaces: [{
            id: 'work', name: 'Work', columns: 4, rows: 2, active: 'main-files',
            panels: [{ id: 'main-files', kind: 'files', path: '/tmp', x: 0, y: 0, w: 1, h: 1 }],
        }],
        commandShortcuts: [
            { name: 'System config', path: '/etc' },
            { name: 'Hosts file', path: '/etc/hosts' },
            { name: 'System overview', command: "printf 'POC_FAVORITE_OK\\n'" },
            ...['Disk usage', 'Recent logs', 'Running processes', 'Network interfaces', 'Memory usage', 'Check uptime', 'Home directory', 'Current user']
                .map((name, index) => ({ name, command: ['df -h', 'ls -lt /var/log', 'ps -ef', 'cat /proc/net/dev', 'free -h', 'uptime', 'ls -a ~', 'id'][index] })),
        ],
    };
    const save = async (opts = {}) => assert.equal((await api(a, '/settings', 'PUT', { ...preferences, ...opts })).status(), 200);
    await save();
    assert.equal((await browser.newContext().then(async unknown => {
        assert.equal((await unknown.request.get(base + '/api/events')).status(), 401);
        const response = await unknown.request.get(base + '/api/notifications'); await unknown.close(); return response;
    })).status(), 401);
    const denied = exec(['runuser', '-u', a.name, '--', 'tuxee', 'notify', '--users', b.name, '--text', 'forbidden']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /permission to signal the Tuxee runtime: operation not permitted/);
    assert.notEqual(exec(['tuxee', 'notify', '--users', a.name, '--users-all', '--text', 'ambiguous']).status, 0);
    assert.notEqual(exec(['tuxee', 'notify', '--users', a.name, '--type', 'unknown', '--text', 'invalid']).status, 0);
    docker(['tuxee', 'notify', '--users', a.name, '--type', 'default', '--text', 'General notice']);
    const explicit = (await feed(a)).items[0];
    assert.equal(explicit.type, 'default');
    assert.equal((await api(a, '/notifications/' + explicit.id, 'DELETE')).status(), 200);
    docker(['tuxee', 'notify', '--users-all', '--type', 'success', '--text', 'Scheduled backup completed.']);
    assert.equal((await feed(a)).count, 1);
    assert.equal((await feed(b)).count, 0, 'broadcast skips users without Tuxee configuration');
    docker(['usermod', '-s', '/usr/sbin/nologin', b.name]);
    docker(['tuxee', 'notify', '--users', a.name + ',' + b.name, '--type', 'warning', '--text',
        '**Maintenance** at *23:00*\n\n- Save drafts\n- [Details](https://example.org/maintenance)\n\n`maintenance.log`']);
    docker(['tuxee', 'notify', '--users', b.name, '--text', 'Private notice']);
    const aFeed = await feed(a), bFeed = await feed(b);
    assert.equal(aFeed.count, 2); assert.equal(bFeed.count, 2);
    assert.equal(aFeed.items[0].type, 'warning');
    assert.equal(aFeed.items[1].type, 'success');
    assert.equal(bFeed.items[0].type, 'default');
    assert.ok(bFeed.items.every(item => item.id !== aFeed.items[0].id));
    // CAP_KILL authorizes the runtime operation. SETUID/SETGID allow the recipient worker to start.
    const senderCaps = '+kill,+setuid,+setgid';
    docker(['setpriv', '--reuid=' + docker(['id', '-u', a.name]), '--regid=' + docker(['id', '-g', a.name]),
        '--clear-groups', '--inh-caps=' + senderCaps, '--ambient-caps=' + senderCaps,
        'tuxee', 'notify', '--users', b.name, '--text', 'Authorized non-root publisher']);
    const delivered = (await feed(b)).items.find(item => item.text === 'Authorized non-root publisher');
    assert.ok(delivered);
    assert.equal((await api(b, '/notifications/' + delivered.id, 'DELETE')).status(), 200);
    const aPath = `/home/${a.name}/.local/state/tuxee/notifications/`;
    assert.equal(docker(['stat', '-c', '%U %a', aPath + aFeed.items[0].id + '.json']), a.name + ' 600');
    assert.equal((await api(b, '/notifications/' + aFeed.items[0].id, 'DELETE')).status(), 200);
    assert.equal((await feed(a)).count, 2, 'cross-account dismissal leaves the original intact');
    assert.equal((await api(a, '/notifications/' + aFeed.items[0].id, 'DELETE', undefined, 'bad-token')).status(), 403);
    assert.equal((await api(a, '/notifications/%2e%2e%2fsettings.json', 'DELETE')).status(), 422);
    console.log('PASS scoped delivery, private files, broadcast eligibility, authentication and CSRF');
    docker(['usermod', '-s', '/bin/bash', b.name]);
    const fresh = await b.context.newPage(), freshErrors = [];
    fresh.on('pageerror', error => freshErrors.push(error.message));
    let resumeSave;
    const savePaused = new Promise(resolve => { resumeSave = resolve; });
    const firstSave = fresh.waitForRequest(request => request.url() === base + '/api/settings' && request.method() === 'PUT');
    await fresh.route('**/api/settings', async route => {
        await savePaused;
        await route.continue();
    });
    try {
        await fresh.goto(base);
        await firstSave;
        await fresh.setViewportSize({ width: 320, height: 680 });
        await fresh.locator('#app.compact .notifications-button').waitFor();
        assert.deepEqual(freshErrors, []);
    } finally {
        resumeSave();
        await fresh.close();
    }
    console.log('PASS inbox survives resize during first desktop save');

    const release = { id: '7'.repeat(32), type: 'info', release: 'v99.2.0', created: new Date().toISOString() };
    docker(['runuser', '-u', a.name, '--', 'bash', '-c', 'umask 077; cat > "$1"', 'fixture', aPath + release.id + '.json'], JSON.stringify(release));
    const page = await a.context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const start = page.locator('.brand-button'), launcher = page.locator('.start-menu');
    const bell = page.locator('.notifications-button'), inbox = page.locator('.inbox');
    const about = page.getByRole('dialog', { name: 'About Tuxee' });
    const live = () => page.locator('.terminal-view[data-state=connected]').count();
    const visible = selector => selector.waitFor();
    async function settle(popover) {
        await popover.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    }
    async function screenshot(name) { await page.screenshot({ path: output + '/' + name + '.png' }); }
    await page.goto(base);
    await visible(start);
    await start.focus(); await page.keyboard.press('Enter');
    assert.equal(await start.getAttribute('aria-expanded'), 'true');
    assert.ok(await launcher.evaluate(node => node.getAnimations().length > 0), 'fast opening animation');
    await settle(launcher);
    assert.equal(await launcher.locator('.start-user').textContent(), a.name);
    assert.deepEqual(await launcher.locator('.start-session button').allTextContents(), ['Restart Tuxee', 'Log out']);
    assert.ok(await launcher.locator('.start-favorite-rows').evaluate(rows => rows.scrollHeight <= rows.clientHeight + 1), 'desktop fits the sample favorites without scrolling');
    await screenshot('desktop-start');
    await page.keyboard.press('Escape');
    assert.ok(await start.evaluate(node => node === document.activeElement));
    await start.click(); await start.click(); assert.equal(await launcher.count(), 0);
    await start.click(); await page.locator('.topbar').click({ position: { x: 590, y: 14 } }); assert.equal(await launcher.count(), 0);
    for (const [action, title] of [['Settings', 'Settings'], ['Keyboard', 'Keyboard shortcuts'], ['BookOpen', 'How to'], ['Info', 'About Tuxee'], ['Activity', 'Resource monitor'], ['SquareTerminal', 'Retained terminals']]) {
        await start.click();
        await launcher.locator(`.start-apps [data-action=${action}]`).click();
        const dialog = page.locator('dialog[open]');
        await dialog.waitFor();
        assert.equal(await launcher.count(), 0, title + ' closes Start');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
    }
    await start.click();
    await launcher.locator('[data-action=RefreshCw]').click();
    const restart = page.getByRole('dialog', { name: 'Restart Tuxee?' });
    await restart.waitFor();
    assert.equal(await launcher.count(), 0);
    await restart.getByRole('button', { name: 'Cancel' }).click();
    await restart.waitFor({ state: 'detached' });
    await bell.click();
    await page.getByText('Tuxee v99.2.0 is available', { exact: true }).waitFor();
    await settle(inbox);
    assert.equal(await inbox.locator('strong').first().textContent(), 'Maintenance');
    assert.equal(await inbox.locator('a').getAttribute('href'), 'https://example.org/maintenance');
    assert.deepEqual(await inbox.locator('li').allTextContents(), ['Save drafts', 'Details']);
    assert.equal(await inbox.locator('code').textContent(), 'maintenance.log');
    assert.equal(await bell.locator('.inbox-badge').textContent(), '3');
    assert.equal(await inbox.locator('[data-type=success] .inbox-type').getAttribute('aria-label'), 'Success');
    await screenshot('desktop-inbox');
    await inbox.locator('.inbox-about').click();
    await about.waitFor(); assert.equal(await inbox.count(), 0);
    await page.keyboard.press('Escape');
    await bell.click(); await bell.click(); assert.equal(await inbox.count(), 0);

    await a.context.route('https://example.org/maintenance', route => route.fulfill({ body: 'Maintenance details' }));
    await bell.click();
    const link = inbox.locator('a');
    const external = a.context.waitForEvent('page');
    await link.click();
    const linked = await external;
    await linked.waitForURL('https://example.org/maintenance');
    await linked.close();
    assert.equal(await inbox.count(), 0);
    await bell.click();
    await inbox.locator(`[data-notice="${aFeed.items[0].id}"] .inbox-dismiss`).click();
    await inbox.locator(`[data-notice="${aFeed.items[0].id}"]`).waitFor({ state: 'detached' });
    assert.notEqual(exec(['test', '-e', aPath + aFeed.items[0].id + '.json']).status, 0);
    assert.equal((await feed(a)).count, 2);
    await bell.click();

    const second = await a.context.newPage(), other = await b.context.newPage();
    const eventCount = new Map();
    for (const tab of [second, other]) {
        eventCount.set(tab, 0);
        tab.on('websocket', socket => {
            if (new URL(socket.url()).pathname === '/api/events') {
                socket.on('framereceived', frame => {
                    assert.equal(JSON.parse(frame.payload).type, 'notifications.changed');
                    eventCount.set(tab, eventCount.get(tab) + 1);
                });
            }
        });
        await tab.goto(base);
    }
    const badgeCount = (tab, count) => tab.waitForFunction(expected =>
        document.querySelector('.inbox-badge')?.textContent === String(expected), count, { timeout: 4000 });
    await Promise.all([badgeCount(second, 2), badgeCount(other, 2)]);
    await Promise.all([second, other].map(async tab => {
        for (let i = 0; i < 80 && !eventCount.get(tab); i++) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(eventCount.get(tab), 'initial event after subscription');
    }));
    const otherEvents = eventCount.get(other);
    // Suppress timer/focus refresh in this tab while keeping the real socket.
    await second.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    docker(['tuxee', 'notify', '--users', a.name, '--type', 'error', '--text',
        'Untrusted <script>alert(1)</script> <img src="https://example.invalid/leak">\n\n[bad](javascript:alert%281%29) ![alt](https://example.invalid/image)']);
    await Promise.all([badgeCount(page, 3), badgeCount(second, 3)]);
    assert.equal(eventCount.get(other), otherEvents, 'targeted event stays in its account');
    await badgeCount(other, 2);
    await bell.click();
    await inbox.getByText('Untrusted', { exact: false }).waitFor();
    assert.equal(await inbox.locator('script, img, a[href^="javascript:"]').count(), 0);
    assert.match(await inbox.innerText(), /bad alt/);
    await inbox.locator('[data-type=error] .inbox-dismiss').click();
    await Promise.all([badgeCount(page, 2), badgeCount(second, 2)]);
    // Replacing the watched directory must re-register and fetch current state.
    docker(['mv', aPath.slice(0, -1), aPath.slice(0, -1) + '.old']);
    docker(['tuxee', 'notify', '--users', a.name, '--text', 'During reconnect']);
    await Promise.all([badgeCount(page, 1), badgeCount(second, 1)]);
    const fallback = await a.context.newPage();
    await fallback.routeWebSocket('**/api/events', socket => socket.close());
    await fallback.clock.install();
    await fallback.goto(base);
    await badgeCount(fallback, 1);
    docker(['tuxee', 'notify', '--users', a.name, '--text', 'Browser fallback']);
    await badgeCount(second, 2);
    assert.equal(await fallback.locator('.inbox-badge').textContent(), '1');
    await fallback.clock.fastForward(16000);
    await badgeCount(fallback, 2);
    assert.equal((await api(a, '/notifications', 'DELETE', undefined, 'bad-token')).status(), 403);
    await inbox.getByRole('button', { name: 'Dismiss all notifications' }).click();
    await Promise.all([page, second].map(tab => tab.locator('.notifications-button').waitFor({ state: 'hidden', timeout: 4000 })));
    await inbox.waitFor({ state: 'detached' });
    assert.equal((await feed(a)).count, 0);
    assert.equal((await feed(b)).count, 2);
    docker(['tuxee', 'notify', '--users', a.name, '--text', 'New after clearing']);
    await Promise.all([page, second].map(tab => tab.locator('.notifications-button').waitFor({ timeout: 4000 })));
    await bell.click();
    await inbox.locator('.inbox-dismiss').click();
    await Promise.all([page, second].map(tab => tab.locator('.notifications-button').waitFor({ state: 'hidden', timeout: 4000 })));
    await fallback.close();
    await second.close();
    await other.close();
    docker(["mv", aPath.slice(0, -1), aPath.slice(0, -1) + ".reconnected"]);
    docker(["mv", aPath.slice(0, -1) + ".old", aPath.slice(0, -1)]);
    await bell.click();
    await inbox.getByText('Tuxee v99.2.0 is available', { exact: true }).waitFor();
    await bell.click();
    console.log('PASS fallback, immediate delivery, background tabs, isolation, dismissal and reconnect');
    console.log('PASS Start keyboard and click dismissal, system actions, safe Markdown, About link and persistent dismissal');

    async function launchFavorite(menu, row, marker) {
        const old = await live();
        await menu.click();
        const source = await row.boundingBox();
        const board = await page.locator('.grid-stack').boundingBox();
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(board.x + board.width * .75, board.y + board.height * .73, { steps: 16 });
        await page.locator('.new-panel-drag').waitFor();
        assert.equal(await page.locator('.start-menu:popover-open, .command-shortcuts:popover-open').count(), 0);
        await screenshot(marker);
        await page.mouse.up();
        await page.waitForFunction(count => document.querySelectorAll('.terminal-view[data-state=connected]').length > count, old);
    }
    await launchFavorite(start, launcher.getByRole('menuitem', { name: 'System overview' }), 'drag-from-start');
    await page.getByText('POC_FAVORITE_OK', { exact: false }).first().waitFor();
    await start.click();
    const pathSource = await launcher.getByRole('menuitem', { name: 'Hosts file' }).boundingBox();
    const grid = await page.locator('.grid-stack').boundingBox();
    await page.mouse.move(pathSource.x + pathSource.width / 2, pathSource.y + pathSource.height / 2);
    await page.mouse.down(); await page.mouse.move(grid.x + grid.width * .375, grid.y + grid.height * .25, { steps: 16 });
    await page.locator('.new-panel-drag').waitFor(); await page.mouse.up();
    await page.locator('.cm-content').filter({ hasText: 'localhost' }).first().waitFor();
    assert.equal(await live(), 1);
    console.log('PASS Start favorite drag runs a real terminal');

    for (const [edge, width, height, theme, favorites = preferences.commandShortcuts] of [
        ['bottom', 1100, 760, 'light'], ['left', 1100, 760, 'dark'], ['right', 1100, 760, 'light'],
        ['top', 320, 680, 'dark'], ['bottom', 390, 660, 'light'], ['bottom', 360, 740, 'dark', preferences.commandShortcuts.slice(0, 1)], ['top', 844, 360, 'dark'], ['bottom', 844, 360, 'dark'],
    ]) {
        await page.goto('about:blank');
        await save({ theme, commandShortcuts: favorites, panelPosition: edge, mobilePanelPosition: edge === 'bottom' ? 'bottom' : 'top' });
        await page.setViewportSize({ width, height });
        await page.goto(base);
        const tag = `${width}-${edge}-${theme}`;
        for (const [opener, popup, name] of [[start, launcher, 'start'], [bell, inbox, 'inbox']]) {
            await opener.tap();
            await popup.waitFor();
            await settle(popup);
            const box = await popup.boundingBox(), button = await opener.boundingBox();
            const compact = width < 760 || height < 480;
            const bar = await page.locator('.topbar').boundingBox();
            if (compact) {
                const top = edge === 'bottom' ? 0 : bar.y + bar.height;
                const bottom = edge === 'bottom' ? bar.y : height;
                assert.deepEqual(box, { x: 0, y: top, width, height: bottom - top }, tag + ' fills the area beside the visible bar');
                if (name === 'start') {
                    const footer = await popup.locator('.start-footer').boundingBox();
                    if (edge === 'bottom') {
                        assert.equal(footer.y, top);
                        const rows = await popup.locator('.start-favorite-rows').boundingBox();
                        const lastApp = await popup.locator('.start-apps button').last().boundingBox();
                        assert.ok(Math.abs(bottom - rows.y - rows.height) <= 10, 'favorites sit beside the bottom bar');
                        assert.ok(Math.abs(bottom - lastApp.y - lastApp.height) <= 10, 'app list aligns to the bottom');
                    } else assert.equal(footer.y + footer.height, bottom);
                    if (height < 480) {
                        assert.ok(await popup.locator('.start-favorite-rows').evaluate(rows => rows.scrollHeight > rows.clientHeight));
                    }
                }
            } else {
                assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, tag);
                if (edge === 'right') assert.ok(box.x + box.width <= bar.x - 3, tag);
                if (edge === 'left') assert.ok(box.x >= bar.x + bar.width + 3, tag);
                if (edge === 'bottom') assert.ok(box.y + box.height <= button.y, tag);
                if (edge === 'top') assert.ok(box.y >= button.y + button.height, tag);
            }
            if (name === 'start') assert.equal(await popup.locator('.start-quick, [data-action=FolderPlus], [data-action=LayoutPanelTop]').count(), 0);
            assert.equal(await popup.evaluate(node => node.scrollWidth <= node.clientWidth), true);
            await screenshot(tag + '-' + name);
            if (tag === '1100-bottom-light' && name === 'inbox') {
                const dismiss = popup.locator('.inbox-dismiss').first();
                const itemCount = await popup.locator('.inbox-card').count();
                await dismiss.tap();
                await page.waitForFunction(count => document.querySelectorAll('.inbox-card').length === count, itemCount - 1);
                const after = await popup.boundingBox();
                assert.ok(after.height < box.height, 'inbox shrinks to fit fewer messages');
                assert.ok(Math.abs(after.y + after.height - box.y - box.height) < 1, 'inbox stays attached to bottom bar');
            }
            await opener.tap();
            assert.equal(await popup.count(), 0);
        }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await start.tap();
    await bell.tap();
    assert.equal(await launcher.count(), 0);
    assert.equal(await inbox.isVisible(), true);
    await bell.tap();
    await start.tap();
    assert.equal(await launcher.evaluate(node => node.getAnimations().length), 0);
    await launcher.locator('[data-action=Settings]').tap();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.waitFor();
    assert.equal(await launcher.count(), 0);
    await settings.getByRole('button', { name: 'Close dialog' }).tap();
    await settings.waitFor({ state: 'detached' });
    const barMenu = page.locator('.menu-actions:popover-open');
    const menuItem = label => barMenu.getByRole('menuitem', { name: label, exact: true });
    const openBar = async (selector = '.brand-button') => {
        await page.locator(selector).first().click({ button: 'right' });
        await menuItem('Add desktop').waitFor();
    };
    await openBar();
    await menuItem('Bar position').click();
    assert.deepEqual(await barMenu.locator('.menu-submenu:not([hidden]) button').allTextContents(), ['Top', 'Bottom']);
    await menuItem('Top').click();
    await page.locator('#app[data-panel-position=top]').waitFor();

    await page.goto('about:blank');
    await page.setViewportSize({ width: 1280, height: 860 });
    const hidden = { ...preferences.workspaces[0].panels[0], id: 'parked', minimized: true };
    await save({ workspaces: [{ ...preferences.workspaces[0], panels: [...preferences.workspaces[0].panels, hidden] }] });
    await page.goto(base);
    const snapshot = async () => (await (await api(a, '/me')).json()).settings;
    for (const [edge, target] of [['Bottom', '.component-tabs'], ['Right', '[data-component-name=parked]'], ['Left', '.workspace-tab'], ['Top', '.theme-toggle']]) {
        await openBar(target);
        await menuItem('Bar position').click();
        assert.deepEqual(await barMenu.locator('.menu-submenu:not([hidden]) button').allTextContents(), ['Top', 'Bottom', 'Left', 'Right']);
        if (edge === 'Left') await screenshot('right-panel-context');
        await menuItem(edge).click();
        await page.locator('#app[data-panel-position=' + edge.toLowerCase() + ']').waitFor();
        assert.equal((await snapshot()).panelPosition, edge.toLowerCase());
        if (edge === 'Bottom') {
            await page.reload();
            await openBar('.theme-toggle');
            assert.ok(await barMenu.evaluate(menu => document.activeElement === menu), 'first right-click after reload leaves all actions neutral');
            await page.keyboard.press('ArrowUp');
            assert.ok(await menuItem('Hide resource monitor').evaluate(node => document.activeElement === node));
            const collapsed = await barMenu.boundingBox();
            await menuItem('Bar position').click();
            const expanded = await barMenu.boundingBox();
            assert.ok(expanded.y < collapsed.y && expanded.height > collapsed.height);
            assert.ok(await barMenu.evaluate(menu => menu.scrollHeight <= menu.clientHeight + 1));
            await screenshot('bottom-context-expanded');
            await page.keyboard.press('Escape');
            await page.locator('.theme-toggle').focus();
            await page.keyboard.press('Shift+F10');
            assert.ok(await menuItem('Add desktop').evaluate(node => node === document.activeElement && node.matches(':focus-visible')));
            await page.keyboard.press('Escape');
        }
    }
    await openBar('.window-bar');
    await menuItem('Hide resource monitor').click();
    await page.locator('.monitor-summary').waitFor({ state: 'hidden' });
    await page.reload();
    await openBar();
    await menuItem('Show resource monitor').click();
    await page.locator('.monitor-summary').waitFor();
    await openBar();
    await screenshot('navbar-context');
    await menuItem('Add desktop').click();
    await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    const shell = await page.locator('.terminal-view[data-state=connected]').first().getAttribute('data-terminal');
    await openBar();
    await menuItem('Close all desktops').click();
    const confirm = page.getByRole('dialog', { name: 'Close all desktops' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal((await snapshot()).workspaces.length, 2);
    await page.locator('[data-workspace=work] > .workspace-tab').click();
    await openBar();
    await menuItem('Close all desktops').click();
    await confirm.getByRole('button', { name: 'Close all desktops' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-tab').length === 1 && !document.querySelector('.workspace-tab-item[data-workspace=work]'));
    await page.waitForFunction(async id => (await (await fetch('api/terminals')).json()).every(t => t.id !== id || t.closedAt), shell);
    await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    await page.reload();
    assert.equal((await snapshot()).workspaces.length, 1);
    console.log('PASS bar menus, four edges, compact choices, persistent monitor toggle, bulk close cancellation and terminal cleanup');
    await start.tap();
    await launcher.locator('[data-action=LogOut]').tap();
    await page.locator('.login-form').waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS desktop anchors, mobile bars and second-tap toggle, reduced motion and logout');
} finally {
    await browser.close();
    for (const name of created) {
        exec(['pkill', '-KILL', '-u', name]);
        docker(['userdel', '-r', name]);
    }
}
