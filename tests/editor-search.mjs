import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
assert.equal(process.getuid(), 0);
const home = await mkdtemp('/tmp/tuxee-search-user-'), state = await mkdtemp('/tmp/tuxee-search-state-'), user = `tuxee-search-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
await chown(home, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url'); run('chpasswd', [], `${user}:${password}\n`);
const first = `${home}/first.txt`, large = `${home}/large.txt`, matches = `${home}/matches.txt`;
await writeFile(matches, 'target\n'.repeat(16));
await chown(matches, Number(fields[2]), Number(fields[3]));
await writeFile(first, 'alpha\r\nbeta\r\nalpha\r\nbeta\r\na123 a456\r\n');
await writeFile(large, 'first-only\n'.repeat(10001) + 'second-only\n');
await chown(first, Number(fields[2]), Number(fields[3])); await chown(large, Number(fields[2]), Number(fields[3]));
const server = spawn(process.env.TUXEE_TEST_BINARY || './bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const { csrf } = await (await context.request.get(base + '/api/me')).json();
    const settings = { theme: 'dark', current: 'search', workspaces: [{ id: 'search', name: 'Search', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] }] };
    assert.equal((await context.request.put(base + '/api/settings', { data: settings, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } })).status(), 200);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); const path = page.getByRole('textbox', { name: 'File or directory path', exact: true });
    const open = async file => { await path.fill(file); await path.press('Enter'); await page.locator('.cm-content').waitFor(); };
    const search = page.locator('.editor-search'), find = search.getByRole('textbox', { name: 'Find text' }), replacement = search.getByRole('textbox', { name: 'Replacement text' });
    const action = name => search.getByRole('button', { name, exact: true });
    const count = total => search.locator('.editor-search-status').filter({ hasText: new RegExp(`^\\d+/${total}$`) }).waitFor();
    const position = value => search.locator('.editor-search-status').filter({ hasText: new RegExp(`^${value}$`) }).waitFor();
    await open(matches);
    const toggle = page.getByRole('button', { name: 'Search and replace', exact: true });
    await toggle.click(); await search.waitFor(); await position('0/0');
    assert.deepEqual(await search.locator('.editor-search-navigation').evaluate(node => [...node.children].map(n => n.tagName)), ['BUTTON', 'SPAN', 'BUTTON']);
    await find.pressSequentially('target'); await position('1/16');
    assert.equal(await find.inputValue(), 'target', 'incremental search preserves typed text');
    assert.ok(await find.evaluate(node => node === document.activeElement && node.selectionStart === node.value.length && node.selectionEnd === node.value.length), 'search retains focus and input caret');
    assert.equal(await page.locator('.cm-line').first().locator('.cm-searchMatch-selected').textContent(), 'target', 'first match is really selected');
    assert.ok(await page.getByRole('button', { name: 'Undo', exact: true }).isDisabled(), 'search selection does not edit the document');
    for (let index = 2; index <= 3; index++) { await action('Next match').click(); await position(`${index}/16`); }
    await replacement.fill('replacement'); await position('3/16');
    await replacement.fill(''); await position('3/16');
    await action('Previous match').click(); await position('2/16');
    await find.focus(); await find.press('F3'); await position('3/16');
    await find.press('Shift+F3'); await position('2/16');
    await action('Previous match').click(); await position('1/16');
    await action('Previous match').click(); await position('16/16');
    await action('Next match').click(); await position('1/16');
    await toggle.click(); await search.waitFor({ state: 'detached' });
    await toggle.click(); await search.waitFor(); await position('1/16');
    assert.equal(await find.inputValue(), 'target', 'toggling retains the search');
    await find.press('Control+f'); await search.waitFor();
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await position('0/16');
    await mkdir('test-results', { recursive: true });
    for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
        assert.ok(await search.evaluate(node => [...node.querySelectorAll('textarea')].every(field => {
            const style = getComputedStyle(field), input = getComputedStyle(document.querySelector('.file-filter'));
            return style.backgroundColor === input.backgroundColor && style.color === input.color && style.borderRadius === input.borderRadius;
        })), `search fields use shared input styling in ${theme}`);
        for (const width of [1280, 390, 320]) {
            await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(150);
            assert.ok(await search.evaluate(node => node.scrollWidth <= node.clientWidth), 'search drawer fits');
            const navigation = await search.locator('.editor-search-navigation').boundingBox();
            assert.ok(navigation.x >= 0 && navigation.x + navigation.width <= width);
            await page.screenshot({ path: `test-results/editor-search-${theme}-${width}.png` });
        }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(first);
    assert.deepEqual(await page.locator('.inspector-toolbar button:visible').evaluateAll(nodes => nodes.map(n => n.title)), ['Back to files', 'Undo', 'Redo', 'Search and replace', 'Download file', 'Save file']);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+f'); await search.waitFor();
    assert.ok(await search.locator('.editor-search-warning').isHidden());
    await find.fill('ALPHA'); await position('1/2');
    await search.getByRole('checkbox', { name: 'Match case' }).check(); await count(0);
    await search.getByRole('checkbox', { name: 'Match case' }).uncheck(); await position('1/2');
    await action('Next match').click(); await page.locator('.cm-searchMatch-selected').first().waitFor();
    assert.match(await page.locator('.cm-announced').textContent(), /Match on line \d+: .*alpha/i);
    await action('Previous match').click(); await page.locator('.cm-searchMatch-selected').first().waitFor();
    await find.fill('alpha\nbeta'); await position('1/2');
    await replacement.fill('X\nY'); await action('Replace all').click();
    assert.match(await page.locator('.cm-announced').textContent(), /Replacements: 2/);
    assert.ok(await page.getByRole('button', { name: 'Save file' }).isEnabled());
    assert.equal(await readFile(first, 'utf8'), 'alpha\r\nbeta\r\nalpha\r\nbeta\r\na123 a456\r\n');
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await count(2);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Save file"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');
    assert.equal(await readFile(first, 'utf8'), 'X\r\nY\r\nX\r\nY\r\na123 a456\r\n');
    await search.getByRole('checkbox', { name: 'Regular expression' }).check();
    await find.fill('a(\\d+)'); await position('1/2'); await replacement.fill('b$1'); await position('1/2');
    await action('Next match').click(); await action('Replace current').click(); await count(1);
    await action('Replace all').click(); await count(0);
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Save file"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');
    assert.equal(await readFile(first, 'utf8'), 'X\r\nY\r\nX\r\nY\r\nb123 b456\r\n');
    await find.fill('['); await search.getByText('Invalid regular expression').waitFor(); await position('0/0');
    assert.ok(await action('Replace all').isDisabled());
    await find.press('Escape'); assert.ok(await search.isHidden()); assert.ok(await page.locator('.cm-content').isVisible());
    await open(large); await page.getByRole('button', { name: 'Search and replace', exact: true }).click(); await search.waitFor();
    assert.ok(await search.locator('.editor-search-warning').isVisible());
    await find.fill('second-only'); await count(0);
    await page.getByRole('button', { name: 'Page down', exact: true }).click();
    await page.getByText('Page 2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Search and replace', exact: true }).click(); await search.waitFor();
    assert.ok(await search.locator('.editor-search-warning').isVisible()); await find.fill('second-only'); await position('1/1');
    await action('Next match').click(); assert.match(await page.locator('.cm-announced').textContent(), /Match on line 10002:/);
    await replacement.fill('changed'); await action('Replace current').click();
    assert.match(await page.locator('.cm-announced').textContent(), /Replaced match on line 10002/);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(400);
        const bounds = await search.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert.ok(await search.evaluate(node => node.scrollWidth <= node.clientWidth), 'search controls fit the drawer');
    }
    assert.deepEqual(errors, []);
    const czech = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    assert.equal((await czech.request.post(base + '/api/login', { data: { username: user, password, language: 'cs' }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const cs = await czech.newPage(); await cs.goto(base);
    const csPath = cs.getByRole('textbox', { name: 'Cesta k souboru nebo adresáři', exact: true });
    await csPath.fill(first); await csPath.press('Enter'); await cs.locator('.cm-content').waitFor();
    await cs.getByRole('button', { name: 'Najít a nahradit', exact: true }).click();
    await cs.getByRole('textbox', { name: 'Najít text', exact: true }).fill('b123');
    await cs.getByRole('button', { name: 'Další shoda', exact: true }).click();
    assert.match(await cs.locator('.cm-announced').textContent(), /Shoda na řádku \d+: .*b123/);
    await czech.close();
    const arabic = await browser.newContext({ viewport: { width: 320, height: 844 } });
    assert.equal((await arabic.request.post(base + '/api/login', { data: { username: user, password, language: 'ar' }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const ar = await arabic.newPage(); await ar.goto(base);
    await ar.locator('.path-input').fill(first); await ar.locator('.path-input').press('Enter'); await ar.locator('.cm-content').waitFor();
    await ar.locator('.cm-content').click(); await ar.keyboard.press('Control+f');
    const arSearch = ar.locator('.editor-search'); await arSearch.waitFor();
    assert.equal(await arSearch.locator('textarea').first().getAttribute('dir'), 'ltr');
    assert.ok(await arSearch.evaluate(node => node.scrollWidth <= node.clientWidth), 'RTL search controls fit the drawer');
    await ar.locator('.path-input').fill(large); await ar.locator('.path-input').press('Enter'); await ar.locator('.inspector-pagination').waitFor();
    assert.ok(await ar.locator('.inspector-footer').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'RTL paginated footer fits');
    await ar.screenshot({ path: 'test-results/inspector-footer-ar.png' });
    await arabic.close();
    for (const language of ['fr', 'uk']) {
        const translated = await browser.newContext({ viewport: { width: 320, height: 844 } });
        assert.equal((await translated.request.post(base + '/api/login', { data: { username: user, password, language }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
        const localized = await translated.newPage(); await localized.goto(base);
        await localized.locator('.path-input').fill(large); await localized.locator('.path-input').press('Enter'); await localized.locator('.inspector-pagination').waitFor();
        assert.ok(await localized.locator('.inspector-footer').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${language} paginated footer fits`);
        await localized.screenshot({ path: `test-results/inspector-footer-${language}.png` });
        await translated.close();
    }

    console.log('PASS themed inputs, toolbar toggle, current/total counter and wrapping navigation, search drawer, multiline replacement, regex captures, undo, save, page scope and mobile bounds');
} finally {
    if (browser) await browser.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
