import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises';
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
assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
const state = await mkdtemp('/tmp/tuxee-toolbar-server-');
await chmod(state, 0o755); await copyFile('bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/data'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
const base = await new Promise((resolve, reject) => {
 const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
 server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
 server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const file = page.locator('.file-view'), more = file.getByRole('button', { name: 'File actions', exact: true }), menu = page.locator('.menu-actions.popover-menu');
const names = ['Parent directory', 'Home directory', 'Trash bin', 'Refresh files', 'New folder', 'New file', 'Upload files', 'Download selected', 'Cut', 'Copy', 'Paste', 'Open terminal here'];
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
 assert.ok(await file.locator('.file-navigation-separator').evaluate(node => node.previousElementSibling.title === 'Trash bin' && node.nextElementSibling.title === 'Refresh files'));
 assert.ok(await file.locator('.file-navigation').first().evaluate(node => getComputedStyle(node).color !== getComputedStyle(node.parentElement.querySelector('[title="Refresh files"]')).color));
}
try {
 assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'toolbar', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 2 }, workspaces: [{ id: 'toolbar', name: 'Toolbar', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 1, h: 2 }] }] })).status(), 200);
 await page.goto(base); await file.locator('.file-entry').first().waitFor();
 const hiddenToggle = file.getByRole('checkbox', { name: 'Hidden', exact: true });
 const entries = () => file.locator('.file-name span').allTextContents();
 const filter = file.getByRole('searchbox', { name: 'Filter files' });
 const filterButton = file.getByRole('button', { name: 'Filter files', exact: true });
 assert.equal(await hiddenToggle.isChecked(), false);
 assert.deepEqual(await entries(), ['copies', 'alpha.txt']);
 assert.equal(await file.locator('.file-status').textContent(), '2/4 items');
 assert.ok(await file.locator('.file-footer-separator').evaluate(node => node.textContent === '|' && node.previousElementSibling.classList.contains('file-filter') && node.nextElementSibling.textContent === 'Hidden'));
 await file.locator('.file-list').focus(); await page.keyboard.press('Control+A');
 assert.equal(await file.locator('.file-status').textContent(), '2/4 items · 2 selected');
 await hiddenToggle.check(); assert.deepEqual((await entries()).sort(), ['.hidden-folder', '.hidden.txt', 'alpha.txt', 'copies']);
 await filterButton.click(); await filter.fill('.hidden'); assert.deepEqual(await entries(), ['.hidden-folder', '.hidden.txt']);
 await hiddenToggle.uncheck(); await file.getByText('No matches', { exact: true }).waitFor();
 assert.equal(await filter.inputValue(), '.hidden');
 await hiddenToggle.focus(); await hiddenToggle.press('Space'); assert.equal(await hiddenToggle.isChecked(), true);
 await filterButton.click();
 await file.getByRole('button', { name: 'Refresh files', exact: true }).click(); await file.locator('.file-list:not(.loading)').waitFor();
 assert.equal(await hiddenToggle.isChecked(), true); assert.equal((await entries()).length, 4);
 await file.locator('.file-name').filter({ hasText: /^\.hidden-folder$/ }).dblclick();
 await file.locator('.file-name').filter({ hasText: /^\.nested$/ }).waitFor();
 await hiddenToggle.uncheck(); await file.getByText('Empty folder', { exact: true }).waitFor();
 await file.getByRole('button', { name: 'Parent directory', exact: true }).click(); await file.locator('.file-entry').first().waitFor();
 assert.deepEqual(await entries(), ['copies', 'alpha.txt']);
 await hiddenToggle.check(); await page.reload(); await file.locator('.file-entry').first().waitFor();
 assert.equal(await hiddenToggle.isChecked(), false); assert.deepEqual(await entries(), ['copies', 'alpha.txt']);
 console.log('PASS default-hidden files/folders, footer placement/counts, visible selection, text filtering, keyboard toggle, refresh/navigation and reload default');
 const path = page.getByRole('textbox', { name: 'File or directory path' });
 const header = page.locator('.panel-header');
 assert.equal(await path.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
 const box = await path.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
 await page.mouse.move(x, y); await page.mouse.down();
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'press must not start editing');
 await page.mouse.up(); assert.ok(!await path.evaluate(node => node === document.activeElement), 'release must allow time for a double-click');
 await path.locator(':scope:focus').waitFor();
 assert.notEqual(await path.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
 assert.ok(await path.evaluate(node => getComputedStyle(node).backgroundColor !== getComputedStyle(node.closest('.panel')).backgroundColor));
 await path.fill('/discarded');
 const geometry = () => page.locator('.grid-stack-item').evaluate(node => ['x', 'y', 'w', 'h'].map(key => Number(node.getAttribute('gs-' + key) ?? (key === 'w' || key === 'h' ? 1 : 0))));
 const editingGeometry = await geometry();
 await path.dblclick(); assert.deepEqual(await geometry(), editingGeometry, 'double-click while editing must select text without expanding');
 assert.equal(await path.inputValue(), '/discarded');
 await path.press('Escape'); assert.equal(await path.inputValue(), dir);
 await path.click(); await hiddenToggle.click(); await page.waitForTimeout(400);
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'a later click must cancel pending editing');
 await hiddenToggle.uncheck();
 await path.click();
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 35, y + 35, { steps: 6 });
 await page.locator('.panel-dragging').waitFor(); await page.waitForTimeout(400);
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'a second press starting a drag must cancel pending editing');
 await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(400);
 assert.ok(!await path.evaluate(node => node === document.activeElement), 'cancelled drag must not edit');
 await page.waitForTimeout(250);
 await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 40, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(400);
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
  if (width === 320 || width === 390) {
   await hiddenToggle.tap(); assert.equal(await hiddenToggle.isChecked(), true);
   await filterButton.tap(); await filter.fill('.hidden'); assert.deepEqual(await entries(), ['.hidden-folder', '.hidden.txt']);
   assert.ok(await file.locator('.file-footer').evaluate(node => node.scrollWidth <= node.clientWidth));
   await file.locator('.file-footer').screenshot({ path: `test-results/file-footer-hidden-${width}.png` });
   await hiddenToggle.tap(); await file.getByText('No matches', { exact: true }).waitFor();
   await filterButton.tap();
  }
  const [visible, hidden] = await file.locator('.file-actions > button').evaluateAll(nodes => [false, true].map(hidden => nodes.filter(node => node.hidden === hidden && node.title !== 'File actions').map(node => node.title)));
  assert.deepEqual([...visible, ...hidden], names);
  await more.click(); await menu.waitFor();
  const items = await menu.getByRole('menuitem').allTextContents();
  assert.deepEqual(items.slice(0, hidden.length), hidden);
  assert.deepEqual(items.slice(hidden.length), ['New file', 'New folder', 'Paste', 'Desktop default', 'Properties'].filter(label => !hidden.includes(label)));
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
 await more.click(); await menu.getByRole('menuitem', { name: 'Copy to…', exact: true }).click();
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
 await more.click(); await menu.getByRole('menuitem', { name: 'Cut', exact: true }).focus(); await page.keyboard.press('Escape');
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
 await page.keyboard.press('Escape');
 await page.setViewportSize({ width: 1440, height: 1000 }); await singleRows();
 for (const theme of ['dark', 'light']) {
  await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
  await path.dblclick({ delay: 75 }); await page.waitForTimeout(400);
  assert.deepEqual(await geometry(), [0, 0, 4, 2], 'double-click on the path title must expand the panel');
  assert.ok(!await path.evaluate(node => node === document.activeElement), 'double-click must not leave delayed editing behind');
  await page.screenshot({ path: `test-results/file-header-expanded-${theme}.png` });
  await path.dblclick({ delay: 75 }); await page.waitForTimeout(400);
  assert.deepEqual(await geometry(), [0, 0, 1, 1], 'double-click on the expanded path title must shrink the panel');
  assert.ok(!await path.evaluate(node => node === document.activeElement));
 }
 const columns = dir + '/columns'; await mkdir(columns);
 const samples = [[0, '0B'], [1, '1.0B'], [999, '999B'], [1024, '1.0K'], [1536, '1.5K'], [10 * 1024, '10K'], [999 * 1024 ** 2, '999M'], [1024 ** 3, '1.0G'], [1024 ** 4, '1.0T']];
 for (let i = 0; i < 32; i++) {
  const name = `${columns}/server-configuration-backup-${String(i).padStart(2, '0')}.bin`;
  await writeFile(name, ''); await truncate(name, samples[i % samples.length][0]);
  const date = new Date(i % 2 ? '2026-11-23T12:00:00Z' : '2026-01-02T12:00:00Z'); await utimes(name, date, date);
 }
 assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, columns]).status, 0);
 await path.fill(columns); await path.press('Enter'); await file.locator('.file-entry').nth(31).waitFor();
 assert.deepEqual((await file.locator('.file-size').allTextContents()).slice(0, samples.length), samples.map(([, label]) => label));
 assert.equal(await file.locator('.file-size').nth(4).getAttribute('title'), '1,536 B');
 for (const width of [300, 380, 600]) {
  await file.locator('..').evaluate((node, width) => { node.style.width = `${width}px`; node.style.height = '500px'; }, width);
  for (const column of ['size', 'modified']) {
   await file.getByRole('button', { name: `Sort by ${column === 'size' ? 'Size' : 'Modified'}`, exact: true }).click();
   const values = column === 'size'
    ? await file.locator('.file-size').evaluateAll(nodes => nodes.map(node => Number(node.title.replace(/\D/g, ''))))
    : (await file.locator('.file-date').allTextContents()).map(Date.parse);
   assert.deepEqual(values, [...values].sort((a, b) => a - b));
   const geometry = await file.evaluate(node => {
    const list = node.querySelector('.file-list'), rows = [...list.querySelectorAll('.file-entry')];
    const headings = [...node.querySelectorAll('.file-columns button')].map(el => el.getBoundingClientRect());
    const cells = rows.map(row => [...row.querySelectorAll('.file-name, .file-size, .file-date')].map(el => el.getBoundingClientRect()));
    const widths = ['.file-size', '.file-date'].map((selector, index) => {
     const heading = node.querySelectorAll('.file-columns button')[index + 1];
     const style = getComputedStyle(heading);
     const headingWidth = [...heading.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + parseFloat(style.columnGap) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
     return Math.max(headingWidth, ...rows.map(row => { const range = document.createRange(); range.selectNodeContents(row.querySelector(selector)); return range.getBoundingClientRect().width; }));
    });
    return {name:headings[0].width, row:rows[0].clientWidth, overflow:list.scrollWidth > list.clientWidth, scrolls:list.scrollHeight > list.clientHeight,
     aligned:cells.every(c => c.slice(1).every((r, i) => Math.abs(r.right - headings[i + 1].right) < 1)),
     spare:cells[0].slice(1).map((r, i) => r.width - widths[i])};
   });
   assert.ok(geometry.aligned && !geometry.overflow && geometry.scrolls, JSON.stringify({width, geometry}));
   assert.ok(geometry.name > geometry.row / 2, `filenames get most of the row: ${JSON.stringify({width, geometry})}`);
   assert.ok(geometry.spare.every(value => Math.abs(value) < 1), `metadata columns fit their widest text or heading: ${JSON.stringify({width, column, geometry})}`);
  }
  for (const theme of ['dark', 'light']) {
   await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
   await file.locator('..').screenshot({path:`test-results/file-columns-${width}-${theme}.png`});
  }
 }
 await file.locator('..').evaluate(node => { node.style.removeProperty('width'); node.style.removeProperty('height'); });
 await page.setViewportSize({width:320,height:844}); await singleRows();
 assert.equal(await file.locator('.file-date:visible').count(), 0);
 assert.equal(await file.locator('.file-entry .file-select').first().evaluate(node => node.getBoundingClientRect().width), 44);
 assert.ok(await file.locator('.file-list').evaluate(node => node.scrollWidth <= node.clientWidth));
 await file.locator('..').screenshot({path:'test-results/file-columns-mobile.png'});
 console.log('PASS compact file sizes, exact byte tooltips, content-sized aligned metadata, filename priority, sorting and narrow/mobile layouts');
 assert.deepEqual(errors, []);
 console.log('PASS delayed header editing, double-click expand/shrink, editing selection, click/drag cancellation, mobile path row, navigation/actions overflow, 150px panels, desktop/mobile resize, overflow order/separator, keyboard focus, original menus, real copy and file-picker upload');
} catch (error) { await page.screenshot({ path: 'test-results/file-toolbar-failure.png' }); throw error; }
finally {
 await page.goto('about:blank'); await api('/settings', 'PUT', me.settings); await browser.close();
 server.kill('SIGTERM'); await stopped; await rm(state, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
}
