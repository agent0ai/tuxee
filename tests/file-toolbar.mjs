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
page.setDefaultTimeout(10000);
const file = page.locator('.file-view'), more = file.getByRole('button', { name: 'File actions', exact: true }), menu = page.locator('.menu-actions.popover-menu');
const names = ['Parent directory', 'Home directory', 'Refresh files', 'New folder', 'New file', 'Upload files', 'Download selected', 'Copy selected', 'Move selected', 'Open terminal here'];
async function singleRows() {
 await page.waitForTimeout(150); // Wait for the workspace's debounced viewport reconciliation.
 await page.locator('.grid-stack-item').evaluateAll(nodes => Promise.all(nodes.flatMap(node => node.getAnimations().map(animation => animation.finished.catch(() => {})))));
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 await page.waitForFunction(() => [...document.querySelectorAll('.file-nav, .file-actions')].every(bar => {
  const rects = [...bar.children].filter(node => !node.hidden).map(node => node.getBoundingClientRect());
  return bar.scrollWidth <= bar.clientWidth + 1 && Math.max(...rects.map(r => r.y + r.height / 2)) - Math.min(...rects.map(r => r.y + r.height / 2)) < 1;
 }));
 const compact = await page.locator('.board').evaluate(node => node.classList.contains('compact-board'));
 assert.equal(await page.locator('.panel-header .path-input').count(), compact ? 0 : 1);
 assert.equal(await file.locator('.file-nav').count(), compact ? 1 : 0);
 assert.equal(await page.getByRole('button', { name: 'Rename file browser', exact: true }).count(), 0);
 assert.ok(await file.locator('.file-navigation-separator').evaluate(node => node.previousElementSibling.title === 'Home directory' && node.nextElementSibling.title === 'Refresh files'));
 assert.ok(await file.locator('.file-navigation').first().evaluate(node => getComputedStyle(node).color !== getComputedStyle(node.parentElement.querySelector('[title="Refresh files"]')).color));
}
try {
 assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'toolbar', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 2 }, workspaces: [{ id: 'toolbar', name: 'Toolbar', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 1, h: 2 }] }] })).status(), 200);
 await page.goto(base); await file.locator('.file-entry').first().waitFor();
 const path = page.getByRole('textbox', { name: 'Directory path' });
 const header = page.locator('.panel-header');
 assert.equal(await path.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
 const box = await path.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
 await page.mouse.move(x, y); await page.mouse.down();
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'press must not start editing');
 await page.mouse.up(); assert.ok(await path.evaluate(node => node === document.activeElement));
 assert.notEqual(await path.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
 assert.ok(await path.evaluate(node => getComputedStyle(node).backgroundColor !== getComputedStyle(node.closest('.panel')).backgroundColor));
 await path.fill('/discarded'); await path.press('Escape'); assert.equal(await path.inputValue(), dir);
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 35, y + 35, { steps: 6 });
 await page.locator('.panel-dragging').waitFor(); await page.keyboard.press('Escape'); await page.mouse.up();
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'cancelled drag must not edit');
 await page.waitForTimeout(250);
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 40, { steps: 6 }); await page.mouse.up();
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'completed drag must not edit');
 assert.equal(await path.inputValue(), dir);
 await page.waitForTimeout(250);
 await path.fill(dir + '/copies'); await path.press('Enter');
 await file.getByText('Empty folder', { exact: true }).waitFor();
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'successful navigation ends editing');
 await file.getByRole('button', { name: 'Parent directory', exact: true }).click(); await file.locator('.file-entry').first().waitFor();
 await path.focus(); assert.ok(await path.evaluate(node => node === document.activeElement)); await path.press('Escape');
 assert.ok(await header.locator(':scope > svg').isVisible());
 assert.deepEqual(await header.locator('button').evaluateAll(nodes => nodes.map(node => node.title)), ['Close panel']);
 const original = await file.locator('.file-actions').elementHandle();
 await mkdir('test-results', { recursive: true });
 for (const width of [1440, 900, 780, 390, 320, 1440]) {
  await page.setViewportSize({ width, height: width < 760 ? 844 : 1000 }); await singleRows();
  if (width === 390) {
   await path.tap(); assert.ok(await path.evaluate(node => node === document.activeElement));
   await path.fill('/cancel-mobile-edit'); await path.press('Escape'); assert.equal(await path.inputValue(), dir);
  }
  const [visible, hidden] = await file.locator('.file-actions > button').evaluateAll(nodes => [false, true].map(hidden => nodes.filter(node => node.hidden === hidden && node.title !== 'File actions').map(node => node.title)));
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
  if (width === 320 || width === 900) await file.locator('..').screenshot({ path: `test-results/file-toolbar-${width}.png` });
 }
 // Narrow the mounted component without changing viewport mode; every action remains reachable.
 await file.locator('..').evaluate(node => node.style.width = '150px'); await singleRows();
 assert.ok((await page.locator('.path-input').boundingBox()).width > 0);
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
 await more.click(); await file.locator('..').evaluate(node => node.style.width = '180px'); await menu.waitFor({ state: 'detached' });
 await file.locator('..').evaluate(node => node.style.removeProperty('width')); await singleRows();
 await page.setViewportSize({ width: 2560, height: 1000 }); await singleRows();
 assert.equal(await file.locator('.file-actions > button[hidden]').count(), 0);
 await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
 await page.setViewportSize({ width: 320, height: 844 }); await singleRows(); await more.click();
 await page.screenshot({ path: 'test-results/file-toolbar-menu-light.png' });
 assert.deepEqual(errors, []);
 console.log('PASS desktop header path, release-to-edit/drag cancellation, mobile path row, navigation/actions overflow, 150px panels, desktop/mobile resize, overflow order/separator, keyboard focus, original menus, real copy and file-picker upload');
} catch (error) { await page.screenshot({ path: 'test-results/file-toolbar-failure.png' }); throw error; }
finally {
 await page.goto('about:blank'); await api('/settings', 'PUT', me.settings); await browser.close();
 server.kill('SIGTERM'); await stopped; await rm(state, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
}
