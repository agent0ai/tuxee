import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
assert.equal(spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
assert.equal((await context.request.post(base + '/api/login', {
    data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' },
})).status(), 200);
let { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, {
    method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
});
const system = await (await api('/system')).json();
const terminalResponse = await api('/terminals', 'POST', { directory: '/tmp', name: 'Terminal', columns: 80, rows: 24 });
assert.equal(terminalResponse.status(), 201);
const terminal = await terminalResponse.json();
assert.equal((await api('/settings', 'PUT', {
    theme: 'dark', current: 'mobile',
    workspaces: [{ id: 'mobile', name: 'Mobile', columns: 4, rows: 2, active: 'term', panels: [
        { id: 'term', kind: 'terminal', terminal: terminal.id, path: '/tmp', x: 0, y: 0, w: 2, h: 2 },
        ...[0, 1].map(y => ({ id: `files-${y}`, kind: 'files', path: '/tmp', x: 2, y, w: 2, h: 1 })),
    ] }],
})).status(), 200);
await context.clearCookies();
const page = await context.newPage(), errors = [], created = new Set([terminal.id]);
page.on('pageerror', error => errors.push(error.message));
page.on('response', async response => {
    if (response.url() === base + '/api/terminals' && response.request().method() === 'POST' && response.ok()) {
        created.add((await response.json()).id);
    }
});
const touch = await context.newCDPSession(page);
const term = page.locator('[data-panel=term]'), rows = term.locator('.xterm-rows');
const check = text => console.log('PASS ' + text);
async function command(text) {
    await term.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(text); await page.keyboard.press('Enter');
}
async function swipe(dy, steps = 8) {
    const box = await term.locator('.xterm-screen').boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 - dy / 2, id: 1 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let i = 1; i <= steps; i++) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + dy * i / steps }] });
        await page.waitForTimeout(20);
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
}
async function keyboardHeight(height) {
    // Emulate visual-viewport keyboard shrink independently of the layout viewport.
    await page.evaluate(height => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: height });
        visualViewport.dispatchEvent(new Event('resize'));
    }, height);
}
await mkdir('test-results', { recursive: true });
try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.title(), `Tuxee ${system.hostname}`);
    assert.equal(await page.locator('.login-metadata').textContent(), `Server ${system.hostname} • Tuxee v${system.version}`);
    assert.equal(await page.locator('.login-metadata a').getAttribute('href'), 'https://github.com/agent0ai/tuxee');
    assert.equal(await page.locator('input:focus').count(), 0, 'touch login must not force focus/keyboard');
    for (const width of [1440, 320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const form = await page.locator('.login-form').boundingBox();
        const metadata = await page.locator('.login-metadata').boundingBox();
        assert.ok(metadata.x >= 0 && metadata.x + metadata.width <= width);
        assert.ok(metadata.y >= form.y + form.height && metadata.y + metadata.height <= 844);
        if (width === 1440) await page.screenshot({ path: 'test-results/desktop-login-metadata.png' });
    }
    for (const height of [360, 300]) {
        await keyboardHeight(height);
        for (const field of ['username', 'password']) {
            const input = page.locator(`[name=${field}]`);
            await input.tap();
            assert.equal(await input.evaluate(node => getComputedStyle(node).fontSize), '16px');
        }
        const submit = await page.getByRole('button', { name: 'Sign in', exact: true }).boundingBox();
        assert.ok(submit.y >= 0 && submit.y + submit.height <= height, 'submit stays above emulated keyboard without scrolling');
        const metadata = await page.locator('.login-metadata').boundingBox();
        assert.ok(metadata.y >= submit.y + submit.height && metadata.y + metadata.height <= height, 'server metadata fits below the form above the emulated keyboard');
        assert.ok(await page.locator('.login-page').evaluate(node => node.scrollHeight <= node.clientHeight));
    }
    await page.screenshot({ path: 'test-results/mobile-login-keyboard.png' });
    await page.locator('[name=username]').fill(user);
    await page.locator('[name=password]').fill(password);
    await page.locator('[name=password]').press('Enter');
    await term.locator('[data-state=connected]').waitFor();
    assert.equal(await page.title(), `Tuxee ${system.hostname}`);
    ({ csrf } = await (await context.request.get(base + '/api/me')).json());
    await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    assert.ok(Math.abs(await page.locator('#app').evaluate(node => node.clientHeight) - 844) < 2);
    check('hostname title, login metadata/link, touch login, 16px inputs, visual-viewport keyboard simulation and login-to-workspace height');

    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(250);
        const code = `import os,tty,termios,select
old=termios.tcgetattr(0)
data=b''
try:
 tty.setraw(0)
 os.write(1,b'KEYS_READY_${width}\\r\\n')
 while not data.endswith(b'\\x04') and select.select([0],[],[],10)[0]:
  data+=os.read(0,4096)
finally:
 termios.tcsetattr(0,termios.TCSANOW,old)
print('KEYS_RESULT_${width}_'+data.hex(),flush=True)`;
        await command(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(code).toString('base64')}'))"`);
        await page.waitForFunction(width => document.querySelector('.xterm-rows')?.textContent.includes(`KEYS_READY_${width}`), width);
        const keys = [
            ['Enter', '\r'], ['Shift+Enter', '\x1b[13;2u'], ['Alt+Enter', '\x1b\r'],
            ['Control+Enter', '\r'], ['Control+Shift+Enter', '\r'], ['Alt+Shift+Enter', '\x1b\r'],
            ...'abcefghijklmnopqrstuvwxyz'.split('').map(key => ['Control+' + key.toUpperCase(), String.fromCharCode(key.charCodeAt(0) - 96)]),
            ['Control+Space', '\0'], ['Control+Backspace', '\b'], ['Control+Delete', '\x1b[3;5~'],
            ...['Up', 'Down', 'Right', 'Left'].map((key, i) => ['Control+Arrow' + key, `\x1b[1;5${'ABCD'[i]}`]),
            ['Shift+Tab', '\x1b[Z'], ['Alt+A', '\x1ba'], ['Alt+B', '\x1bb'], ['F1', '\x1bOP'], ['F5', '\x1b[15~'],
        ];
        for (const [key] of keys) {
            await page.keyboard.press(key);
        }
        await page.keyboard.down('Shift');
        await page.keyboard.down('Enter'); await page.keyboard.down('Enter');
        await page.keyboard.up('Enter'); await page.keyboard.up('Shift');
        await page.keyboard.press('Control+D');
        await page.waitForFunction(width => document.querySelector('.xterm-rows')?.textContent.includes(`KEYS_RESULT_${width}_`), width);
        const result = (await rows.textContent()).match(new RegExp(`KEYS_RESULT_${width}_([0-9a-f]+)`));
        assert.equal(result?.[1], Buffer.from(keys.map(([, data]) => data).join('') + '\x1b[13;2u\x1b[13;2u\x04').toString('hex'));
    }
    check('desktop/mobile PTYs receive distinct Shift+Enter, Ctrl+A–Z, modified navigation, Alt/function keys and one sequence per repeated keydown');

    const heightBefore = await page.locator('#app').evaluate(node => node.clientHeight);
    await touch.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => visualViewport.scale) > 1);
    assert.ok(Math.abs(await page.locator('#app').evaluate(node => node.clientHeight) - heightBefore) < 2, 'pinch zoom must not shrink application layout');
    await touch.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(250);
        const additions = await page.locator('.component-controls .panel-additions').boundingBox();
        assert.ok(Math.abs(additions.x + additions.width - (width - 4)) < 2, 'additions remain on the right edge');
        assert.equal(await page.locator('.component-controls .add-panel:visible').count(), 2);
        await page.getByRole('button', { name: 'More components', exact: true }).tap();
        assert.ok(await page.locator('.overflow-tabs:visible .component-tab').count() >= 1);
        assert.equal(await page.locator('.component-tab:visible').count(), 3);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'User menu', exact: true }).tap();
        assert.equal(await page.getByRole('menuitem', { name: 'Close workspace', exact: true }).count(), 0);
        await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250);
    check('intentional zoom, right-aligned additions, reachable overflow and menu removal at phone widths');

    await command("printf 'MOBILE_LINE_%03d\\r\\n' $(seq 1 180)");
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('MOBILE_LINE_180'));
    const before = await rows.locator(':scope > div').first().textContent();
    await swipe(180);
    const earlier = await rows.locator(':scope > div').first().textContent();
    assert.notEqual(earlier, before, 'finger drag must move real terminal scrollback');
    assert.ok(earlier < before, 'downward drag reveals older lines');
    await swipe(-180);
    assert.notEqual(await rows.locator(':scope > div').first().textContent(), earlier);
    check('real CDP finger drags scroll both directions through PTY output');

    // Real raw-mode applications distinguish wheel reports from alternate-screen cursor keys.
    for (const mouse of [true, false]) {
        const code = `import os,tty,termios,select
old=termios.tcgetattr(0)
try:
 tty.setraw(0)
 os.write(1,b'\\x1b[?1049h\\x1b[?1h${mouse ? '\\x1b[?1000h\\x1b[?1006h' : ''}APP_READY')
 ready=select.select([0],[],[],10)[0]
 data=os.read(0,4096) if ready else b''
finally:
 os.write(1,b'\\x1b[?1000l\\x1b[?1006l\\x1b[?1l\\x1b[?1049l')
 termios.tcsetattr(0,termios.TCSANOW,old)
print('APP_RESULT_${mouse}_'+data.hex(),flush=True)`;
        await command(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(code).toString('base64')}'))"`);
        await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('APP_READY'));
        await swipe(70, 1);
        const expected = mouse ? '1b5b3c36343b' : '1b4f41';
        await page.waitForFunction(expected => document.querySelector('.xterm-rows')?.textContent.includes(expected), expected);
    }
    await command("printf 'INPUT_%s\\n' 'STILL_WORKS'");
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('INPUT_STILL_WORKS'));
    assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    check('application mouse wheel encoding, alternate-screen arrows and subsequent keyboard input preserve PTY identity');

    await page.getByRole('button', { name: 'Add file browser', exact: true }).tap();
    await page.locator('.file-view:visible').waitFor();
    await page.getByRole('button', { name: 'Add terminal', exact: true }).tap();
    await page.locator('.terminal-view:visible[data-state=connected]').waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(300);
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    assert.equal(await page.locator('.component-controls:visible').count(), 0);
    await command("printf 'DESKTOP_COPY_%03d\\r\\n' $(seq 1 90)");
    await page.waitForFunction(() => document.querySelector('[data-panel=term] .xterm-rows')?.textContent.includes('DESKTOP_COPY_090'));
    const line = rows.locator(':scope > div').filter({ hasText: 'DESKTOP_COPY_' }).first();
    const box = await line.boundingBox();
    // Start inside the text, clear of the panel's left resize handle.
    await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await page.screenshot({ path: 'test-results/mobile-desktop-selection.png' });
    await term.locator('.xterm-selection > div').first().waitFor();
    assert.ok(await page.evaluate(() => document.execCommand('copy')), 'native browser Copy invokes the xterm selection handler');
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /KTOP_COPY/);
    await page.mouse.move(box.x + 50, box.y + box.height / 2);
    const desktopBefore = await rows.locator(':scope > div').first().textContent();
    await page.mouse.wheel(0, -200); await page.waitForTimeout(150);
    assert.notEqual(await rows.locator(':scope > div').first().textContent(), desktopBefore);
    await page.reload(); await term.locator('[data-state=connected]').waitFor();
    assert.equal((await (await api(`/terminals/${terminal.id}`)).json()).pid, terminal.pid);
    assert.deepEqual(errors, []);
    check('mobile additions activate, desktop selection/copy/wheel and retained terminal reconnect');
} finally {
    await page.waitForTimeout(350); await page.goto('about:blank');
    await api('/settings', 'PUT', original);
    for (const id of created) await api(`/terminals/${id}`, 'DELETE');
    await browser.close();
}
