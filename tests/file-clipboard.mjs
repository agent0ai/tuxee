import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed`);
    return result.stdout.trim();
};
const home = await mkdtemp('/tmp/tuxee-clipboard-user-'), state = await mkdtemp('/tmp/tuxee-clipboard-server-');
const user = `tuxee-clip-${process.pid}`, password = randomBytes(24).toString('base64url');
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
const uid = Number(fields[2]), gid = Number(fields[3]);
await chown(home, uid, gid); run('chpasswd', [], `${user}:${password}\n`);
const src = home + '/source', dst = home + '/destination', other = home + '/other';
for (const path of [src, dst, other, src + '/folder']) { await mkdir(path); await chown(path, uid, gid); }
const names = ['alpha.txt', "it's a file.txt", 'a-move.txt', 'b-conflict.txt', 'c-tail.txt'];
const put = async (path, text = path) => { await writeFile(path, text); await chown(path, uid, gid); };
for (const name of names) await put(src + '/' + name, name);
await put(src + '/folder/nested.txt', 'nested'); await symlink('../alpha.txt', src + '/folder/link');
await put(dst + '/b-conflict.txt', 'keep existing');
await chmod(state, 0o755); await copyFile('bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, page;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) {
    let error;
    for (let i = 0; i < 150; i++) { try { await check(); return; } catch (value) { error = value; await pause(40); } }
    throw error;
}
const quote = path => `'${path.replaceAll("'", "'\\''")}'`;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP tuxee-clipboard.test 127.0.0.1'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const meResponse = await context.request.get(base + '/api/me');
    assert.equal(meResponse.status(), 200, meResponse.ok() ? '' : await meResponse.text());
    const me = await meResponse.json();
    const settings = { ...me.settings, current: 'clipboard', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 5 }, workspaces: [
        { id: 'clipboard', name: 'Clipboard', columns: 4, rows: 2, active: 'source', panels: [
            { id: 'source', kind: 'files', path: src, x: 0, y: 0, w: 2, h: 1 },
            { id: 'destination', kind: 'files', path: dst, x: 0, y: 1, w: 2, h: 1 },
            { id: 'terminal', kind: 'terminal', path: src, x: 2, y: 0, w: 2, h: 2 },
        ] },
        { id: 'other', name: 'Other', columns: 4, rows: 2, active: 'other-files', panels: [
            { id: 'other-files', kind: 'files', path: other, x: 0, y: 0, w: 2, h: 2 },
        ] },
    ] };
    const response = await context.request.put(base + '/api/settings', { data: settings, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    assert.equal(response.status(), 200, await response.text());
    page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (request.url() === base + '/api/files' && ['copy', 'move'].includes(request.postDataJSON()?.operation)) mutations.push(request.postDataJSON());
    });
    await page.goto(base);
    const source = page.locator('[data-panel=source]'), destination = page.locator('[data-panel=destination]');
    const row = (view, name) => view.locator('.file-entry').filter({ has: page.locator('.file-name > span', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
    const ready = () => source.locator('.file-list:not(.loading)').waitFor();
    const select = async names => { for (const [index, name] of names.entries()) await row(source, name).click({ modifiers: index ? ['Control'] : [] }); };
    const paste = async view => { await view.locator('.file-list').focus(); await page.keyboard.press('Control+V'); };
    const payload = () => page.evaluate(async () => {
        const item = (await navigator.clipboard.read())[0], html = await (await item.getType('text/html')).text();
        const template = document.createElement('template'); template.innerHTML = html;
        return { text: await (await item.getType('text/plain')).text(), data: JSON.parse(template.content.querySelector('[data-tuxee-files]').dataset.tuxeeFiles) };
    });
    const writePayload = value => page.evaluate(async ({ text, data }) => {
        const node = document.createElement('span'); node.dataset.tuxeeFiles = JSON.stringify(data); node.textContent = text;
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([node.outerHTML], { type: 'text/html' }) })]);
    }, value);
    await ready(); await select(['alpha.txt', "it's a file.txt"]); await page.keyboard.press('Control+C');
    const copied = await payload();
    assert.equal(copied.text, [src + '/alpha.txt', src + "/it's a file.txt"].map(quote).join(' ') + ' ');
    assert.equal(copied.data.action, 'copy'); assert.equal(copied.data.uid, uid); assert.equal(copied.data.origin, base);
    assert.equal(mutations.length, 0, 'copy must only write clipboard data');
    await paste(destination);
    await eventually(async () => assert.equal(await readFile(dst + "/it's a file.txt", 'utf8'), "it's a file.txt"));
    await ready(); await paste(source);
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy).txt', 'utf8'), 'alpha.txt'));
    await ready(); await paste(source);
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 2).txt', 'utf8'), 'alpha.txt'));
    console.log('PASS real keyboard clipboard, shell quoting, multi-file copy, repeated same-folder duplication and original preservation');

    const terminal = page.locator('[data-panel=terminal] .terminal-view'); await terminal.locator(':scope[data-state=connected]').waitFor();
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.insertText("printf '%s\\n' "); await page.keyboard.press('Shift+Insert');
    await page.keyboard.insertText('> ' + quote(home + '/arguments')); await page.keyboard.press('Enter');
    await eventually(async () => assert.equal(await readFile(home + '/arguments', 'utf8'), copied.data.paths.join('\n') + '\n'));
    console.log('PASS real PTY receives only shell-quoted paths and executes with the exact filename arguments');

    await select(['folder']); await row(source, 'folder').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await destination.getByRole('button', { name: 'File actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).last().click();
    await eventually(async () => assert.equal(await readFile(dst + '/folder/nested.txt', 'utf8'), 'nested'));
    assert.equal(await readlink(dst + '/folder/link'), '../alpha.txt');
    console.log('PASS menu copy/paste shares keyboard metadata and copies directories with symlinks');

    await ready(); await select(['a-move.txt', 'b-conflict.txt', 'c-tail.txt']); await page.keyboard.press('Control+X');
    const cut = await payload(); assert.equal(cut.data.action, 'cut');
    assert.equal(await source.locator('.file-cut').count(), 3);
    await paste(destination);
    await destination.locator('.transfer.failed').last().waitFor();
    assert.equal(await readFile(dst + '/a-move.txt', 'utf8'), 'a-move.txt');
    await assert.rejects(readFile(src + '/a-move.txt'), { code: 'ENOENT' });
    assert.equal(await readFile(dst + '/b-conflict.txt', 'utf8'), 'keep existing');
    assert.equal(await readFile(src + '/c-tail.txt', 'utf8'), 'c-tail.txt');
    await eventually(async () => assert.equal(await source.locator('.file-cut').count(), 2));
    await rm(dst + '/b-conflict.txt'); await paste(destination);
    await eventually(async () => assert.equal(await readFile(dst + '/c-tail.txt', 'utf8'), 'c-tail.txt'));
    await eventually(async () => assert.equal(await source.locator('.file-cut').count(), 0));
    await put(src + '/a-move.txt', 'new file at old path');
    const beforeConsumed = mutations.length; await paste(destination);
    await page.getByText('This cut has ended. Cut the files again.', { exact: true }).last().waitFor();
    assert.equal(mutations.length, beforeConsumed); assert.equal(await readFile(src + '/a-move.txt', 'utf8'), 'new file at old path');
    console.log('PASS partial cut failure, collision preservation, retry of remaining items and consumed-cut protection');

    await ready(); await select(['alpha.txt']); await page.keyboard.press('Control+X'); await page.keyboard.press('Control+C');
    assert.equal((await payload()).data.action, 'copy'); assert.equal(await source.locator('.file-cut').count(), 0);
    await paste(source); await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 3).txt', 'utf8'), 'alpha.txt'));
    await ready(); await select(['alpha.txt']); await page.keyboard.press('Control+X'); await page.keyboard.press('Escape');
    const beforeExpired = mutations.length; await paste(destination); await pause(200); assert.equal(mutations.length, beforeExpired);
    const nativePath = source.getByRole('textbox', { name: 'File or directory path' });
    await nativePath.fill("'/var'"); await nativePath.press('Control+A'); await nativePath.press('Control+C'); await nativePath.press('Escape');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "'/var'");
    await paste(destination); await pause(200); assert.equal(mutations.length, beforeExpired);
    assert.equal(await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes('text/html')), false);
    console.log('PASS explicit copy supersedes cut, Escape cancels cut and ordinary path text never starts a file operation');

    await select(['alpha.txt']); await page.keyboard.press('Control+C'); const valid = await payload();
    for (const value of [
        { ...valid, data: { ...valid.data, origin: 'https://another-server.invalid' } },
        { ...valid, data: { ...valid.data, uid: uid + 1 } },
        { ...valid, data: { ...valid.data, paths: ['/var/../etc'] } },
        { ...valid, text: quote('/var') + ' ' },
        { ...valid, data: { ...valid.data, action: 'cut' } },
    ]) {
        await writePayload(value); await paste(destination); await pause(100); assert.equal(mutations.length, beforeExpired);
    }
    console.log('PASS foreign server/account, invalid paths, changed text and forged cut records rejected');

    await writePayload(valid);
    await page.getByRole('button', { name: 'Other', exact: true }).click();
    await paste(page.locator('[data-panel=other-files]'));
    await eventually(async () => assert.equal(await readFile(other + '/alpha.txt', 'utf8'), 'alpha.txt'));
    await page.getByRole('button', { name: 'Clipboard', exact: true }).click(); await ready();
    await select(['alpha.txt']); await page.keyboard.press('Control+X'); await page.reload(); await ready();
    const beforeReload = mutations.length; await paste(destination); await pause(200); assert.equal(mutations.length, beforeReload);
    await select(['alpha.txt']); await page.keyboard.press('Control+C'); await page.reload(); await ready();
    await paste(source); await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 4).txt', 'utf8'), 'alpha.txt'));
    console.log('PASS clipboard works across workspaces; reload preserves copy but invalidates pending cut');

    await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
        canvas.getContext('2d').fillRect(0, 0, 4, 4);
        const png = await new Promise(resolve => canvas.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    });
    await paste(destination); await eventually(async () => assert.ok((await readFile(dst + '/clipboard-image.png')).length));
    await put(src + '/tab.txt', 'tab copy');
    await source.getByRole('button', { name: 'Refresh files', exact: true }).click(); await ready();
    await select(['tab.txt']); await page.keyboard.press('Control+C');
    const tab = await context.newPage(); await tab.goto(base);
    await tab.locator('[data-panel=destination] .file-list:not(.loading)').waitFor();
    await tab.locator('[data-panel=destination] .file-list').focus(); await tab.keyboard.press('Control+V');
    await eventually(async () => assert.equal(await readFile(dst + '/tab.txt', 'utf8'), 'tab copy'));
    await page.bringToFront(); await select(['tab.txt']); await page.keyboard.press('Control+X');
    await tab.bringToFront(); await tab.locator('[data-panel=destination] .file-list').focus(); await tab.keyboard.press('Control+V');
    await tab.getByText('This cut has ended. Cut the files again.', { exact: true }).waitFor();
    assert.equal(await readFile(src + '/tab.txt', 'utf8'), 'tab copy');
    await tab.close(); await page.bringToFront();
    await source.locator('.file-list').focus(); await page.keyboard.press('Escape');
    console.log('PASS copy between browser tabs and rejection of cuts outside their originating page');

    await put(src + '/cancel.txt', 'cancelled move');
    await source.getByRole('button', { name: 'Refresh files', exact: true }).click(); await ready();
    let heldRoute, release;
    const blocked = new Promise(resolve => release = resolve);
    await page.route('**/api/files', async route => {
        const data = route.request().postDataJSON();
        if (data.operation === 'move' && data.path === src + '/cancel.txt') { heldRoute = route; release(); }
        else await route.continue();
    });
    await select(['cancel.txt']); await page.keyboard.press('Control+X');
    await paste(destination); await blocked;
    const inFlight = mutations.length; await paste(destination);
    await page.getByText('These files are already being moved', { exact: true }).waitFor();
    assert.equal(mutations.length, inFlight);
    await destination.locator('.transfer').last().getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    await heldRoute.abort().catch(() => {}); await page.unroute('**/api/files');
    await eventually(async () => assert.equal(await source.locator('.file-cut').count(), 0));
    await paste(destination); await pause(200); assert.equal(mutations.length, inFlight);
    assert.equal(await readFile(src + '/cancel.txt', 'utf8'), 'cancelled move');
    console.log('PASS concurrent cut paste is blocked; cancellation consumes the uncertain in-flight item without replay');

    await select(['tab.txt']); await page.keyboard.press('Control+X');
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill(user);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await ready();
    const loggedInAgain = mutations.length; await paste(destination); await pause(200); assert.equal(mutations.length, loggedInAgain);
    console.log('PASS explicit logout clears pending cuts across a new login');

    await mkdir('test-results', { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.compact-board').waitFor();
    await page.locator('[data-component-name=source]').click();
    await row(source, 'alpha.txt').getByRole('checkbox').check();
    await source.getByRole('button', { name: 'File actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await source.getByRole('button', { name: 'File actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 5).txt', 'utf8'), 'alpha.txt'));
    await ready(); await row(source, 'alpha.txt').getByRole('checkbox').focus();
    await page.keyboard.press('Control+C'); await page.keyboard.press('Control+V');
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 6).txt', 'utf8'), 'alpha.txt'));
    await source.getByRole('button', { name: 'File actions', exact: true }).click();
    await page.screenshot({ path: 'test-results/file-clipboard-mobile.png' });
    assert.deepEqual(errors, []);
    console.log('PASS native image paste still uploads; compact menu copy/paste with checkbox selection');

    const insecure = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const http = await insecure.newPage(), httpBase = base.replace('127.0.0.1', 'tuxee-clipboard.test');
    await http.goto(httpBase);
    assert.equal(await http.evaluate(() => isSecureContext), false);
    assert.equal(await http.evaluate(() => !!navigator.clipboard), false);
    await http.getByRole('textbox', { name: 'Username', exact: true }).fill(user);
    await http.getByLabel('Password', { exact: true }).fill(password);
    await http.getByRole('button', { name: 'Sign in', exact: true }).click();
    const httpSource = http.locator('[data-panel=source]');
    await httpSource.locator('.file-entry').filter({ has: http.locator('.file-name > span', { hasText: /^alpha\.txt$/ }) }).click();
    await http.keyboard.press('Control+C'); await http.keyboard.press('Control+V');
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 7).txt', 'utf8'), 'alpha.txt'));
    await httpSource.getByRole('button', { name: 'File actions', exact: true }).click();
    await http.getByRole('menuitem', { name: 'Copy', exact: true }).last().click();
    await httpSource.locator('.file-list').focus(); await http.keyboard.press('Control+V');
    await eventually(async () => assert.equal(await readFile(src + '/alpha (copy 8).txt', 'utf8'), 'alpha.txt'));
    await httpSource.getByRole('button', { name: 'File actions', exact: true }).click();
    await http.getByRole('menuitem', { name: 'Paste', exact: true }).last().click();
    await http.getByText('Use Ctrl+V or ⌘V to paste', { exact: true }).waitFor();
    console.log('PASS actual insecure HTTP keyboard/menu copy and keyboard paste without clipboard permissions');
    await insecure.close();
    assert.ok(!(await readdir(src)).some(name => name.startsWith('.tuxee-')));
} catch (error) {
    if (page) { await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/file-clipboard-failure.png' }).catch(() => {}); }
    throw error;
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
