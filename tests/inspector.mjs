import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod, symlink, copyFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-toolbar-');
await mkdir(dir + '/copies'); await writeFile(dir + '/alpha.txt', 'toolbar fixture');
await mkdir(dir + '/.hidden-folder'); await writeFile(dir + '/.hidden-folder/.nested', 'nested fixture');
await writeFile(dir + '/.hidden.txt', 'hidden fixture');
await writeFile(dir + '/copies/other.txt', 'other file');
await mkdir(dir + '/search-only'); await writeFile(dir + '/search-only/readable.txt', 'direct access'); await chmod(dir + '/search-only', 0o111);
await symlink('copies', dir + '/directory-link');
await symlink('alpha.txt', dir + '/file-link.txt');
await copyFile('assets/tuxee-logo-emblem-light.png', dir + '/image.png');
await copyFile('assets/tuxee-logo-emblem-light.png', dir + '/second.png');
assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
const state = await mkdtemp('/tmp/tuxee-toolbar-server-');
const server = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
const base = await new Promise((resolve, reject) => {
 const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
 server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
 server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const file = page.locator('.file-view'), path = page.getByRole('textbox', { name: 'File or directory path', exact: true });
const toolbar = file.locator('.inspector-toolbar'), content = file.locator('.cm-content');
const tool = name => toolbar.getByRole('button', { name, exact: true });
const tools = page.getByRole('dialog', { name: 'File tools', exact: true });
const requests = [];
page.on('request', request => { if (request.url() === base + '/api/files') requests.push(request.postDataJSON()); });
async function open(target) { await path.fill(target); await path.press('Enter'); }
async function back(parent = dir) {
 await tool('Back to files').click(); await file.locator('.file-inspector').waitFor({ state: 'detached' });
 assert.equal(await path.inputValue(), parent);
}
async function edited(text) { await content.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(text); }
try {
 assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'editor', workspaces: [{ id: 'editor', name: 'Editor', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 4, h: 2 }] }] })).status(), 200);
 await page.goto(base); await file.locator('.file-entry').first().waitFor();
 await open(dir + '/alpha.txt'); await content.waitFor();
 assert.equal(await path.inputValue(), dir + '/alpha.txt'); assert.equal(await path.getAttribute('title'), dir + '/alpha.txt');
 assert.equal(await file.locator('.inspector-title').count(), 0); assert.equal(await tool('Close file').count(), 0);
 assert.deepEqual(await toolbar.locator('button:visible').evaluateAll(nodes => nodes.map(node => node.title)), ['Back to files', 'Undo', 'Redo', 'Download file', 'Save file']);
 assert.ok(await toolbar.evaluate(node => node.children[1].textContent === '|' && node.children[2].title === 'Undo' && node.children[3].title === 'Redo' && node.children[4].getAttribute('aria-label') === 'Syntax'));
 assert.ok(await tool('Undo').isDisabled()); assert.ok(await tool('Redo').isDisabled());
 await content.click(); await page.keyboard.press('ArrowRight'); assert.ok(await tool('Undo').isDisabled(), 'selection is not a document undo');
 await edited(' changed'); assert.ok(await tool('Undo').isEnabled()); assert.ok(await tool('Redo').isDisabled());
 assert.ok(await page.locator('.file-modified').isVisible());
 await tool('Undo').click(); assert.ok(await tool('Undo').isDisabled()); assert.ok(await tool('Redo').isEnabled());
 assert.equal(await content.textContent(), 'toolbar fixture'); assert.ok(await tool('Save file').isDisabled());
 await tool('Redo').click(); assert.ok(await tool('Undo').isEnabled()); assert.ok(await tool('Redo').isDisabled());
 await tool('Save file').click(); await page.waitForFunction(() => document.querySelector('[aria-label="Save file"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');
 assert.equal(await readFile(dir + '/alpha.txt', 'utf8'), 'toolbar fixture changed');
 assert.equal(await page.locator('.file-modified').isVisible(), false);
 assert.ok(await tool('Undo').isEnabled(), 'save retains undo history');
 await content.click(); await page.keyboard.press('Control+z'); assert.ok(await tool('Redo').isEnabled());
 await page.keyboard.press('Control+Shift+z'); assert.ok(await tool('Redo').isDisabled());
 await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/inspector-editor-desktop.png' });
 await edited(' unsaved');
 await open(dir + '/copies/other.txt');
 await page.getByRole('dialog', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
 assert.equal(await path.inputValue(), dir + '/alpha.txt'); assert.match(await content.textContent(), /unsaved$/);
 await open(dir + '/missing'); await file.locator('..').getByText(/no such file/).waitFor();
 assert.match(await content.textContent(), /unsaved$/, 'failed navigation preserves draft');
 await path.press('Escape'); assert.equal(await path.inputValue(), dir + '/alpha.txt');
 await open(dir + '/copies/other.txt');
 await page.getByRole('dialog', { name: 'Discard changes?', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent === 'other file');
 assert.equal(await path.inputValue(), dir + '/copies/other.txt'); await back(dir + '/copies');
 await open(dir + '/search-only/readable.txt'); await content.waitFor();
 assert.equal(await content.textContent(), 'direct access');
 assert.ok(!requests.some(request => request.operation === 'list' && request.path === dir + '/search-only'), 'direct opening does not require a parent listing');
 await open(dir + '/search-only');
 await file.locator('..').locator('.toast').filter({ hasText: /permission denied/ }).waitFor();
 assert.equal(await content.textContent(), 'direct access', 'unreadable parent preserves the open file');
 assert.equal(await file.locator('.file-inspector').evaluate(node => node.inert), false, 'failed navigation restores interaction');
 await path.press('Escape'); assert.equal(await path.inputValue(), dir + '/search-only/readable.txt');
 await chmod(dir + '/search-only', 0o700); await back(dir + '/search-only');
 await open(dir + '/directory-link'); await file.locator('.file-entry').filter({ hasText: 'other.txt' }).waitFor();
 assert.equal(await path.inputValue(), dir + '/directory-link');
 await open(dir + '/file-link.txt'); await content.waitFor(); assert.equal(await content.textContent(), 'toolbar fixture changed');
 await open(dir); await file.locator('.file-inspector').waitFor({ state: 'detached' });
 await open(dir + '/.hidden.txt'); await content.waitFor(); assert.equal(await path.inputValue(), dir + '/.hidden.txt'); await back();
 console.log('PASS file title, toolbar order, true undo/redo availability, history after saving, unsaved/failed navigation, direct access without listing and symlinks');

 await open(dir + '/alpha.txt'); await content.waitFor();
 for (const width of [390, 320, 1440]) {
  await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(300);
  assert.ok(await path.isVisible(), 'path remains accessible in compact mode');
  assert.equal(await path.inputValue(), dir + '/alpha.txt');
  assert.ok(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  assert.ok(await toolbar.evaluate(node => [...node.querySelectorAll('button')].filter(node => node.checkVisibility()).every(node => Math.abs(node.getBoundingClientRect().top - node.parentElement.closest('.inspector-toolbar').querySelector('button').getBoundingClientRect().top) < 1)));
  if (width === 320) {
   await edited(' mobile'); await tool('Save file').click();
   await page.waitForFunction(() => document.querySelector('[aria-label="Save file"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');
   assert.equal(await readFile(dir + '/alpha.txt', 'utf8'), 'toolbar fixture changed mobile');
   await page.screenshot({ path: 'test-results/inspector-editor-mobile.png' });
  }
 }
 await file.locator('..').evaluate(node => node.style.width = '150px'); await page.waitForTimeout(200);
 await edited(' narrow'); await tool('File tools').click();
 await tools.getByRole('button', { name: 'Save file', exact: true }).click();
 await page.waitForFunction(() => document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');
 assert.equal(await readFile(dir + '/alpha.txt', 'utf8'), 'toolbar fixture changed mobile narrow');
 await tool('File tools').click();
 const syntax = tools.getByRole('combobox', { name: 'Syntax', exact: true });
 await syntax.selectOption('python'); await tools.waitFor({ state: 'detached' });
 assert.equal(await toolbar.locator('.syntax-select').inputValue(), 'python');
 await file.locator('..').evaluate(node => node.style.width = '100px'); await page.waitForTimeout(200);
 await tool('File tools').click();
 assert.ok(await tools.getByRole('button', { name: 'Undo', exact: true }).isEnabled());
 assert.ok(await tools.getByRole('button', { name: 'Redo', exact: true }).isDisabled());
 await page.keyboard.press('Escape'); assert.ok(await tool('File tools').evaluate(node => node === document.activeElement));
 await file.locator('..').evaluate(node => node.style.removeProperty('width')); await page.waitForTimeout(200);
 assert.equal(await tool('File tools').isVisible(), false);
 let release, started;
 const pending = new Promise(resolve => release = resolve), requested = new Promise(resolve => started = resolve);
 const holdListing = async route => {
  if (route.request().postDataJSON()?.operation === 'list') { started(); await pending; }
  await route.continue();
 };
 await page.route('**/api/files', holdListing);
 const beforeBack = await content.textContent();
 await tool('Back to files').click(); await requested;
 assert.ok(await file.locator('.file-inspector').evaluate(node => node.inert), 'pending navigation freezes the editor');
 await page.keyboard.insertText('late edit'); assert.equal(await content.textContent(), beforeBack);
 release(); await file.locator('.file-inspector').waitFor({ state: 'detached' });
 await page.unroute('**/api/files', holdListing); assert.equal(await path.inputValue(), dir);

 await open(dir + '/image.png');
 await file.locator('.image-viewport[data-ready=true]').waitFor();
 assert.equal(await path.inputValue(), dir + '/image.png');
 await tool('Next file').click(); assert.equal(await path.inputValue(), dir + '/second.png');
 await file.locator('.file-inspector').focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await path.inputValue(), dir + '/image.png');
 for (const theme of ['dark', 'light']) {
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
  for (const width of [390, 320]) {
   await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(300);
   assert.equal(await file.locator('.inspector-title').count(), 0); assert.ok(await path.isVisible());
   assert.ok(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
   const overflow = await tool('File tools').isVisible();
   if (width === 320) assert.ok(overflow);
   if (overflow) await tool('File tools').click();
   const download = (overflow ? tools : toolbar).getByRole('button', { name: 'Download file', exact: true });
   const downloaded = page.waitForEvent('download'); await download.click();
   assert.deepEqual(await readFile(await (await downloaded).path()), await readFile(dir + '/image.png'));
   await page.screenshot({ path: `test-results/inspector-media-${theme}-${width}.png` });
  }
 }
 await back();
 assert.equal(await file.locator('.inspector-menu').count(), 0);
 assert.deepEqual(errors, []);
 console.log('PASS text/media single-row overflow, compact file path, syntax/disabled controls and keyboard dismissal, exact overflow downloads and media title navigation');
} catch (error) { await page.screenshot({ path: 'test-results/inspector-failure.png' }); throw error; }
finally {
 await page.goto('about:blank'); await api('/settings', 'PUT', me.settings); await browser.close();
 server.kill('SIGTERM'); await stopped; await rm(state, { recursive: true, force: true }); await chmod(dir + '/search-only', 0o700); await rm(dir, { recursive: true, force: true });
}
