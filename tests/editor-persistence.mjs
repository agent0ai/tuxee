import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const run = (cmd, args, input) => { const r = spawnSync(cmd, args, { encoding: 'utf8', input }); assert.equal(r.status, 0, `${cmd}: ${r.stderr}`); return r.stdout.trim(); };
const home = await mkdtemp('/tmp/tuxee-editor-user-'), user = `tuxee-editor-${process.pid}`;
const password = randomBytes(24).toString('base64url');
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':'), uid = Number(fields[2]), gid = Number(fields[3]);
await chown(home, uid, gid); run('chpasswd', [], `${user}:${password}\n`);
const file = home + '/paged.txt', original = 'line🙂\r\n'.repeat(22000);
await writeFile(file, original); await chown(file, uid, gid);
const small = home + '/small.txt'; await writeFile(small, ''); await chown(small, uid, gid);
const state = await mkdtemp('/tmp/tuxee-editor-server-'); await chmod(state, 0o755);
await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
let server, stopped, browser, base;
const start = async () => {
 server = spawn(state + '/tuxee', ['serve', '--http', '--bind', base ? new URL(base).host : '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
 stopped = new Promise(resolve => server.once('exit', resolve));
 base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('startup timed out')), 10000);
  server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
 });
};
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('condition timed out'); };
try {
 await start(); browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
 const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
 let csrf;
 const login = async () => { const r = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } }); assert.equal(r.status(), 200); csrf = (await r.json()).csrf; };
 await login();
 const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
 const editor = async (operation, data = {}) => { const r = await api('/files', 'POST', { operation: 'editor-' + operation, editorId: 'files', ...data }); assert.equal(r.status(), 200, await r.text()); return r.json(); };
 const settings = { howToSeen: true, theme: 'dark', current: 'editor', workspaces: [{ id: 'editor', name: 'Editor', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] }] };
 assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
 const page = await appPage(context), errors = [], checkpoints = [];
 page.setDefaultTimeout(10000);
 page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
 page.on('response', async response => { if (response.url().endsWith('/api/files') && response.status() >= 400) console.error(response.request().postDataJSON()?.operation, response.status(), await response.text().catch(() => '')); });
 page.on('request', request => { if (request.url().endsWith('/api/files') && request.postDataJSON()?.operation === 'editor-checkpoint') checkpoints.push(request.postDataJSON()); });
 page.on('dialog', dialog => dialog.accept());
 await page.goto(base);
 const path = page.getByRole('textbox', { name: 'File or directory path', exact: true });
 const content = page.locator('.cm-content');
 const ready = () => page.locator('.inspector-body[aria-busy="false"] .cm-content').waitFor();
 const open = async name => { await path.fill(name); await path.press('Enter'); await ready(); };
 const replace = async text => { await content.click(); await page.keyboard.press('Control+a'); if (text) await page.keyboard.insertText(text); else await page.keyboard.press('Backspace'); };
 const save = async () => { await page.getByRole('button', { name: 'Save file', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="Save file"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false'); };
 await page.locator('.file-entry').first().waitFor(); await open(file);
 await until(async () => (await editor('load')).editor?.path === file);
 // Continuous edits postpone checkpoints until one second after the last edit.
 await replace('first'); const before = checkpoints.length;
 for (let i = 0; i < 4; i++) { await page.waitForTimeout(350); await page.keyboard.insertText('x'); }
 assert.equal(checkpoints.length, before, 'checkpoint ran while continuously editing');
 await until(async () => (await editor('load')).editor.edits.length === 1);
 assert.equal(await readFile(file, 'utf8'), original, 'checkpoint changed source');
 const first = await editor('read', { offset: 0 });
 assert.equal(first.content, 'firstxxxx');
 await page.getByRole('button', { name: 'Page down', exact: true }).click(); await ready();
 assert.equal(await page.locator('.inspector-page').textContent(), 'Page 2');
 await replace('second\n界');
 // Navigation flushes immediately, regardless of the debounce delay.
 await page.getByRole('button', { name: 'Page down', exact: true }).click(); await ready();
 assert.equal(await page.locator('.inspector-page').textContent(), 'Page 3');
 const loaded = (await editor('load')).editor;
 assert.equal(loaded.edits.length, 2); assert.equal(await readFile(file, 'utf8'), original);
 await page.getByRole('button', { name: 'Page up', exact: true }).click(); await ready();
 assert.equal(await content.textContent(), 'second界');
 await until(async () => (await editor('load')).editor.index === 1);
 const instance = (await readFile(state + '/state/instance-id', 'utf8')).trim();
 const hash = text => createHash('sha256').update(text).digest('hex');
 const folder = `${home}/.local/state/tuxee/editors/${hash(instance)}/${hash('files')}`;
 assert.equal((await stat(folder + '/session.json')).uid, uid); assert.equal((await stat(folder + '/session.json')).mode & 0o777, 0o600);
 await page.reload(); await ready();
 assert.equal(await path.inputValue(), file); assert.equal(await page.locator('.inspector-page').textContent(), 'Page 2');
 assert.equal(await content.textContent(), 'second界');
 await writeFile(file, 'external change of a completely different length');
 await save();
 const bytes = Buffer.from(original);
 const expected = 'firstxxxxsecond\r\n界' + bytes.subarray(loaded.edits[1].page.end).toString();
 assert.equal(await readFile(file, 'utf8'), expected, 'Save did not commit every page using last-save-wins');
 assert.deepEqual((await readdir(folder)).sort(), ['session.json']);
 // Re-edit the shortened current page, then flush through logout and restore after restart.
 await replace('pending restart');
 await page.getByRole('button', { name: 'User menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
 await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
 await page.goto('about:blank'); server.kill('SIGKILL'); await stopped; await start(); await login();
 await page.goto(base); await ready(); assert.equal(await content.textContent(), 'pending restart');
 assert.equal(await path.inputValue(), file);
 // A fresh browser reads the most recent checkpoint; subsequent checkpoints need no revision.
 const mobile = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 } });
 const other = await appPage(mobile); await other.goto(base); await other.locator('.cm-content').waitFor();
 assert.equal(await other.locator('.cm-content').textContent(), 'pending restart');
 await other.locator('.cm-content').click(); await other.keyboard.press('Control+a'); await other.keyboard.insertText('newer browser');
 await until(async () => (await editor('read', { offset: (await editor('load')).editor.positions[1].offset })).content === 'newer browser');
 await other.goto('about:blank'); await mobile.close();
 await page.reload(); await ready(); assert.equal(await content.textContent(), 'newer browser');
 // Explicit discard closes the editor without changing the file.
 await page.getByRole('button', { name: 'Back to files', exact: true }).click(); await page.getByRole('button', { name: 'Discard', exact: true }).click();
 await page.locator('.file-inspector').waitFor({ state: 'detached' }); assert.equal((await editor('load')).editor, undefined);
 assert.equal(await readFile(file, 'utf8'), expected);
 // Saving a deleted page must allow navigation into the following bytes at the same offset.
 await writeFile(file, original); await open(file);
 const removed = await editor('read', { offset: 0 });
 await replace(''); await save();
 assert.equal(await readFile(file, 'utf8'), bytes.subarray(removed.page.end).toString());
 await page.getByRole('button', { name: 'Page down', exact: true }).click(); await ready();
 assert.equal(await page.locator('.inspector-page').textContent(), 'Page 1');
 assert.ok((await content.textContent()).startsWith('line🙂'));
 await page.getByRole('button', { name: 'Page down', exact: true }).click(); await ready();
 assert.equal(await page.locator('.inspector-page').textContent(), 'Page 2');
 await page.getByRole('button', { name: 'Back to files', exact: true }).click();
 await page.locator('.file-inspector').waitFor({ state: 'detached' });
 await open(small); await replace('empty-file draft'); await until(async () => (await editor('load')).editor.edits.length === 1);
 await page.reload(); await ready(); assert.equal(await content.textContent(), 'empty-file draft');
 assert.ok(await page.getByRole('button', { name: 'Save file', exact: true }).isEnabled()); await save();
 assert.equal(await readFile(small, 'utf8'), 'empty-file draft');
 await replace('orphan'); await until(async () => (await editor('load')).editor.edits.length === 1);
 await page.goto('about:blank');
 settings.workspaces[0].panels = []; settings.workspaces[0].active = '';
 assert.equal((await api('/settings', 'PUT', settings)).status(), 200);
 await assert.rejects(stat(folder), { code: 'ENOENT' });
 assert.equal((await api('/files', 'POST', { operation: 'editor-checkpoint', editorId: 'files' })).status(), 404, 'late writes resurrected a closed panel');
 const denied = await context.request.post(base + '/api/files', { data: { operation: 'editor-load', editorId: 'files' }, headers: { 'X-Tuxee-CSRF': 'wrong', 'X-Tuxee-Client': 'web' } }); assert.equal(denied.status(), 403);
 assert.deepEqual(errors, []);
 console.log('PASS editor debounce, multi-page drafts, reload, last-save-wins, logout, server crash, mobile restoration, discard and orphan cleanup');
} finally {
 await browser?.close(); if (server?.exitCode === null) { server.kill('SIGTERM'); await stopped; }
 run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
