import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test', 'refusing unrelated account');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const dir = await mkdtemp(fields[5] + '/tuxee-scrollbars-');
await writeFile(dir + '/wide.txt', Array.from({ length: 500 }, (_, i) => `${i} ${'long line '.repeat(110)}\n`).join(''));
await copyFile('assets/tuxee-logo-vertical.png', dir + '/image.png');
for (let i = 0; i < 100; i++) await writeFile(`${dir}/entry-${i}.txt`, 'fixture');
assert.equal(spawnSync('chown', ['-R', `${fields[2]}:${fields[3]}`, dir]).status, 0);
const state = await mkdtemp('/tmp/tuxee-scrollbar-server-');
const server = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
const base = await new Promise((resolve, reject) => {
 const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
 server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
 server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json();
const api = (path, method, data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await appPage(context), errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10000);
const file = page.locator('[data-panel=files] .file-view');
const geometry = () => page.locator('[data-panel]').evaluateAll(nodes => nodes.map(node => ['x','y','w','h'].map(key => node.getAttribute('gs-' + key))));
async function open(name) {
 const path = page.locator('[data-panel=files] .path-input');
 await path.fill(dir + '/' + name); await path.press('Enter');
}
async function nativeScroll(selector, axis) {
 const scroll = file.locator(selector);
 await scroll.evaluate(node => { node.scrollTop = node.scrollLeft = 0; });
 const before = await geometry();
 const point = await scroll.evaluate((node, axis) => {
  const box = node.getBoundingClientRect();
  const horizontal = axis === 'x';
  if ((horizontal ? node.scrollWidth <= node.clientWidth : node.scrollHeight <= node.clientHeight)) throw Error('fixture must overflow');
  return { x: horizontal ? box.left + 12 : box.right - 5, y: horizontal ? box.bottom - 5 : box.top + 12 };
 }, axis);
 const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.panel-resize, .workspace-divider')?.className, point);
 assert.equal(target, undefined, `${selector} ${axis}: scrollbar wins hit testing`);
 await page.mouse.move(point.x, point.y); await page.mouse.down();
 await page.mouse.move(point.x + (axis === 'x' ? 140 : 0), point.y + (axis === 'y' ? 140 : 0), { steps: 8 });
 assert.equal(await page.locator('.resizing-panel, .resizing-dividers').count(), 0, 'scrollbar drag must not resize');
 await page.mouse.up();
 await page.waitForFunction(({ selector, axis }) => {
  const node = document.querySelector('[data-panel=files] ' + selector);
  return (axis === 'x' ? node.scrollLeft : node.scrollTop) > 30;
 }, { selector, axis });
 assert.deepEqual(await geometry(), before);
}
let terminal;
try {
 const response = await api('/terminals', 'POST', { directory: dir, name: 'Scrollbar test', command: "printf 'line %s\\r\\n' {1..300}; exec /bin/bash --noprofile --norc", columns: 80, rows: 24 });
 assert.equal(response.status(), 201); terminal = await response.json();
 assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'scrollbars', workspaces: [{ id: 'scrollbars', name: 'Scrollbars', columns: 4, rows: 2, active: 'files', panels: [
  { id: 'files', kind: 'files', path: dir, x: 0, y: 0, w: 2, h: 2 },
  { id: 'terminal', kind: 'terminal', terminal: terminal.id, path: dir, x: 2, y: 0, w: 2, h: 2 }
 ] }] })).status(), 200);
 await page.goto(base); await file.locator('.file-entry').first().waitFor();
 await page.locator('.terminal-view[data-state=connected]').waitFor();
 await mkdir('test-results', { recursive: true });
 for (const theme of ['dark', 'light']) {
  if (theme === 'light') await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click();
  await open('wide.txt'); await file.locator('.cm-content').waitFor();
  await nativeScroll('.cm-scroller', 'x'); await nativeScroll('.cm-scroller', 'y');
  await page.screenshot({ path: `test-results/scrollbars-editor-${theme}.png` });
  await file.getByRole('button', { name: 'Back to files', exact: true }).click(); await file.locator('.file-inspector').waitFor({ state: 'detached' });
  await nativeScroll('.file-list', 'y');
  await open('image.png'); await file.locator('.image-viewport[data-ready]').waitFor();
  await file.getByRole('button', { name: 'Actual size (100%)', exact: true }).click();
  await nativeScroll('.image-viewport', 'x'); await nativeScroll('.image-viewport', 'y');
  await file.getByRole('button', { name: 'Back to files', exact: true }).click(); await file.locator('.file-inspector').waitFor({ state: 'detached' });
 }
 const slider = page.locator('[data-panel=terminal] .xterm .scrollbar.vertical .slider');
 await slider.waitFor({ state: 'visible' });
 const before = await geometry(), box = await slider.boundingBox();
 const top = await slider.evaluate(node => node.style.top);
 await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(200); await page.mouse.down();
 await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 160, { steps: 8 });
 assert.equal(await page.locator('.resizing-panel, .resizing-dividers').count(), 0);
 await page.mouse.up(); await page.waitForFunction(top => document.querySelector('[data-panel=terminal] .scrollbar.vertical .slider').style.top !== top, top); assert.deepEqual(await geometry(), before);
 const splitter = page.getByRole('separator', { name: 'Resize panels', exact: true });
 const gap = await splitter.boundingBox();
 assert.ok(await splitter.evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }), 'shared splitter keeps the gap');
 await page.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2); await page.mouse.down();
 await page.mouse.move(gap.x + gap.width / 2 + 120, gap.y + gap.height / 2, { steps: 5 });
 assert.equal(await page.locator('.resizing-dividers').count(), 1);
 await page.keyboard.press('Escape'); await page.mouse.up(); assert.deepEqual(await geometry(), before);
 assert.deepEqual(errors, []);
 console.log('PASS horizontal/vertical editor and image scrollbars, file lists, xterm thumb drags, unchanged layouts and shared splitter priority in both themes');
} catch (error) { await page.screenshot({ path: 'test-results/scrollbars-failure.png' }); throw error; }
finally {
 await page.goto('about:blank'); await api('/settings', 'PUT', me.settings);
 if (terminal) await api(`/terminals/${terminal.id}`, 'DELETE');
 await browser.close(); server.kill('SIGTERM'); await stopped;
 await rm(state, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true });
}
