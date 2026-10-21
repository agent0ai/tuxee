import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-toolbar-');
await mkdir(dir + '/copies'); await writeFile(dir + '/alpha.txt', 'toolbar fixture');
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
const file = page.locator('.file-view'), more = file.getByRole('button', { name: 'File actions', exact: true }), menu = page.locator('.menu-actions.popover-menu');
const names = ['New folder', 'New file', 'Upload files', 'Download selected', 'Copy selected', 'Move selected', 'Open terminal here'];
async function singleRows() {
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 await page.waitForFunction(() => [...document.querySelectorAll('.file-nav, .file-actions')].every(bar => {
  const rects = [...bar.children].filter(node => !node.hidden).map(node => node.getBoundingClientRect());
  return bar.scrollWidth <= bar.clientWidth + 1 && Math.max(...rects.map(r => r.y)) - Math.min(...rects.map(r => r.y)) < 1;
 }));
 assert.deepEqual(await file.locator('.file-nav button').evaluateAll(nodes => nodes.map(node => node.title)), ['Parent directory', 'Home directory', 'Refresh files']);
 assert.ok(await file.locator('.file-nav').evaluate(bar => [...bar.querySelectorAll('button')].every(button => button.getBoundingClientRect().right <= bar.querySelector('input').getBoundingClientRect().left)));
}
try {
 assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'toolbar', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 2 }, workspaces: [{ id: 'toolbar', name: 'Toolbar', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 1, h: 2 }] }] })).status(), 200);
 await page.goto(base); await file.locator('.file-entry').first().waitFor();
 const original = await file.locator('.file-actions').elementHandle();
 await mkdir('test-results', { recursive: true });
 for (const width of [1440, 900, 780, 390, 320, 1440]) {
  await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 }); await singleRows();
  const hidden = await file.locator('.file-actions > button[hidden]').evaluateAll(nodes => nodes.map(node => node.title));
  const visible = await file.locator('.file-actions > button:not([hidden])').evaluateAll(nodes => nodes.filter(node => node.title !== 'File actions').map(node => node.title));
  assert.deepEqual([...visible, ...hidden], names);
  await more.click(); await menu.waitFor();
  const items = await menu.getByRole('menuitem').allTextContents();
  assert.deepEqual(items.slice(0, hidden.length), hidden);
  assert.deepEqual(items.slice(hidden.length), ['New file', 'New folder', 'Properties']);
  assert.equal(await menu.getByRole('separator').count(), hidden.length ? 1 : 0);
  if (hidden.length) assert.ok(await menu.getByRole('separator').evaluate(node => {
   const rect = node.getBoundingClientRect();
   return rect.height === 1 && node.nextElementSibling.getBoundingClientRect().top - node.previousElementSibling.getBoundingClientRect().bottom <= 6;
  }));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.ok(await more.evaluate(node => node === document.activeElement));
  assert.ok(await original.evaluate(node => node.isConnected), 'resizing must retain the toolbar');
  if (width === 320 || width === 900) await file.screenshot({ path: `test-results/file-toolbar-${width}.png` });
 }
 // Narrow the mounted component without changing viewport mode; every action remains reachable.
 await file.evaluate(node => node.style.width = '150px'); await singleRows();
 assert.ok((await file.locator('.path-input').boundingBox()).width > 0);
 await file.locator('.file-entry').filter({ hasText: 'alpha.txt' }).click();
 await more.click(); await menu.getByRole('menuitem', { name: 'Copy selected', exact: true }).click();
 const copy = page.getByRole('dialog', { name: 'Copy selected items', exact: true });
 await copy.getByRole('textbox').fill(dir + '/copies');
 const copied = page.waitForResponse(response => response.url() === base + '/api/files' && response.request().postDataJSON()?.operation === 'copy');
 await copy.getByRole('button', { name: 'Continue', exact: true }).click(); assert.equal((await copied).status(), 200);
 assert.equal(await readFile(dir + '/copies/alpha.txt', 'utf8'), 'toolbar fixture');
 await more.click(); const chooser = page.waitForEvent('filechooser');
 await menu.getByRole('menuitem', { name: 'Upload files', exact: true }).click();
 await (await chooser).setFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('overflow upload') });
 await file.locator('.file-entry').filter({ hasText: 'uploaded.txt' }).waitFor();
 assert.equal(await readFile(dir + '/uploaded.txt', 'utf8'), 'overflow upload');
 await more.click(); await menu.getByRole('menuitem', { name: 'Move selected', exact: true }).focus(); await page.keyboard.press('Escape');
 await file.locator('.file-entry').filter({ hasText: 'alpha.txt' }).click({ button: 'right' });
 assert.equal(await menu.getByRole('separator').count(), 0, 'item context menus must not gain toolbar overflow');
 await page.keyboard.press('Escape');
 await more.click(); await file.evaluate(node => node.style.width = '180px'); await menu.waitFor({ state: 'detached' });
 await file.evaluate(node => node.style.removeProperty('width')); await singleRows();
 assert.equal(await file.locator('.file-actions > button[hidden]').count(), 0);
 await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
 await page.setViewportSize({ width: 320, height: 844 }); await singleRows(); await more.click();
 await page.screenshot({ path: 'test-results/file-toolbar-menu-light.png' });
 assert.deepEqual(errors, []);
 console.log('PASS single-row navigation/actions, 150px panels, desktop/mobile resize, overflow order/separator, keyboard focus, original menus, real copy and file-picker upload');
} catch (error) { await page.screenshot({ path: 'test-results/file-toolbar-failure.png' }); throw error; }
finally {
 await page.goto('about:blank'); await api('/settings', 'PUT', me.settings); await browser.close();
 server.kill('SIGTERM'); await stopped; await rm(state, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
}
