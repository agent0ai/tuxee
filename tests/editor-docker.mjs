import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const container = process.env.TUXEE_TEST_CONTAINER, base = process.env.TUXEE_TEST_URL;
assert.match(container || '', /^tuxee-editor-(test|preview)-/, 'use a disposable editor test container');
assert.ok(base, 'provide its forwarded HTTP URL');
const run = (args, input) => {
    const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60000, maxBuffer: 4 << 20 });
    assert.equal(result.status, 0, `docker ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
};
const exec = (...args) => run(['exec', container, ...args]);
const put = (path, content) => run(['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'sh', path], content);
const hash = content => createHash('sha256').update(content).digest('hex');
const diskHash = path => exec('sha256sum', path).split(' ')[0];
const patchedHash = (original, edits) => {
    const digest = createHash('sha256'); let offset = 0;
    for (const edit of [...edits].sort((a, b) => a.page.offset - b.page.offset)) {
        digest.update(original.subarray(offset, edit.page.offset)); digest.update(edit.content); offset = edit.page.end;
    }
    return digest.update(original.subarray(offset)).digest('hex');
};
const until = async (check, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw Error(label);
};
const user = `tuxee-edit-docker-${process.pid}`, home = `/home/${user}`, file = `${home}/large.txt`;
const password = randomBytes(24).toString('base64url'), errors = [], pageTimes = [], report = {};
const row = 'row-é-🙂\t' + 'x'.repeat(1000) + '\r\n' + 'mixed-ending\n';
const original = Buffer.from(row.repeat(Math.ceil((64 << 20) / Buffer.byteLength(row))) + 'EOF🙂');
const originalHash = hash(original), edits = [];
let browser, context, page, csrf, created = false;
const api = async (path, method = 'GET', data, status = 200) => {
    const response = await context.request.fetch(base + '/api' + path, { method, data, timeout: 30000,
        headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': csrf || '' } });
    try { assert.equal(response.status(), status, `${path}: ${response.status() === status ? '' : await response.text()}`); return await response.json(); }
    finally { await response.dispose(); }
};
const editor = (operation, data = {}, id = 'files', status = 200) => api('/files', 'POST', { operation: 'editor-' + operation, editorId: id, ...data }, status);
const login = async () => {
    await until(async () => { try { const r = await context.request.get(base + '/health', { timeout: 1000 }); const ok = r.ok(); await r.dispose(); return ok; } catch { return false; } }, 'server readiness');
    csrf = (await api('/login', 'POST', { username: user, password, language: 'en' })).csrf;
};
const settings = { howToSeen: true, theme: 'dark', current: 'large', workspaces: [
    { id: 'large', name: 'Large file', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] },
    { id: 'row-workspace', name: 'Rows', columns: 4, rows: 2, active: 'rows', panels: [{ id: 'rows', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] },
] };
try {
    exec('useradd', '-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', user); created = true;
    run(['exec', '-i', container, 'chpasswd'], `${user}:${password}\n`);
    put(file, original); exec('chown', user + ':' + user, file); exec('chmod', '640', file);
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await login(); await api('/settings', 'PUT', settings);
    page = await appPage(context); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const content = page.locator('.cm-content'), ready = () => page.locator('.inspector-body[aria-busy="false"] .cm-content').waitFor();
    const readResponse = () => page.waitForResponse(r => r.url().endsWith('/api/files') && r.request().postDataJSON()?.operation === 'editor-read');
    const replace = async text => {
        await content.click(); await page.keyboard.press('Control+a');
        if (text) await page.keyboard.insertText(text); else await page.keyboard.press('Backspace');
    };
    const saved = async () => {
        const response = page.waitForResponse(r => r.url().endsWith('/api/files') && r.request().postDataJSON()?.operation === 'editor-save');
        const start = performance.now(); await page.getByRole('button', { name: 'Save file', exact: true }).click();
        assert.equal((await response).status(), 200); await ready();
        await until(() => page.getByRole('button', { name: 'Save file', exact: true }).isDisabled(), 'save completion');
        return performance.now() - start;
    };
    await page.goto(base); await page.locator('.file-entry').first().waitFor();
    let reading = readResponse();
    await page.getByRole('textbox', { name: 'File or directory path', exact: true }).fill(file);
    await page.getByRole('textbox', { name: 'File or directory path', exact: true }).press('Enter');
    let value = await (await reading).json(); await ready();
    const cdp = await context.newCDPSession(page);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
    const heapBefore = await heap();
    let pages = 0, offset = 0;
    while (true) {
        assert.equal(value.page.offset, offset); assert.ok(value.page.end > offset);
        assert.ok(value.page.end - offset <= 1 << 20); assert.ok(value.page.lineBreaks < 10000);
        assert.equal(hash(value.content), hash(original.subarray(offset, value.page.end)), `page ${pages + 1} bytes`);
        const replacement = pages === 0 ? 'first🙂' : pages === 1 ? 'R'.repeat(500000) + '界'.repeat(120000)
            : pages === 31 ? '' : value.page.end === value.page.total ? 'last🙂' : undefined;
        if (replacement !== undefined) { await replace(replacement); edits.push({ page: value.page, content: replacement }); }
        pages++; offset = value.page.end;
        if (offset === value.page.total) break;
        reading = readResponse(); const start = performance.now();
        await page.getByRole('button', { name: 'Page down', exact: true }).click();
        value = await (await reading).json(); await ready(); pageTimes.push(performance.now() - start);
        if (pages % 16 === 0) console.log(`PASS paged through ${pages} MiB-sized pages with disk-only edits`);
    }
    assert.ok(pages >= 64); assert.equal(offset, original.length);
    await until(async () => (await editor('load')).editor.edits.length === edits.length, 'final checkpoint');
    assert.equal(diskHash(file), originalHash, 'paging changed the source');
    const heapAfter = await heap();
    assert.ok(heapAfter - heapBefore < 32 << 20, `editor retained ${heapAfter - heapBefore} bytes across page changes`);
    Object.assign(report, { fileBytes: original.length, pages, editedPages: edits.length, heapBefore, heapAfter,
        pageMedianMs: [...pageTimes].sort((a, b) => a - b)[Math.floor(pageTimes.length / 2)], pageMaxMs: Math.max(...pageTimes) });
    const instance = exec('cat', '/var/lib/tuxee/instance-id'), folder = `${home}/.local/state/tuxee/editors/${hash(instance)}/${hash('files')}`;
    assert.equal(exec('stat', '-c', '%a', folder), '700'); assert.equal(exec('stat', '-c', '%U:%a', folder + '/session.json'), user + ':600');
    assert.equal(exec('stat', '-c', '%s', folder + '/base'), String(original.length));
    assert.ok(Number(exec('stat', '-c', '%s', folder + '/session.json')) < 65536);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/editor-docker-desktop.png' });
    await page.goto('about:blank');
    const serverPID = () => exec('pgrep', '-o', '-x', 'tuxee');
    for (const mode of ['reexec', 'server-kill', 'container-restart', 'container-kill']) {
        const pid = serverPID(), start = performance.now();
        if (mode === 'reexec') exec('tuxee', 'restart');
        else if (mode === 'server-kill') { exec('kill', '-KILL', pid); await until(() => { try { return serverPID() !== pid; } catch { return false; } }, 'supervisor restart'); }
        else if (mode === 'container-restart') run(['restart', '-t', '10', container]);
        else { run(['kill', container]); run(['start', container]); }
        await until(async () => { try { await api('/me', 'GET', undefined, 401); return true; } catch { return false; } }, 'old login revocation');
        await login(); await page.goto(base); await ready();
        assert.equal(await content.textContent(), 'last🙂', mode + ' restored draft');
        assert.equal(await page.locator('.inspector-page').textContent(), `Page ${pages}`);
        assert.equal((await editor('load')).editor.edits.length, edits.length); assert.equal(diskHash(file), originalHash);
        if (mode === 'reexec') assert.equal(serverPID(), pid);
        report[mode + 'Ms'] = performance.now() - start;
        await page.goto('about:blank'); console.log('PASS ' + mode + ' restores large-file drafts without writing the source');
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base); await ready();
    assert.equal(await content.textContent(), 'last🙂');
    await page.screenshot({ path: 'test-results/editor-docker-mobile.png' });
    await replace('logout🙂'); edits.at(-1).content = 'logout🙂';
    await page.getByRole('button', { name: 'User menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor(); await page.goto('about:blank'); await login();
    let state = (await editor('load')).editor; state.index = 0; state.anchor = state.head = 0; state.top = state.left = 0;
    await editor('checkpoint', { editor: state });
    await page.setViewportSize({ width: 1440, height: 950 }); await page.goto(base); await ready();
    assert.equal(await content.textContent(), 'first🙂');
    exec('chmod', '440', file);
    await editor('save', {}, 'files', 400); assert.equal(diskHash(file), originalHash);
    assert.equal((await editor('load')).editor.edits.length, edits.length);
    exec('chmod', '640', file); put(file, 'external replacement');
    report.saveMs = await saved();
    assert.equal(diskHash(file), patchedHash(original, edits), 'first multi-page Save lost bytes');
    assert.equal(exec('stat', '-c', '%U:%a', file), user + ':640');
    assert.equal(exec('ls', '-A', folder), 'session.json');
    // Repeated saves must keep a shortened first page separate from later replacements.
    await replace('grown🙂' + 'g'.repeat(300000)); edits[0].content = 'grown🙂' + 'g'.repeat(300000);
    await saved(); assert.equal(diskHash(file), patchedHash(original, edits));
    await replace(''); edits[0].content = ''; await saved(); assert.equal(diskHash(file), patchedHash(original, edits));
    await page.getByRole('button', { name: 'Page down', exact: true }).click(); await ready();
    assert.equal(await page.locator('.inspector-page').textContent(), 'Page 1');
    assert.ok((await content.textContent()).startsWith('RRRR'));
    await page.goto('about:blank');
    console.log('PASS large multi-page saves, permission-failure preservation, last-save-wins, repeated growth/deletion and logout flushing');

    const shortPath = `${home}/rows.txt`, short = Buffer.from('short🙂\r\nrow-é\n'.repeat(150000)), rowEdits = [], positions = [];
    put(shortPath, short); exec('chown', user + ':' + user, shortPath);
    state = (await editor('open', { path: shortPath }, 'rows')).editor;
    let line = 1; offset = 0;
    while (offset < short.length) {
        value = await editor('read', { offset }, 'rows');
        assert.equal(hash(value.content), hash(short.subarray(offset, value.page.end)));
        assert.ok(value.page.lineBreaks < 10000); assert.ok(value.page.end - offset < 1 << 20);
        positions.push({ offset, line });
        if (positions.length === 1 || positions.length === 15 || value.page.end === short.length)
            rowEdits.push({ page: value.page, content: `replacement-${positions.length}🙂\r\n`, index: positions.length - 1 });
        offset = value.page.end; line += value.page.lineBreaks;
    }
    assert.ok(positions.length > 30); state.positions = positions;
    for (const edit of rowEdits) {
        state.index = edit.index; state = (await editor('checkpoint', { editor: state, page: edit.page, content: edit.content }, 'rows')).editor;
    }
    assert.equal(diskHash(shortPath), hash(short)); await editor('save', {}, 'rows');
    assert.equal(diskHash(shortPath), patchedHash(short, rowEdits)); report.rowLimitedPages = positions.length;
    console.log('PASS 300,000-row fixture with exact UTF-8/mixed-ending bytes and edits across row-limited pages');
    for (const ws of settings.workspaces) { ws.panels = []; ws.active = ''; }
    await api('/settings', 'PUT', settings);
    assert.equal(exec('find', `${home}/.local/state/tuxee/editors/${hash(instance)}`, '-mindepth', '1', '-maxdepth', '1'), '');
    await editor('checkpoint', {}, 'files', 404);
    assert.deepEqual(errors, []);
    report.serverHighWaterKiB = Number(exec('sh', '-c', 'awk \'/VmHWM:/{print $2}\' /proc/"$1"/status', 'sh', serverPID()));
    report.containerMemoryLimit = Number(run(['inspect', '-f', '{{.HostConfig.Memory}}', container]));
    await writeFile('test-results/editor-docker.json', JSON.stringify(report, null, 2) + '\n');
    console.log('PASS orphan cleanup, no browser errors; measurements:', report);
} finally {
    await browser?.close();
    if (created) { exec('userdel', user); exec('rm', '-rf', home); }
}
