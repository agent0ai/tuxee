import { Power, RefreshCw } from 'lucide';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', container = process.env.TUXEE_TEST_CONTAINER;
const run = (command, args, input) => spawnSync(container ? 'docker' : command,
    container ? ['exec', '-i', container, command, ...args] : args, { input, encoding: 'utf8' });
const fields = run('getent', ['passwd', user]).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(run('chpasswd', [], `${user}:${password}\n`).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), created = [], errors = [], mutations = [], sockets = [];
let creations = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (/^\/api\/terminals(?:\/[^/]+)?$/.test(new URL(request.url()).pathname) && ['POST', 'DELETE'].includes(request.method())) mutations.push(request);
});
page.on('websocket', socket => { if (/\/api\/terminals\/[^/]+\/ws$/.test(socket.url())) sockets.push(socket); });
page.on('response', async response => {
    if (response.url() === base + '/api/terminals' && response.request().method() === 'POST' && response.ok()) {
        created.push((await response.json()).id); creations++;
    }
});
const terminal = page.locator('[data-panel="reset"] .terminal-view');
const reset = terminal.getByRole('button', { name: 'Reset terminal', exact: true, includeHidden: true });
const confirmation = page.getByRole('dialog', { name: 'Reset terminal?', exact: true });
const confirmReset = async (control = reset) => {
    await control.click();
    await confirmation.getByRole('button', { name: 'Kill and reset', exact: true }).click();
};
const connected = () => terminal.locator('..').locator('.terminal-view[data-state=connected]').waitFor();
const info = async () => (await api(`/terminals/${await terminal.getAttribute('data-terminal')}`)).json();
const command = async text => {
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text); await page.keyboard.press('Enter');
};
const waitFor = async (check, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await page.waitForTimeout(100);
    }
    throw Error(message);
};
const hold = async (path, method) => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), continued = Promise.withResolvers();
    await page.route(base + '/api' + path, async route => {
        if (route.request().method() !== method) return route.continue();
        entered.resolve(); await release.promise; await route.continue(); continued.resolve();
    });
    return { entered: entered.promise, release: async () => { release.resolve(); await continued.promise; } };
};
await mkdir('test-results', { recursive: true });
try {
    const panels = [];
    for (const [index, name] of ['reset', 'neighbor'].entries()) {
        const response = await api('/terminals', 'POST', { name, directory: fields[5], columns: 80, rows: 24 });
        assert.equal(response.status(), 201);
        const session = await response.json(); created.push(session.id);
        panels.push({ id: name, kind: 'terminal', terminal: session.id, path: fields[5], x: index * 2, y: 0, w: 2, h: 2 });
    }
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'reset-work', workspaces: [
        { id: 'reset-work', name: 'Reset test', columns: 4, rows: 2, active: 'reset', panels },
    ] })).status(), 200);
    await page.goto(base); await connected();
    const originalDOM = await terminal.elementHandle(), old = await info();
    const neighbor = await (await api(`/terminals/${panels[1].terminal}`)).json();
    assert.deepEqual(await terminal.locator('.terminal-footer > div').last().locator('button, span').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('aria-label') || node.textContent)),
    ['Rename terminal', 'Browse shell folder', 'Reconnect terminal', 'Reset terminal', '|', 'Jump to top', 'Jump to bottom']);
    for (const [label, icon] of [['Reconnect terminal', RefreshCw], ['Reset terminal', Power]]) {
        const paths = await terminal.getByRole('button', { name: label, exact: true }).locator('svg path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
        assert.deepEqual(paths, icon[2].filter(([tag]) => tag === 'path').map(([, attrs]) => attrs.d), `${label} icon`);
    }
    await command("printf 'OLD_%s\\n' HISTORY; xterm -title Reset-GUI &");
    await terminal.locator('.terminal-display[data-state=connected]').waitFor();
    const appPID = run('pgrep', ['-u', user, '-x', 'xterm']).stdout.trim();
    assert.match(appPID, /^\d+$/);
    const shellTab = page.locator('[data-panel="reset"] .terminal-tab');
    const appTab = page.locator('[data-panel="reset"] .display-window');
    const drawer = terminal.getByRole('textbox', { name: 'Terminal input drawer', exact: true });
    await shellTab.click();
    await terminal.getByRole('button', { name: 'Toggle terminal input', exact: true }).click();
    await drawer.fill('unsent draft');
    for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: 950 });
        if (await page.locator('html').getAttribute('data-theme') !== theme) {
            const saved = page.waitForResponse(response => response.url() === base + '/api/settings' && response.request().method() === 'PUT');
            await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
            assert.equal((await saved).status(), 200);
        }
        for (let cycle = 0; cycle < 2; cycle++) {
            await appTab.click();
            await terminal.locator('.terminal-display[data-state=connected]').waitFor();
            assert.equal(await terminal.locator('.terminal-footer').isVisible(), false);
            assert.equal(await drawer.isVisible(), false);
            assert.equal(await reset.isVisible(), false);
            if (!cycle) await page.screenshot({ path: `test-results/reset-gui-${width}-${theme}.png` });
            await shellTab.click();
            assert.ok(await terminal.locator('.terminal-footer').isVisible());
            assert.ok(await reset.isVisible()); assert.equal(await drawer.inputValue(), 'unsent draft');
            assert.equal(await terminal.locator('canvas').count(), 0);
            assert.ok(await terminal.locator('.terminal-footer').evaluate(node => node.scrollWidth <= node.clientWidth));
            if (!cycle) await page.screenshot({ path: `test-results/reset-terminal-${width}-${theme}.png` });
        }
        const connections = sockets.length;
        await reset.click(); await confirmation.waitFor();
        assert.match(await confirmation.textContent(), /kill all commands and GUI apps/);
        assert.match(await confirmation.textContent(), /cannot be undone/);
        assert.equal(await reset.isDisabled(), true);
        assert.equal(mutations.length, 0, 'opening confirmation must not delete or create a terminal');
        assert.equal((await info()).pid, old.pid);
        assert.equal(run('test', ['-e', `/proc/${appPID}`]).status, 0);
        assert.equal(sockets.length, connections);
        assert.ok(sockets.every(socket => !socket.isClosed()), 'confirmation must preserve terminal connections');
        await page.screenshot({ path: `test-results/reset-confirm-${width}-${theme}.png` });
        if (theme === 'dark') await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        else await page.keyboard.press('Escape');
        await confirmation.waitFor({ state: 'detached' });
        await waitFor(async () => !await reset.isDisabled(), 'cancelled reset remained disabled');
        assert.equal(mutations.length, 0, 'dismissed confirmation must not delete or create a terminal');
        assert.equal(sockets.length, connections);
        assert.ok(sockets.every(socket => !socket.isClosed()));
        assert.equal(await drawer.inputValue(), 'unsent draft');
    }
    await command("printf 'CANCEL_%s\\n' WORKS");
    await waitFor(async () => (await terminal.locator('.xterm-rows').textContent()).includes('CANCEL_WORKS'), 'cancelled reset broke terminal input');
    console.log('PASS desktop/mobile confirmation and Cancel/Escape preserve shell, GUI, connections and draft; footer hides only in GUI');
    await page.setViewportSize({ width: 1440, height: 950 });
    assert.equal(run('kill', ['-STOP', String(old.pid)]).status, 0);
    const deletion = await hold(`/terminals/${old.id}`, 'DELETE');
    await confirmReset(); await deletion.entered;
    assert.equal(await reset.isDisabled(), true);
    await reset.evaluate(node => { node.click(); node.click(); });
    await terminal.getByRole('button', { name: 'Reconnect terminal', exact: true }).click();
    await deletion.release(); await page.unroute(base + `/api/terminals/${old.id}`);
    await waitFor(async () => (await terminal.getAttribute('data-terminal')) !== old.id, 'reset did not replace terminal');
    await connected();
    const replacement = await info();
    assert.equal(creations, 1); assert.notEqual(replacement.pid, old.pid); assert.equal(replacement.name, old.name);
    assert.ok(await originalDOM.evaluate(node => node.isConnected));
    assert.ok((await (await api(`/terminals/${old.id}`)).json()).closedAt);
    await waitFor(() => run('test', ['-e', `/proc/${old.pid}`]).status !== 0, 'stopped shell survived reset');
    await waitFor(() => run('test', ['-e', `/proc/${appPID}`]).status !== 0, 'GUI process survived reset');
    assert.equal((await (await api('/me')).json()).settings.workspaces[0].panels[0].terminal, replacement.id);
    assert.equal((await (await api(`/terminals/${neighbor.id}`)).json()).pid, neighbor.pid);
    assert.equal(await drawer.inputValue(), 'unsent draft');
    assert.equal(await appTab.count(), 0);
    assert.equal((await terminal.locator('.xterm-rows').textContent()).includes('OLD_HISTORY'), false);
    await command("printf 'RESET_%s\\n' WORKS");
    await waitFor(async () => (await terminal.locator('.xterm-rows').textContent()).includes('RESET_WORKS'), 'replacement cannot accept input');
    console.log('PASS stopped shell and GUI killed; one replacement persists in the same panel, preserving name, draft and neighbor');

    await command('exit'); await page.locator('[data-panel="reset"] .terminal-view[data-state=ended]').waitFor();
    await terminal.getByRole('button', { name: 'Restart', exact: true }).click(); await connected();
    await command("printf 'EXIT_RESET_%s\\n' WORKS");
    await waitFor(async () => (await terminal.locator('.xterm-rows').textContent()).includes('EXIT_RESET_WORKS'), 'exited shell cannot reset');
    const beforeFailure = await info();
    await page.route(base + `/api/terminals/${beforeFailure.id}`, route => route.request().method() === 'DELETE'
        ? route.fulfill({ status: 409, json: { error: 'Test delete rejection' } }) : route.continue());
    await confirmReset(); await page.getByText('Test delete rejection', { exact: true }).waitFor(); await connected();
    assert.equal((await info()).id, beforeFailure.id);
    await page.unroute(base + `/api/terminals/${beforeFailure.id}`);
    await page.route(base + '/api/terminals', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 400, json: { error: 'Test create rejection' } }) : route.continue());
    await confirmReset();
    const restart = terminal.getByRole('button', { name: 'Restart terminal', exact: true });
    await restart.waitFor();
    assert.ok((await (await api(`/terminals/${beforeFailure.id}`)).json()).closedAt);
    await page.unroute(base + '/api/terminals'); await restart.click(); await connected();
    await page.route(base + '/api/settings', route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 409, json: { error: 'Test save rejection' } }) : route.continue());
    await confirmReset(); await restart.waitFor();
    const unsavedID = created.at(-1), beforeRetry = creations;
    await page.unroute(base + '/api/settings'); await restart.click(); await connected();
    assert.equal(creations, beforeRetry, 'save retry must reuse the replacement');
    assert.equal((await info()).id, unsavedID);
    assert.equal((await (await api('/me')).json()).settings.workspaces[0].panels[0].terminal, unsavedID);
    console.log('PASS exited-shell reset, delete failure preserves shell, create/save failures retry without duplicate shells');
    for (const dismiss of await page.locator('[data-panel="reset"] .toast button').all()) await dismiss.click();

    const closing = await info(), beforeClose = creations;
    const pendingDelete = await hold(`/terminals/${closing.id}`, 'DELETE');
    await confirmReset(); await pendingDelete.entered;
    await page.locator('[data-panel="reset"]').getByRole('button', { name: 'Close panel', exact: true }).click();
    await terminal.waitFor({ state: 'detached' }); await pendingDelete.release();
    await waitFor(async () => Boolean((await (await api(`/terminals/${closing.id}`)).json()).closedAt), 'close did not end resetting terminal');
    await page.unroute(base + `/api/terminals/${closing.id}`);
    assert.equal(creations, beforeClose, 'closing during delete must not create a shell');
    const pendingCreate = await hold('/terminals', 'POST');
    const neighborView = page.locator('[data-panel="neighbor"] .terminal-view');
    await confirmReset(neighborView.getByRole('button', { name: 'Reset terminal', exact: true })); await pendingCreate.entered;
    await page.locator('[data-panel="neighbor"]').getByRole('button', { name: 'Close panel', exact: true }).click();
    await neighborView.waitFor({ state: 'detached' }); await pendingCreate.release();
    await waitFor(() => creations === beforeClose + 1, 'held creation did not finish');
    await waitFor(async () => Boolean((await (await api(`/terminals/${created.at(-1)}`)).json()).closedAt), 'close leaked pending replacement');
    await page.unroute(base + '/api/terminals');
    assert.deepEqual(errors, []);
    console.log('PASS closing during deletion or creation leaves no replacement shell');
} catch (error) {
    console.error(error);
    throw error;
} finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.goto('about:blank');
    assert.equal((await api('/settings', 'PUT', original)).status(), 200);
    for (const id of created) await api(`/terminals/${id}`, 'DELETE');
    await browser.close();
}
