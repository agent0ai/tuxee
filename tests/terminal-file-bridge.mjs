import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.TUXEE_TEST_URL;
const container = process.env.TUXEE_TEST_CONTAINER;
if (!base || !container) throw Error('Set TUXEE_TEST_URL and TUXEE_TEST_CONTAINER to the disposable test container');
const docker = (...args) => {
    const result = spawnSync('docker', ['exec', container, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
    return result.stdout;
};
docker('useradd', '-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', 'tuxee-bridge-test');
docker('sh', '-c', "printf 'tuxee-bridge-test:toor\\n' | chpasswd && mkdir -p /home/tuxee-bridge-test/sub && chown tuxee-bridge-test:tuxee-bridge-test /home/tuxee-bridge-test/sub");
docker('sh', '-c', "mkdir -p /root/bridge-fixture/sub && printf 'first\\nsecond\\nthird\\n' > '/root/bridge-fixture/spaced file.txt' && printf 'relative\\n' > /root/bridge-fixture/sub/relative.txt && seq 1 10020 > /root/bridge-fixture/lines.txt");
docker('python3', '-c', `from pathlib import Path; Path('/root/bridge-fixture/mouse.py').write_text(${JSON.stringify(String.raw`import os, sys, termios, tty
mode = sys.argv[1]
old = termios.tcgetattr(0)
try:
    tty.setraw(0)
    os.write(1, ('\x1b[?1049h\x1b[?1006h\x1b[?' + mode + 'h\x1b[2J\x1b[H/root/bridge-fixture/sub\r\nhttp://terminal-link.invalid/tui\r\n\x1b]8;;https://terminal-link.invalid/osc-tui\x07WEB_TUI\x1b]8;;\x07\r\nMOUSE READY').encode())
    while os.read(0, 1) != b'q': pass
finally:
    os.write(1, ('\x1b[?' + mode + 'l\x1b[?1006l\x1b[?1049l').encode())
    termios.tcsetattr(0, termios.TCSANOW, old)
`)})`);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true });
const webRequests = [];
await context.route(/^https?:\/\/terminal-link\.invalid\//u, route => {
    webRequests.push(route.request());
    return route.fulfill({ contentType: 'text/plain', body: 'Terminal link target' });
});
const login = await context.request.post(base + '/api/login', { data: { username: 'root', password: 'toor' }, headers: { 'X-Tuxee-Client': 'web' } });
assert.equal(login.status(), 200);
const { csrf, settings: original } = await (await context.request.get(base + '/api/me')).json();
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [], inputs = [];
page.on('websocket', socket => socket.on('framesent', ({ payload }) => { if (Buffer.isBuffer(payload)) inputs.push(payload); }));
page.on('pageerror', error => errors.push(error.message));
let session;
try {
    const response = await api('/terminals', 'POST', { name: 'Bridge test', directory: '/root/bridge-fixture', columns: 80, rows: 24 });
    assert.equal(response.status(), 201); session = await response.json();
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'bridge', workspaces: [{ id: 'bridge', name: 'Bridge', columns: 4, rows: 2, active: 'term', panels: [
        { id: 'files', kind: 'files', path: '/root', x: 0, y: 0, w: 2, h: 2 },
        { id: 'term', kind: 'terminal', path: '/root/bridge-fixture', terminal: session.id, x: 2, y: 0, w: 2, h: 2 },
    ] }] })).status(), 200);
    await page.goto(base);
    const terminal = page.locator('[data-panel="term"] .terminal-view');
    await page.waitForFunction(() => document.querySelector('[data-panel="term"] .terminal-view')?.dataset.state === 'connected');
    const command = async value => { await terminal.locator('.xterm-helper-textarea').focus(); await page.keyboard.type(value); await page.keyboard.press('Enter'); };
    const point = async (text, count = 2, first = false) => {
        await page.waitForFunction(({ text, count }) => [...document.querySelectorAll('[data-panel="term"] .xterm-rows > div')].filter(row => row.textContent.includes(text)).length >= count, { text, count });
        return page.evaluate(({ text, first }) => {
            const rows = [...document.querySelectorAll('[data-panel="term"] .xterm-rows > div')];
            const row = rows.filter(row => row.textContent.includes(text)).at(first ? 0 : -1);
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            const nodes = []; let node;
            while ((node = walker.nextNode())) nodes.push(node);
            let offset = row.textContent.indexOf(text) + Math.floor(text.length / 2);
            for (const node of nodes) {
                if (offset < node.textContent.length) {
                    const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
                    const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
                offset -= node.textContent.length;
            }
            throw Error('path not visible');
        }, { text, first });
    };
    const openAt = async p => { await page.keyboard.down('Control'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Control'); };
    const outputPoint = async text => {
        await page.waitForFunction(text => [...document.querySelectorAll('[data-panel="term"] .xterm-rows > div')].some(row => row.textContent.startsWith(text) || row.textContent.startsWith('(' + text)), text);
        return point(text, 1);
    };
    const underlined = () => terminal.locator('.xterm-rows span').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).textDecorationLine.includes('underline')).map(node => node.textContent).join(''));
    const openWeb = async (url, activate) => {
        const next = context.waitForEvent('page');
        await activate();
        const popup = await next; await popup.waitForLoadState();
        assert.equal(popup.url(), url);
        assert.equal(await popup.evaluate(() => window.opener), null);
        assert.equal(webRequests.at(-1).headers().referer, undefined);
        await popup.close();
    };
    assert.deepEqual(await terminal.locator('.terminal-footer > div:last-child button').evaluateAll(nodes => nodes.slice(0, 3).map(n => n.getAttribute('aria-label'))), ['Rename terminal', 'Browse shell folder', 'Reconnect terminal']);
    const pin = page.locator('[data-panel="files"] [data-action="pin"]');
    assert.equal(await pin.getAttribute('title'), 'Pin current folder');
    assert.equal(await pin.getAttribute('aria-label'), 'Pin current folder');
    const saved = page.waitForResponse(response => response.url() === base + '/api/settings' && response.request().method() === 'PUT' && response.ok() && JSON.parse(response.request().postData()).workspaces[0].panels.some(panel => panel.id === 'files' && panel.pinned));
    await pin.click(); assert.equal(await pin.getAttribute('aria-pressed'), 'true'); await saved;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-panel="term"] .terminal-view')?.dataset.state === 'connected');
    assert.equal(await pin.getAttribute('aria-pressed'), 'true', 'pin survives reload');
    await command(`printf '%s\\n' 'Fetched 10.2 MB in 1s (10.4 MB/s)' "Run 'apt list --upgradable'" 'trixie/main /'`);
    const ordinary = ['Fetched 10.2 MB in 1s (10.4 MB/s)', "Run 'apt list --upgradable'", 'trixie/main /'];
    await page.waitForFunction(lines => lines.every(line => [...document.querySelectorAll('[data-panel="term"] .xterm-rows > div')].some(row => row.textContent.trim() === line)), ordinary);
    for (const text of ['10.2', 'MB/s', 'apt list --upgradable', 'trixie/main']) {
        const p = await point(text, 1);
        await page.mouse.move(p.x, p.y);
        assert.equal(await underlined(), '', 'ordinary command output is not highlighted on hover');
        assert.equal(await terminal.locator('.xterm-screen').getAttribute('title'), null);
    }
    await page.mouse.move(0, 0);
    for (const [output, visible, url] of [
        ['http://terminal-link.invalid/a?x=1&y=2#part', 'http://terminal-link.invalid/a?x=1&y=2#part', 'http://terminal-link.invalid/a?x=1&y=2#part'],
        ['(https://terminal-link.invalid/a_(b)).', 'https://terminal-link.invalid/a_(b)', 'https://terminal-link.invalid/a_(b)'],
        ['https://terminal-link.invalid/wrapped/' + 'x'.repeat(90), 'https://terminal-link.invalid/wrapped/', 'https://terminal-link.invalid/wrapped/' + 'x'.repeat(90)],
        ['\\033]8;;https://terminal-link.invalid/osc\\aWEB_TARGET\\033]8;;\\a', 'WEB_TARGET', 'https://terminal-link.invalid/osc'],
    ]) {
        await command(`printf '${output}\\n'`);
        const p = await outputPoint(visible);
        await page.mouse.move(0, 0);
        assert.equal(await underlined(), '', 'URLs are underlined only on hover');
        await page.mouse.move(p.x, p.y);
        assert.ok((await underlined()).includes(visible));
        assert.equal(await terminal.locator('.xterm-screen').getAttribute('title'), url + '\nCtrl+click to open');
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(100);
        assert.equal(context.pages().length, 1, 'plain URL clicks stay in the terminal');
        await openWeb(url, () => openAt(p));
    }
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-panel="term"] .terminal-view')?.dataset.state === 'connected');
    const restored = await outputPoint('WEB_TARGET');
    await page.mouse.move(0, 0);
    assert.equal(await underlined(), '', 'restored OSC links have no permanent underline');
    await openWeb('https://terminal-link.invalid/osc', () => openAt(restored));
    for (const [output, visible] of [
        ['ftp://terminal-link.invalid/file', 'ftp://terminal-link.invalid/file'],
        ['file://another-server/root/bridge-fixture/sub', 'file://another-server/root/bridge-fixture/sub'],
        ['\\033]8;;javascript:alert(1)\\ahttps://terminal-link.invalid/misleading\\033]8;;\\a', 'https://terminal-link.invalid/misleading'],
        ['\\033]8;;file://another-server/root\\a/root/bridge-fixture/sub\\033]8;;\\a', '/root/bridge-fixture/sub'],
    ]) {
        await command(`printf '${output}\\n'`);
        const p = await outputPoint(visible);
        await page.mouse.move(p.x, p.y);
        assert.equal(await underlined(), '', 'unsupported explicit destinations must not become detected links');
        await openAt(p);
        assert.equal(context.pages().length, 1);
        assert.equal(await page.locator('.file-view').count(), 1);
    }
    await page.mouse.move(0, 0);
    await command("printf '%s\\n' '\"file:///root/bridge-fixture/spaced%20file.txt\":2:3'");
    let p = await outputPoint('"file:///root/bridge-fixture/spaced%20file.txt":2:3');
    assert.equal(await terminal.locator('.terminal-path-hints').count(), 0, 'paths have no permanent underline overlay');
    assert.equal(await underlined(), '', 'paths are not underlined before hover');
    await page.mouse.move(p.x, p.y);
    assert.ok((await underlined()).includes('file:///root/bridge-fixture/spaced%20file.txt'), 'hover underlines the file URI');
    await page.mouse.move(0, 0);
    assert.equal(await underlined(), '', 'leaving the path removes its underline');
    assert.equal(await terminal.locator('.xterm-screen').getAttribute('title'), null);
    await page.mouse.move(p.x - 20, p.y); await page.mouse.down(); await page.mouse.move(p.x + 20, p.y, { steps: 5 }); await page.mouse.up();
    assert.equal(await page.locator('.file-view').count(), 1, 'text selection must not open a path');
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.file-view').count(), 1, 'plain mouse clicks do not open paths');
    await page.mouse.move(p.x, p.y);
    assert.equal(await terminal.locator('.xterm-screen').getAttribute('title'), 'Ctrl+click to open');
    await openAt(p);
    await page.waitForFunction(() => document.querySelectorAll('.file-view').length === 2);
    const opened = page.locator('.file-view').filter({ has: page.locator('.file-inspector') });
    await opened.locator('.cm-editor').waitFor();
    await page.waitForFunction(() => document.querySelector('.cm-editor .cm-content')?.textContent.includes('second'));
    await page.waitForFunction(() => { const selection = window.getSelection(); return selection?.anchorNode?.parentElement?.textContent === 'second' && selection.anchorOffset === 2; });
    assert.equal(await page.locator('[data-panel="files"] .path-input').inputValue(), '/root');
    assert.equal(await pin.getAttribute('aria-pressed'), 'true');
    const hostname = await page.locator('meta[name="tuxee-hostname"]').getAttribute('content');
    for (const [host, label] of [['localhost', 'FILE_LOCALHOST'], [hostname, 'FILE_SERVER']]) {
        await command(`printf '\\033]8;;file://${host}/root/bridge-fixture/spaced%%20file.txt:3:2\\a${label}\\033]8;;\\a\\n'`);
        p = await outputPoint(label); await openAt(p);
        await page.waitForFunction(() => { const selection = window.getSelection(); return selection?.anchorNode?.parentElement?.textContent === 'third' && selection.anchorOffset === 1; });
        assert.equal(await page.locator('.file-view').count(), 2, 'file URIs reuse the unpinned browser');
    }
    await command("printf '\\033[4mANSI_TEXT\\033[0m \\033[4:3m\\033]8;;https://terminal-link.invalid/ansi\\aANSI_LINK\\033]8;;\\a\\033[0m\\n'");
    await outputPoint('ANSI_TEXT'); await page.mouse.move(0, 0);
    for (const [label, style] of [['ANSI_TEXT', 'solid'], ['ANSI_LINK', 'wavy']]) {
        const span = terminal.locator('.xterm-rows span').filter({ hasText: new RegExp('^' + label + '$') }).last();
        assert.deepEqual(await span.evaluate(node => [getComputedStyle(node).textDecorationLine, getComputedStyle(node).textDecorationStyle]), ['underline', style], 'application-requested underlines survive link decoration changes');
    }
    await command("printf '%s\\n' '/root/bridge-fixture/lines.txt:10005:2'");
    p = await point('/root/bridge-fixture/lines.txt'); await openAt(p);
    await page.waitForFunction(() => { const selection = window.getSelection(); return selection?.anchorNode?.parentElement?.textContent === '10005' && selection.anchorOffset === 1; });
    await opened.getByRole('button', { name: 'Back to files' }).click();
    await command("cd sub; printf '%s\\n' './relative.txt'");
    p = await point('./relative.txt');
    await openAt(p);
    await page.waitForFunction(() => [...document.querySelectorAll('.file-nav input')].some(input => input.value === '/root/bridge-fixture/sub/relative.txt'));
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('relative') && document.activeElement.closest('.cm-editor'));
    await command("printf '%s\\n' '/root/bridge-fixture/missing.txt'");
    p = await point('/root/bridge-fixture/missing.txt'); await openAt(p);
    await page.locator('[data-panel="term"] .toast').waitFor();
    assert.equal(await page.locator('.file-view').count(), 2, 'missing path must not create a panel');
    await page.locator('[data-panel="term"] .toast button').click();
    const editor = opened.locator('.cm-content');
    await editor.focus(); await page.keyboard.type('unsaved');
    await terminal.getByRole('button', { name: 'Browse shell folder' }).click();
    const discard = page.getByRole('dialog', { name: 'Discard changes?' });
    await discard.getByRole('button', { name: 'Cancel' }).click();
    assert.ok((await editor.textContent()).includes('unsaved'), 'cancel preserves unsaved edits');
    await terminal.getByRole('button', { name: 'Browse shell folder' }).click();
    await discard.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.file-nav input')].some(input => input.value === '/root/bridge-fixture/sub'));
    const startMouse = async mode => {
        await command(`python3 /root/bridge-fixture/mouse.py ${mode}`);
        await page.waitForFunction(() => document.querySelector('[data-panel="term"] .xterm')?.classList.contains('enable-mouse-events'));
        await page.waitForFunction(() => document.querySelector('[data-panel="term"] .xterm-rows')?.textContent.includes('MOUSE READY'));
        return point('/root/bridge-fixture/sub', 1);
    };
    const stopMouse = async () => {
        await terminal.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('q');
        await page.waitForFunction(() => !document.querySelector('[data-panel="term"] .xterm')?.classList.contains('enable-mouse-events'));
    };
    for (const mode of [9, 1000, 1002, 1003]) {
        p = await startMouse(mode);
        await page.mouse.move(p.x, p.y);
        let before = inputs.length;
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(100);
        assert.ok(inputs.slice(before).some(bytes => bytes.includes(Buffer.from('\x1b[<'))), `plain click reaches mouse mode ${mode}`);
        await page.keyboard.down('Control');
        before = inputs.length;
        await page.mouse.down(); await page.mouse.move(p.x + 20, p.y); await page.mouse.move(p.x, p.y); await page.mouse.up();
        await page.keyboard.up('Control');
        assert.equal(inputs.length, before, `canceled modified drag does not leak to mode ${mode}`);
        assert.equal(await page.evaluate(() => document.activeElement.closest('[data-panel]')?.dataset.panel), 'term', 'moving away and back cancels path opening');
        before = inputs.length;
        await openAt(p);
        await page.waitForFunction(() => document.activeElement.closest('[data-panel]')?.dataset.panel !== 'term');
        const reports = Buffer.concat(inputs.slice(before)).toString();
        // Playwright moves to the click point before pressing; any-event mode may report that hover.
        if (mode === 1003) assert.match(reports, /^(?:\x1b\[<51;\d+;\d+M)*$/u);
        else assert.equal(reports, '', `Ctrl-click sends neither press nor release to mode ${mode}`);
        for (const [visible, url] of [['http://terminal-link.invalid/tui', 'http://terminal-link.invalid/tui'], ['WEB_TUI', 'https://terminal-link.invalid/osc-tui']]) {
            p = await point(visible, 1); await page.mouse.move(p.x, p.y);
            before = inputs.length;
            await openWeb(url, () => openAt(p));
            const reports = Buffer.concat(inputs.slice(before)).toString();
            if (mode === 1003) assert.match(reports, /^(?:\x1b\[<(?:35|51);\d+;\d+M)*$/u);
            else assert.equal(reports, '', `web links send no clicks to mouse mode ${mode}`);
        }
        await stopMouse();
    }
    // Exercise the reported application, including its real abbreviated home path.
    docker('mkdir', '-p', '/root/.cache');
    await command('mc /root/.cache /root');
    p = await point('~/.cache', 1, true);
    await page.mouse.move(p.x, p.y);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/terminal-links-mc.png' });
    let before = inputs.length;
    await openAt(p);
    await page.waitForFunction(() => [...document.querySelectorAll('.file-nav input')].some(input => input.value === '/root/.cache'));
    assert.equal(inputs.length, before, 'MC does not receive the opening click');
    await terminal.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('F10');
    await page.waitForFunction(() => !document.querySelector('[data-panel="term"] .xterm')?.classList.contains('enable-mouse-events'));
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-panel="term"] .terminal-view')?.dataset.state === 'connected');
    p = await startMouse(1000);
    await page.mouse.move(p.x, p.y);
    assert.equal(await terminal.locator('.xterm-screen').getAttribute('title'), 'Cmd+click to open');
    before = inputs.length;
    await page.keyboard.down('Meta'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Meta');
    await page.waitForFunction(() => document.activeElement.closest('[data-panel]')?.dataset.panel !== 'term');
    assert.equal(inputs.length, before, 'Mac Command-click overrides mouse reporting');
    p = await point('WEB_TUI', 1);
    await openWeb('https://terminal-link.invalid/osc-tui', async () => { await page.keyboard.down('Meta'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Meta'); });
    await stopMouse();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('button', { name: 'More components' }).waitFor();
    let termTab = page.locator('[data-component-name="term"]');
    if (!await termTab.count()) { await page.getByRole('button', { name: 'More components' }).click(); termTab = page.locator('[data-component-name="term"]'); }
    await termTab.click();
    await command("printf '%s\\n' 'https://terminal-link.invalid/touch'");
    p = await point('terminal-link.invalid/touch', 1);
    await openWeb('https://terminal-link.invalid/touch', () => page.touchscreen.tap(p.x, p.y));
    await command("printf '%s\\n' 'file:///root/bridge-fixture/sub'");
    p = await point('bridge-fixture/sub', 1);
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForFunction(() => document.querySelector('.component-tab.active')?.dataset.componentName !== 'term');
    await page.waitForFunction(() => [...document.querySelectorAll('.file-nav input')].some(input => input.value === '/root/bridge-fixture/sub'));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.waitForTimeout(250);
    assert.ok(await page.locator('.file-view:visible .file-footer').evaluate(node => node.scrollWidth <= node.clientWidth), 'file footer fits a 320px viewport');
    termTab = page.locator('[data-component-name="term"]');
    if (!await termTab.count()) await page.getByRole('button', { name: 'More components' }).click();
    await termTab.click();
    assert.ok(await terminal.locator('.terminal-footer').evaluate(node => node.scrollWidth <= node.clientWidth), 'terminal footer fits a 320px viewport');
    p = await startMouse(1000);
    before = inputs.length;
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(100);
    assert.ok(inputs.length > before, 'ordinary touch still reaches the TUI');
    assert.equal(await page.locator('.component-tab.active').getAttribute('data-component-name'), 'term');
    before = inputs.length;
    await terminal.getByRole('button', { name: 'Terminal contents as text', exact: true }).tap();
    const snapshot = page.locator('.terminal-text pre');
    await snapshot.evaluate(node => {
        const start = node.textContent.indexOf('/root/bridge-fixture/sub');
        const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, start + '/root/bridge-fixture/sub'.length);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    const openSelection = page.locator('[data-action="open-selected-path"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="open-selected-path"]')?.disabled);
    assert.ok(await page.locator('.terminal-text-actions').evaluate(node => node.scrollWidth <= node.clientWidth), 'selection action fits 320px');
    await page.screenshot({ path: 'test-results/terminal-links-touch.png' });
    await openSelection.tap();
    await page.waitForFunction(() => document.querySelector('.component-tab.active')?.dataset.componentName !== 'term');
    assert.equal(inputs.length, before, 'snapshot selection opening sends no TUI input');
    termTab = page.locator('[data-component-name="term"]');
    if (!await termTab.count()) await page.getByRole('button', { name: 'More components' }).click();
    await termTab.click();
    await terminal.getByRole('button', { name: 'Terminal contents as text', exact: true }).tap();
    await page.locator('.terminal-text pre').evaluate(node => {
        const value = 'http://terminal-link.invalid/tui', start = node.textContent.indexOf(value);
        const range = document.createRange(); range.setStart(node.firstChild, start); range.setEnd(node.firstChild, start + value.length);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.getByRole('button', { name: 'Open link', exact: true }).waitFor();
    before = inputs.length;
    await openWeb('http://terminal-link.invalid/tui', () => page.getByRole('button', { name: 'Open link', exact: true }).tap());
    assert.equal(inputs.length, before, 'selected web links send no TUI input');
    const other = await browser.newContext();
    try {
        assert.equal((await other.request.post(base + '/api/login', { data: { username: 'tuxee-bridge-test', password: 'toor' }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
        const otherCSRF = (await (await other.request.get(base + '/api/me')).json()).csrf;
        const otherAPI = (path, method = 'GET', data) => other.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': otherCSRF, 'X-Tuxee-Client': 'web' } });
        const created = await otherAPI('/terminals', 'POST', { name: 'cwd', directory: '/home/tuxee-bridge-test', columns: 80, rows: 24, command: 'cd sub; sleep 30' });
        assert.equal(created.status(), 201);
        const otherTerminal = await created.json();
        try {
            await page.waitForFunction(async ({ base, id }) => {
                const response = await fetch(`${base}/api/terminals/${id}/cwd`);
                return response.status === 404;
            }, { base, id: otherTerminal.id });
            let cwd;
            for (let attempt = 0; attempt < 50; attempt++) {
                const response = await otherAPI(`/terminals/${otherTerminal.id}/cwd`);
                assert.equal(response.status(), 200);
                cwd = (await response.json()).path;
                if (cwd.endsWith('/sub')) break;
                await page.waitForTimeout(100);
            }
            assert.equal(cwd, '/home/tuxee-bridge-test/sub', 'cwd lookup works under an unprivileged user without CAP_SYS_PTRACE');
        } finally { await otherAPI(`/terminals/${otherTerminal.id}`, 'DELETE'); }
    } finally { await other.close(); }
    assert.deepEqual(errors, []);
    console.log('PASS HTTP(S)/file/OSC links, opener isolation, scheme/host restrictions, hover-only underlines, pins, line/column, cwd, Ctrl/Cmd-click, mouse modes, MC and touch selection');
} catch (error) {
    console.error(await page.locator('[data-panel="term"] .xterm-rows > div').allTextContents());
    throw error;
} finally {
    if (original) await api('/settings', 'PUT', original).catch(() => {});
    if (session) await api(`/terminals/${session.id}`, 'DELETE').catch(() => {});
    await browser.close();
    docker('rm', '-rf', '/root/bridge-fixture');
    docker('userdel', '-r', 'tuxee-bridge-test');
}
