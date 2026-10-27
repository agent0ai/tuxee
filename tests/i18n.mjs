import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const languageCodes = ['ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fil', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'is', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nb', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sr-Latn', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW'];
const catalogs = Object.fromEntries(await Promise.all(languageCodes.map(async code => [code, JSON.parse(await readFile(`internal/i18n/locales/${code}.json`, 'utf8'))])));

const compiled = await build({ entryPoints: ['web/i18n.ts'], bundle: true, format: 'iife', globalName: 'i18n', write: false });
const sandbox = { document: { querySelector: () => null, documentElement: {} } };
runInNewContext(compiled.outputFiles[0].text, sandbox);
sandbox.i18n.setTranslations({ language: 'cs', direction: 'ltr', languages: [], cookie: 'language_test', texts: { 'test.message': 'Soubor {name}: {detail}', 'test.nested': 'Přístup odepřen' } });
assert.equal(sandbox.i18n.t('missing.key', { name: 'a"b', count: 5 }), '[!missing.key count=5 name="a\\"b"]');
assert.equal(sandbox.i18n.t('missing.key'), '[!missing.key]');
assert.equal(sandbox.i18n.t('test.message', { name: '<script>{detail}', detail: { key: 'test.nested' } }), 'Soubor <script>{detail}: Přístup odepřen');
assert.equal(sandbox.i18n.t('test.message', { name: 'a.txt' }), '[!test.message name="a.txt"]');

sandbox.i18n.setTranslations({ ...sandbox.i18n.translations(), language: 'en-12' });
assert.equal(sandbox.i18n.locale(), 'en', 'invalid custom locale cannot break date/number formatting');
sandbox.i18n.setTranslations({ ...sandbox.i18n.translations(), language: 'ar', direction: 'rtl' });
assert.equal(sandbox.document.documentElement.dir, 'rtl');

await import('./rtl-tabs.mjs');

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-i18n-user-'), user = `tuxee-i18n-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
await chown(home, Number(fields[2]), Number(fields[3]));
await writeFile(home + '/sample.txt', 'localization fixture\n');
await chown(home + '/sample.txt', Number(fields[2]), Number(fields[3]));
const mixedName = 'report-שלום-العربية-فارسی.txt';
await writeFile(home + '/' + mixedName, 'localization fixture\n');
await chown(home + '/' + mixedName, Number(fields[2]), Number(fields[3]));
for (const name of ['image-one.png', 'image-two.png']) {
    await writeFile(home + '/' + name, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=', 'base64'));
    await chown(home + '/' + name, Number(fields[2]), Number(fields[3]));
}
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-i18n-server-');
await chmod(state, 0o755); await copyFile('bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'cs-CZ' });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], languageRequests = [];
    context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/language') languageRequests.push(request.url()); });
    await page.goto(base); await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'fresh browsers default to English regardless of browser locale');
    assert.deepEqual(await page.locator('[name=language] option').allTextContents(), languageCodes.map(code => `${code.toUpperCase()} ${catalogs[code].name}`));
    assert.equal(languageRequests.length, 0, 'index already contains the login catalog');
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/i18n-login-en.png' });
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('cs');
    await page.getByRole('button', { name: 'Přihlásit se', exact: true }).waitFor();
    assert.equal(await page.locator('[name=username]').inputValue(), user);
    assert.equal(await page.locator('[name=password]').inputValue(), password);
    assert.equal(languageRequests.length, 1);
    const languageCookie = (await context.cookies()).find(cookie => cookie.name.startsWith('tuxee_language_'));
    assert.ok(languageCookie && languageCookie.value === 'cs' && !languageCookie.httpOnly && languageCookie.sameSite === 'Strict');
    const instance = (await readFile(state + '/state/instance-id', 'utf8')).trim();
    assert.equal(languageCookie.name, 'tuxee_language_' + instance);
    const tab = await context.newPage(); await tab.goto(base);
    await tab.getByRole('button', { name: 'Přihlásit se', exact: true }).waitFor();
    await tab.reload(); await tab.getByRole('button', { name: 'Přihlásit se', exact: true }).waitFor();
    await tab.setViewportSize({ width: 390, height: 740 });
    await tab.screenshot({ path: 'test-results/i18n-login-cs-mobile.png' });
    assert.equal(await tab.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
    await tab.close();

    await page.getByRole('button', { name: 'Přihlásit se', exact: true }).click();
    await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    assert.equal(await page.locator('[name=language]').count(), 0, 'language selection only exists on login');
    const retained = (await (await context.request.get(base + '/api/terminals')).json())[0];
    const terminalLanguage = async pid => {
        const entries = run('runuser', ['-u', user, '--', 'cat', `/proc/${pid}/environ`]).split('\0');
        return entries.find(value => value.startsWith('LANGUAGE='));
    };
    assert.equal(await terminalLanguage(retained.pid), 'LANGUAGE=cs:en', 'new terminals use the authenticated language');
    const file = page.locator('.file-view').first();
    await file.locator(`.file-entry[data-path="${home}/sample.txt"]`).waitFor();
    assert.equal(await file.locator('[data-action=copy]').isDisabled(), true);
    await file.locator(`.file-entry[data-path="${home}/sample.txt"] .file-name`).click();
    assert.equal(await file.locator('[data-action=copy]').isDisabled(), false, 'selection uses action IDs in Czech');
    await file.getByRole('button', { name: 'Vlastnosti', exact: true }).click();
    const properties = page.getByRole('dialog', { name: 'Vlastnosti', exact: true });
    await properties.getByText('Celková velikost', { exact: true }).waitFor();
    await properties.getByRole('button', { name: 'Zavřít dialog', exact: true }).click();
    await file.locator('[data-action=trash]').click();
    await page.waitForFunction(() => document.querySelector('.panel:has(.file-view) .path-input')?.value === 'trash:///');
    assert.equal(await file.getByRole('button', { name: 'Vlastnosti', exact: true }).isDisabled(), true, 'Properties uses a reference, independent of its title');
    await file.locator('[data-action=home]').click();
    await page.locator('.workspace-tab-item.active .workspace-menu').click();
    assert.equal(await page.getByRole('menuitem', { name: 'Aktivovat', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Uživatelská nabídka', exact: true }).click();
    assert.equal(await page.locator('.account-menu [data-action=Info]').innerText(), 'O aplikaci');
    await page.getByRole('menuitem', { name: 'Nastavení', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: 'Nastavení', exact: true }).locator('[name=language]').count(), 0);
    await page.getByRole('button', { name: 'Zavřít dialog', exact: true }).click();
    await page.screenshot({ path: 'test-results/i18n-workspace-cs.png' });
    assert.ok(!(await page.locator('body').innerText()).includes('[!'), 'rendered UI has no missing translations');

    const permission = await page.evaluate(async () => {
        const me = await (await fetch('/api/me')).json();
        const response = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf }, body: JSON.stringify({ operation: 'list', path: '/root' }) });
        return { status: response.status, body: await response.json(), language: me.i18n.language };
    });
    assert.equal(permission.language, 'cs'); assert.equal(permission.status, 400);
    assert.equal(permission.body.text.key, 'error.path'); assert.equal(permission.body.text.vars.detail.key, 'error.permissionDenied');
    await page.evaluate(name => { document.cookie = `${name}=en; Path=/; SameSite=Strict`; }, languageCookie.name);
    await page.reload(); await page.getByRole('button', { name: 'Uživatelská nabídka', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'cs', 'active session overrides a changed preference cookie');
    const locked = await (await context.request.get(base + '/api/language?language=en')).json();
    assert.equal(locked.language, 'cs');
    await page.getByRole('button', { name: 'Uživatelská nabídka', exact: true }).click();
    await page.evaluate(() => { window.logoutMarker = true; });
    await page.route('**/api/language', async route => {
        await page.evaluate(() => window.dispatchEvent(new Event('tuxee-connection-check')));
        await new Promise(resolve => setTimeout(resolve, 750));
        await route.continue();
    });
    await page.getByRole('menuitem', { name: 'Odhlásit se', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.logoutMarker), true, 'delayed login catalog must not turn deliberate logout into expiry/reload');
    await page.unroute('**/api/language');
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'User menu', exact: true }).waitFor();
    assert.equal(await terminalLanguage(retained.pid), 'LANGUAGE=cs:en', 'English re-login leaves retained terminal language unchanged');
    const me = await (await context.request.get(base + '/api/me')).json();
    const created = await context.request.post(base + '/api/terminals', {
        headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': me.csrf },
        data: { directory: home, name: 'English language test', columns: 80, rows: 24 }
    });
    assert.equal(created.status(), 201);
    const englishTerminal = await created.json();
    assert.equal(await terminalLanguage(englishTerminal.pid), 'LANGUAGE=en', 'new terminals follow the new English session');
    await context.close();
    for (const code of languageCodes) {
        const localized = await browser.newContext({ viewport: { width: 390, height: 740 } });
        const view = await localized.newPage();
        view.on('pageerror', error => errors.push(`${code}: ${error.message}`));
        const texts = catalogs[code].texts;
        await view.goto(base);
        await view.locator('[name=language]').selectOption(code);
        await view.getByRole('button', { name: texts['login.signIn'], exact: true }).waitFor();
        assert.equal(await view.locator('html').getAttribute('lang'), code);
        const rtl = ['ar', 'he', 'fa'].includes(code), direction = rtl ? 'rtl' : 'ltr';
        assert.equal(await view.locator('html').getAttribute('dir'), direction);
        if (rtl) {
            await view.locator('[name=language]').selectOption('en');
            await view.getByRole('button', { name: catalogs.en.texts['login.signIn'], exact: true }).waitFor();
            assert.equal(await view.locator('html').getAttribute('dir'), 'ltr');
            await view.locator('[name=language]').selectOption(code);
            await view.getByRole('button', { name: texts['login.signIn'], exact: true }).waitFor();
            await view.reload();
            await view.getByRole('button', { name: texts['login.signIn'], exact: true }).waitFor();
            assert.equal(await view.locator('html').getAttribute('dir'), 'rtl', 'cookie selects initial direction');
        }
        const bounds = async () => {
            const overflow = await view.evaluate(() => [...document.querySelectorAll('dialog[open], dialog[open] .modal-body, dialog[open] .modal-actions, dialog[open] h2, dialog[open] button, .login-card')]
                .filter(node => node.getBoundingClientRect().width > 0)
                .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().left < -1 || node.getBoundingClientRect().right > innerWidth + 1)
                .map(node => ({ tag: node.tagName, class: node.className, text: node.textContent.slice(0, 80) })));
            assert.deepEqual(overflow, [], `${code}: translated content must fit`);
            // Viewport changes reconcile the header in a queued animation frame.
            try { await view.waitForFunction(() => document.body.scrollWidth <= innerWidth); }
            catch (error) { await view.screenshot({ path: `test-results/i18n-${code}-overflow.png` }); throw error; }
        };
        await bounds();
        await view.setViewportSize({ width: 320, height: 640 }); await bounds();
        await view.screenshot({ path: `test-results/i18n-${code}-login-mobile.png` });
        await view.locator('[name=username]').fill(user); await view.locator('[name=password]').fill(password);
        await view.getByRole('button', { name: texts['login.signIn'], exact: true }).click();
        await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).waitFor();
        const sessionBundle = (await (await localized.request.get(base + '/api/me')).json()).i18n;
        assert.equal(sessionBundle.language, code);
        assert.equal(sessionBundle.texts['common.save'], texts['common.save'], 'session retains the exact catalog');
        const tabName = texts['app.workspaceNumber'].replace('{count}', '12');
        await view.locator('.workspace-tab-item.active .workspace-menu').click();
        await view.getByRole('menuitem', { name: texts['common.rename'], exact: true }).click();
        await view.locator('dialog input').fill(tabName);
        const savedName = view.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PUT'
            && response.request().postDataJSON().workspaces.some(workspace => workspace.name === tabName));
        await view.getByRole('button', { name: texts['common.continue'], exact: true }).click();
        assert.ok((await savedName).ok());
        await view.reload(); await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).waitFor();
        if (['ca', 'ms', 'sr-Latn'].includes(code)) {
            const preference = (await localized.cookies()).find(cookie => cookie.name.startsWith('tuxee_language_'));
            assert.equal(preference?.value, code, 'preference keeps the exact locale code');
            await view.evaluate(name => { document.cookie = `${name}=en; Path=/; SameSite=Strict`; }, preference.name);
            await view.reload();
            await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).waitFor();
            assert.equal(await view.locator('html').getAttribute('lang'), code, 'session survives preference changes and reload');
            assert.equal(await view.locator('html').getAttribute('dir'), 'ltr');
            const locked = await (await localized.request.get(base + '/api/language?language=en')).json();
            assert.equal(locked.language, code);
            assert.equal(locked.texts['common.save'], texts['common.save']);
        }
        if (rtl) {
            await view.setViewportSize({ width: 1440, height: 900 });
            await view.locator('.terminal-view[data-state=connected]').first().waitFor();
            const files = view.locator('.file-view').first();
            await files.locator(`.file-entry[data-path="${home}/${mixedName}"]`).waitFor();
            const source = files.locator(`.file-entry[data-path="${home}/${mixedName}"] .file-name`);
            assert.equal(await source.locator('span').getAttribute('dir'), 'auto');
            const secondFiles = view.locator('.file-view').nth(1);
            await secondFiles.hover(); await source.hover();
            const a = await source.boundingBox(), b = await secondFiles.boundingBox();
            await view.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await view.mouse.down();
            await view.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
            try { await view.waitForFunction(() => !!document.querySelectorAll('.file-view')[1]?.hasAttribute('data-drop')); }
            catch (error) { await view.screenshot({ path: `test-results/i18n-${code}-drag-failure.png` }); throw error; }
            assert.equal(await secondFiles.getAttribute('data-drop-hint'), texts['files.copyModifierHint']);
            assert.equal(await secondFiles.evaluate(n => getComputedStyle(n, '::before').visibility), 'visible');
            await view.keyboard.press('Escape'); await view.mouse.up();
            await source.dblclick();
            await files.locator('.cm-content').waitFor();
            assert.equal(await files.locator('.cm-editor').evaluate(n => getComputedStyle(n).direction), 'ltr');
            assert.equal(await view.locator('.path-input').first().inputValue(), `${home}/${mixedName}`);
            assert.equal(await view.locator('.path-input').first().evaluate(n => getComputedStyle(n).direction), 'ltr');
            await files.locator('.cm-content').click();
            await view.keyboard.press('Control+End'); await view.keyboard.insertText(`RTL ${code}: שלום العربية فارسی\n`);
            await files.getByRole('button', { name: texts['editor.saveFile'], exact: true }).click();
            // File bytes, including names and punctuation, must not acquire bidi control characters.
            for (let attempt = 0; !(await readFile(home + '/' + mixedName, 'utf8')).includes(`RTL ${code}: שלום العربية فارسی`); attempt++) {
                assert.ok(attempt < 100, 'editor saved exact mixed-script text');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            await files.getByRole('button', { name: texts['editor.backToFiles'], exact: true }).click();
            await files.locator(`.file-entry[data-path="${home}/image-one.png"] .file-name`).dblclick();
            await files.locator('.file-image').waitFor();
            await files.locator('.inspector-body').click();
            await view.keyboard.press('ArrowLeft');
            await view.waitForFunction(path => document.querySelector('.path-input')?.value === path, `${home}/image-two.png`);
            await view.keyboard.press('ArrowRight');
            await view.waitForFunction(path => document.querySelector('.path-input')?.value === path, `${home}/image-one.png`);
            await files.getByRole('button', { name: texts['editor.nextFile'], exact: true }).click();
            await view.waitForFunction(path => document.querySelector('.path-input')?.value === path, `${home}/image-two.png`);
            await files.getByRole('button', { name: texts['editor.backToFiles'], exact: true }).click();
            const terminal = view.locator('.terminal-view[data-state=connected]').first();
            assert.equal(await terminal.locator('.terminal-host').evaluate(n => getComputedStyle(n).direction), 'ltr');
            await terminal.getByRole('button', { name: texts['term.toggleTerminalInput'], exact: true }).click();
            const drawer = terminal.locator('.terminal-input');
            assert.equal(await drawer.evaluate(n => getComputedStyle(n).direction), 'ltr');
            const payload = 'שלום العربية فارسی /tmp/a-b.txt';
            await drawer.fill(`printf %s '${payload}' > '${home}/rtl-${code}.txt'`); await drawer.press('Enter');
            for (let attempt = 0; ; attempt++) {
                if (await readFile(`${home}/rtl-${code}.txt`, 'utf8').catch(() => '') === payload) break;
                assert.ok(attempt < 100, 'terminal executed exact mixed-script command');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            await terminal.getByRole('button', { name: texts['term.toggleTerminalInput'], exact: true }).click();
            await view.screenshot({ path: `test-results/i18n-${code}-workspace.png` });
            const cookie = (await localized.cookies()).find(c => c.name.startsWith('tuxee_language_'));
            await view.evaluate(name => { document.cookie = `${name}=en; Path=/; SameSite=Strict`; }, cookie.name);
            await view.reload(); await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).waitFor();
            assert.equal(await view.locator('html').getAttribute('dir'), 'rtl', 'session freezes direction too');
        }
        for (const width of [1440, 390, 320]) {
            await view.setViewportSize({ width, height: width === 1440 ? 900 : 740 });
            const tab = view.locator('.workspace-tab.active');
            await tab.waitFor();
            assert.equal(await tab.textContent(), tabName);
            assert.ok(await tab.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${code}: ${tabName} must fit the ${width}px workspace tab`);
            for (const action of ['Settings', 'RefreshCw']) {
                await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).click();
                await view.locator(`.account-menu [data-action="${action}"]`).click();
                await view.locator('dialog[open]').waitFor(); await bounds();
                assert.ok(!(await view.locator('dialog[open]').innerText()).includes('[!'));
                if (action === 'RefreshCw' && width === 320) await view.screenshot({ path: `test-results/i18n-${code}-dialog-mobile.png` });
                await view.getByRole('button', { name: texts['ui.closeDialog'], exact: true }).click();
            }
        }
        await view.getByRole('button', { name: texts['app.userMenu'], exact: true }).click();
        await view.locator('.account-menu [data-action="LogOut"]').click();
        await view.locator('[name=language]').waitFor();
        await localized.close();
        console.log(`i18n: ${code} login, session and desktop/mobile dialogs passed.`);
    }
    assert.deepEqual(errors, []);
    console.log('i18n: formatter, real login/PTY, cookie persistence, frozen sessions, Czech action IDs, worker errors, terminal language inheritance and mobile login passed.');
} finally {
    await browser?.close();
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 8000);
    await stopped; clearTimeout(timeout);
    run('userdel', [user]);
    await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
