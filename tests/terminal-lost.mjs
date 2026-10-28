import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a', base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), created = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', async response => {
    if (response.url() === base + '/api/terminals' && response.request().method() === 'POST' && response.ok()) created.push((await response.json()).id);
});
const terminal = page.locator('.terminal-view'), restart = terminal.getByRole('button', { name: 'Restart terminal', exact: true });
await mkdir('test-results', { recursive: true });
try {
    const response = await api('/terminals', 'POST', { name: 'Lost session fixture', columns: 80, rows: 24 });
    assert.equal(response.status(), 201);
    const lost = await response.json(); created.push(lost.id);
    assert.equal((await api('/settings', 'PUT', {
        theme: 'dark', current: 'work', workspaces: [{
            id: 'work', name: 'Desktop 1', columns: 4, rows: 2, active: 'terminal',
            panels: [
                { id: 'files', kind: 'files', path: fields[5], x: 0, y: 0, w: 2, h: 2 },
                { id: 'terminal', kind: 'terminal', terminal: lost.id, path: fields[5], x: 2, y: 0, w: 2, h: 2 },
            ],
        }],
    })).status(), 200);
    assert.equal((await api(`/terminals/${lost.id}`, 'DELETE')).status(), 200);
    await rm(`${fields[5]}/.local/state/tuxee/terminals/${lost.id}`, { recursive: true });
    await page.goto(base); await restart.waitFor();
    for (const [name, width, theme] of [
        ['desktop-dark', 1440, 'dark'], ['desktop-light', 1440, 'light'],
        ['mobile-light', 390, 'light'], ['mobile-dark', 390, 'dark'],
    ]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        if (await page.locator('html').getAttribute('data-theme') !== theme) {
            const saved = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
            await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
            assert.equal((await saved).status(), 200);
        }
        await page.waitForTimeout(300); await restart.waitFor();
        await page.screenshot({ path: `test-results/terminal-lost-${name}.png` });
        assert.equal(await terminal.getByText('Terminal session lost', { exact: true }).count(), 1);
        assert.equal(await terminal.locator('.terminal-host').isVisible(), false);
        const body = await terminal.boundingBox(), action = await restart.boundingBox();
        const text = await terminal.getByText('Terminal session lost', { exact: true }).boundingBox();
        assert.ok(Math.abs(action.x + action.width / 2 - body.x - body.width / 2) < 1, 'button is centered horizontally');
        assert.ok(Math.abs(text.x + text.width / 2 - body.x - body.width / 2) < 1, 'message is centered horizontally');
        assert.ok(text.y + text.height < action.y, 'message sits above the button');
        assert.ok(Math.abs((text.y + action.y + action.height) / 2 - body.y - body.height / 2) < 2, 'message and action are centered together vertically');
        assert.equal(await terminal.evaluate(node => getComputedStyle(node).backgroundColor),
            theme === 'dark' ? 'rgb(20, 25, 34)' : 'rgb(255, 255, 255)');
        assert.ok(await restart.evaluate(node => node.classList.contains('primary')));
    }
    console.log('PASS real missing session renders centered themed recovery on desktop/mobile in both themes');
    await restart.click();
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal(await terminal.locator('.terminal-recovery').count(), 0);
    assert.ok(await terminal.locator('.terminal-host').isVisible());
    const freshID = await terminal.getAttribute('data-terminal');
    assert.notEqual(freshID, lost.id);
    assert.equal((await (await api('/me')).json()).settings.workspaces[0].panels[1].terminal, freshID);
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'RECOVERY_%s\\n' 'WORKS'"); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('RECOVERY_WORKS'));
    assert.equal((await api(`/terminals/${freshID}`, 'DELETE')).status(), 200);
    await terminal.locator('.terminal-archive').waitFor();
    assert.match(await terminal.locator('.terminal-archive pre').textContent(), /RECOVERY_WORKS/);
    await rm(`${fields[5]}/.local/state/tuxee/terminals/${freshID}`, { recursive: true });
    await page.reload();
    await restart.waitFor();
    assert.equal(await terminal.getByText('Terminal session lost', { exact: true }).count(), 1, 'missing archive uses the same recovery view');
    await restart.click(); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await terminal.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('exit'); await page.keyboard.press('Enter');
    await page.locator('.terminal-view[data-state=ended]').waitFor();
    assert.equal(await terminal.locator('.terminal-recovery').count(), 0, 'normal process exit preserves its output');
    await terminal.locator('.terminal-archive').waitFor();
    assert.equal(await terminal.locator('.terminal-host').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS restart saves a new working shell; closure and normal exit archive output; missing archives show recovery');
} finally {
    await page.goto('about:blank');
    assert.equal((await api('/settings', 'PUT', original)).status(), 200);
    for (const id of created) await api(`/terminals/${id}`, 'DELETE');
    await browser.close();
}
