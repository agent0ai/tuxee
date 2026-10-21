import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
await mkdir('.test-state', { recursive: true });
const generated = spawnSync('.tools/go/bin/go', ['test', './internal/processes', '-run', '^TestProjection$', '-count=1'], { encoding: 'utf8', env: { ...process.env, TUXEE_PROCESS_FIXTURES: process.cwd() + '/.test-state/process-fixtures.json' } });
assert.equal(generated.status, 0, generated.stdout + generated.stderr);
await import('./process-selection.mjs');

const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const fields = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':');
assert.equal(fields[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const state = await mkdtemp('/tmp/tuxee-process-test-');
const server = spawn('./bin/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const serverExit = new Promise(resolve => server.once('exit', resolve));
const base = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('server startup timed out')), 10000); server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } }); server.once('exit', () => reject(Error('server exited'))); });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
assert.equal((await context.request.get(base + '/api/processes')).status(), 401);
assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
const me = await (await context.request.get(base + '/api/me')).json(), original = me.settings;
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
let requests = 0, lastRefresh = 0, lastKillResponse = 0;
page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/processes')) { requests++; lastRefresh = performance.now(); } });
page.on('response', response => { if (response.request().method() === 'POST' && response.url() === base + '/api/processes') lastKillResponse = performance.now(); });
const dialog = page.getByRole('dialog', { name: 'Resource monitor', exact: true });
const fixtures = JSON.parse(await readFile('.test-state/process-fixtures.json', 'utf8'));
let fixture = 'container', worker, family, workerExit;
async function openProcesses() { await page.getByRole('button', { name: 'User menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Resource monitor', exact: true }).click(); await dialog.getByRole('tab', { name: 'Processes', exact: true }).click(); await dialog.locator('.processes[aria-busy=false]').waitFor(); }
async function refresh() { await dialog.getByRole('button', { name: 'Refresh processes', exact: true }).click(); await dialog.locator('.processes[aria-busy=false]').waitFor(); }
try {
 await api('/settings', 'PUT', { theme: 'dark', current: 'processes', monitoring: { hidden: true, cpu: true, memory: true, swap: false, disks: [], networks: [], interval: 2 }, workspaces: [{ id: 'processes', name: 'Processes', columns: 4, rows: 2, active: 'files', panels: [{ id: 'files', kind: 'files', path: '/', x: 0, y: 0, w: 4, h: 2 }] }] });
 await page.route(base + '/api/processes?*', async route => {
  if (route.request().method() !== 'GET') return route.continue();
  const query = new URL(route.request().url()).searchParams, allowCore = query.get('allowCore') === 'true';
  const key = fixture === 'container' && allowCore ? 'containerCore' : fixture === 'wide' && query.get('sort') === 'cpu' ? 'wideCPU' : fixture;
  await route.fulfill({ json: { ...fixtures[key], snapshot: 'synthetic', allowCore } });
 });
 await page.goto(base); await page.locator('.topbar').waitFor(); assert.equal(requests, 0);
 await openProcesses(); assert.equal(requests, 1);
 const processTab = dialog.getByRole('tab', { name: 'Processes', exact: true });
 await processTab.focus(); await page.keyboard.press('ArrowLeft');
 assert.ok(await dialog.getByRole('tabpanel', { name: 'Resources', exact: true }).isVisible());
 await page.keyboard.press('ArrowRight');
 assert.ok(await dialog.getByRole('tabpanel', { name: 'Processes', exact: true }).isVisible());
 await page.waitForTimeout(2600); assert.equal(requests, 1, 'no process polling');
 const core = dialog.getByRole('checkbox', { name: 'Allow killing core', exact: true });
 const root = dialog.locator('tr[data-pid="1"] input');
 assert.equal(await core.isChecked(), false); assert.equal(await root.isDisabled(), true);
 assert.equal(await dialog.getByRole('button', { name: 'Kill', exact: true }).locator('svg').count(), 1);
 await core.check(); await dialog.locator('.processes[aria-busy=false]').waitFor();
 assert.equal(await root.isEnabled(), true); await root.check();
 await dialog.getByRole('button', { name: 'Kill', exact: true }).click();
 const corePopup = page.getByRole('dialog', { name: 'Kill processes', exact: true });
 assert.equal(await corePopup.locator('.process-kill-summary strong').textContent(), `${fixtures.containerCore.total} processes`);
 let corePosts = 0;
 await page.route(base + '/api/processes', async route => {
  const input = route.request().postDataJSON(); corePosts++;
  assert.equal(input.allowCore, true); assert.deepEqual(input.selected, ['p:1']);
  // Never send synthetic core PIDs to the real service.
  await route.fulfill({ json: { results: [{ pid: 1, error: 'fixture denied' }] } });
 });
 const coreRefresh = page.waitForRequest(r => r.method() === 'GET' && r.url().includes('/api/processes?'));
 const beforeCoreKill = requests;
 await corePopup.getByRole('button', { name: 'Kill processes', exact: true }).click();
 await corePopup.waitFor({ state: 'detached' }); await coreRefresh;
 assert.ok(lastRefresh - lastKillResponse >= 450, 'refresh waits about 500ms after kill');
 await dialog.locator('.processes[aria-busy=false]').waitFor();
 assert.match(await dialog.locator('.processes > .monitor-error').textContent(), /fixture denied/);
 assert.equal(await core.isChecked(), true);
 await page.waitForTimeout(700); assert.equal(requests, beforeCoreKill + 1, 'one refresh after kill'); assert.equal(corePosts, 1, 'no signal retry');
 await page.unroute(base + '/api/processes');
 await root.check(); await core.uncheck(); await dialog.locator('.processes[aria-busy=false]').waitFor();
 assert.equal(await root.isDisabled(), true); assert.equal(await dialog.locator('tbody input:checked').count(), 0);
 assert.equal(await dialog.getByRole('button', { name: 'Kill', exact: true }).isDisabled(), true);

 await mkdir('test-results', { recursive: true });
 const renderings = [];
 for (const name of ['container', 'wide', 'zombies', 'large', 'deep']) {
  fixture = name; const started = performance.now(); await refresh();
  const elapsed = Math.round(performance.now() - started); renderings.push({ fixture: name, processes: fixtures[name].total, rows: await dialog.locator('tbody tr').count(), renderMS: elapsed });
  assert.equal(await dialog.locator('tbody tr').count(), fixtures[name].rows.length); assert.ok(fixtures[name].rows.length <= 1000);
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), name + ' overflow');
  await page.screenshot({ path: `test-results/processes-${name}.png` });
  const fold = dialog.locator('.process-fold').first(), beforeFold = requests;
  await fold.click(); assert.equal(await dialog.locator('tbody tr:visible').count(), 1);
  await fold.click(); assert.equal(await dialog.locator('tbody tr:visible').count(), fixtures[name].rows.length);
  assert.equal(requests, beforeFold, 'folding uses the existing snapshot');
 }
 const beforeResize = requests, indents = [];
 for (const width of [1440, 900, 700, 601, 600, 481, 480, 390, 320, 1440]) {
  await page.setViewportSize({ width, height: 1000 });
  const rows = await dialog.locator('.process-name').evaluateAll(lines => lines.map(line => {
   const text = line.querySelector('.process-label'), label = text.getBoundingClientRect(), box = line.getBoundingClientRect();
   const check = line.querySelector('.process-check').getBoundingClientRect();
   return { indent: check.left - box.left, free: box.right - label.right, labelWidth: label.width, clipped: text.scrollWidth > text.clientWidth, right: label.right, end: box.right };
  }));
  for (let i = 1; i < rows.length; i++) {
   assert.ok(rows[i].indent >= rows[i - 1].indent - 1, `depth alignment at ${width}px`);
   if (rows[i - 1].free > 40) assert.ok(rows[i].indent > rows[i - 1].indent + 1, `unused indentation space at depth ${i}, ${width}px`);
   assert.ok(rows[i].labelWidth >= 60 || !rows[i].clipped, `readable names at depth ${i}, ${width}px`);
   assert.ok(rows[i].right <= rows[i].end + 1, `name overflow at depth ${i}, ${width}px`);
  }
  assert.ok(await dialog.locator('.process-scroll').evaluate(node => node.scrollWidth <= node.clientWidth), `tree overflow at ${width}px`);
  indents.push({ width, indent: rows.at(-1).indent });
  if (width === 1440 || width === 320) await page.screenshot({ path: `test-results/processes-deep-${width}.png` });
 }
 assert.ok(indents[0].indent > indents.find(item => item.width === 320).indent, 'wider name column permits deeper indentation');
 assert.equal(indents[0].indent, indents.at(-1).indent, 'indentation expands again after resizing');
 assert.equal(requests, beforeResize, 'resizing reuses the snapshot');
 fixture = 'wide'; await refresh();
 assert.equal(await dialog.locator('.process-group').count(), 1);
 assert.equal(await dialog.locator('tbody tr[data-pid]').count(), 101, 'init + parent + top 99 children');
 const parent = dialog.locator('tr[data-pid="2"] input'); await parent.check();
 assert.ok(await dialog.locator('.process-group input').isChecked());
 const child = dialog.locator('tbody tr[data-pid] input:not(:disabled)').nth(1); await child.uncheck(); assert.equal(await parent.isChecked(), false);
 await parent.check(); await dialog.getByRole('button', { name: 'Kill', exact: true }).click();
 const popup = page.getByRole('dialog', { name: 'Kill processes', exact: true });
 assert.equal(await popup.locator('.process-kill-summary strong').textContent(), '5,001 processes');
 assert.equal(await popup.getByRole('switch').count(), 0); assert.equal(await popup.getByRole('radio', { name: 'SIGTERM', exact: true }).isChecked(), true);
 await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
 const beforeSort = requests; await dialog.getByRole('button', { name: 'Sort by CPU', exact: true }).click(); await dialog.locator('.processes[aria-busy=false]').waitFor(); assert.equal(requests, beforeSort + 1);
 assert.equal(await dialog.locator('tbody tr[data-pid]').nth(2).getAttribute('data-pid'), String(fixtures.wideCPU.rows[2].pid));
 for (const width of [390, 320]) {
  fixture = 'container'; await page.setViewportSize({ width, height: 844 }); await refresh();
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
  assert.ok(await dialog.locator('.process-scroll').evaluate(node => node.scrollWidth <= node.clientWidth));
  await page.screenshot({ path: `test-results/processes-mobile-${width}.png` });
 }
 await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
 await page.getByRole('button', { name: 'Toggle light or dark theme', exact: true }).click(); await openProcesses();
 await page.screenshot({ path: 'test-results/processes-mobile-light.png' });
 assert.equal(await core.isChecked(), false, 'core opt-in resets on close');
 await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
 await page.unroute(base + '/api/processes?*'); await page.setViewportSize({ width: 1440, height: 1000 });
 console.log('PASS synthetic tree rendering, bounded rows, zombie summaries, grouped selection and sort refetch', renderings);
 // A subreaper owns the disposable family, including after its selected parent exits.
 worker = spawn('python3', ['-u', '-c', `import os, signal, time, json, ctypes
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
parent = os.fork()
if parent == 0:
 signal.signal(signal.SIGTERM, signal.SIG_IGN)
 children = []
 for i in range(105):
  pid = os.fork()
  if pid == 0:
   while True: time.sleep(60)
  children.append(pid)
 print(json.dumps({'parent': os.getpid(), 'children': children}), flush=True)
 while True: time.sleep(60)
else:
 while True:
  try: os.wait()
  except ChildProcessError: break
`], { uid: Number(fields[2]), gid: Number(fields[3]), stdio: ['ignore', 'pipe', 'pipe'] });
 workerExit = new Promise(resolve => worker.once('exit', resolve));
 family = await new Promise((resolve, reject) => { let output = ''; worker.stdout.on('data', data => { output += data; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])); }); worker.once('exit', () => reject(Error('fixture exited'))); });
 await openProcesses();
 const liveParent = dialog.locator(`tr[data-pid="${family.parent}"] input`); await liveParent.check();
 const liveSnapshot = await (await api('/processes?sort=ram')).json();
 const row = liveSnapshot.rows.find(row => row.pid === family.parent); assert.ok(row); assert.equal(row.targets, 106);
 // Refresh the UI after the explicit API snapshot replaced its token.
 await refresh(); await liveParent.check();
 assert.ok(await dialog.locator('.process-group input:checked').count() >= 1);
 await dialog.getByRole('button', { name: 'Kill', exact: true }).click();
 assert.equal(await popup.locator('.process-kill-summary strong').textContent(), '106 processes');
 assert.equal(await popup.locator('.process-kill-counts').textContent(), '1 selected · 105 children');
 const afterTerm = page.waitForRequest(r => r.method() === 'GET' && r.url().includes('/api/processes?'));
 const term = page.waitForResponse(r => r.url() === base + '/api/processes' && r.request().method() === 'POST');
 await popup.getByRole('button', { name: 'Kill processes', exact: true }).click();
 const termResponse = await term; assert.equal(termResponse.status(), 200); assert.equal((await termResponse.json()).results.filter(r => !r.error).length, 106);
 await popup.waitFor({ state: 'detached' });
 for (const pid of [family.parent, ...family.children]) process.kill(pid, 0);
 await afterTerm; assert.ok(lastRefresh - lastKillResponse >= 450); await dialog.locator('.processes[aria-busy=false]').waitFor();
 await liveParent.check(); await dialog.getByRole('button', { name: 'Kill', exact: true }).click(); await popup.getByRole('radio', { name: 'Force kill', exact: true }).check();
 const afterKill = page.waitForRequest(r => r.method() === 'GET' && r.url().includes('/api/processes?'));
 const killed = page.waitForResponse(r => r.url() === base + '/api/processes' && r.request().method() === 'POST');
 await popup.getByRole('button', { name: 'Kill processes', exact: true }).click(); assert.equal((await killed).status(), 200); await workerExit; family = undefined;
 await popup.waitFor({ state: 'detached' });
 await afterKill; await dialog.locator('.processes[aria-busy=false]').waitFor();
 assert.equal(await liveParent.count(), 0, 'killed process disappears after automatic refresh');
 console.log('PASS real user-scoped tree signals, ignored SIGTERM, Force kill and grouped hidden children');
 // The shared outage overlay keeps an explicit route to recovery controls.
 await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
 await page.route(base + '/api/connection', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }));
 const overlay = page.getByRole('dialog', { name: 'Connection lost, reconnecting...', exact: true }); await overlay.waitFor({ timeout: 12000 });
 await overlay.getByRole('button', { name: 'Processes', exact: true }).click();
 const recovery = page.getByRole('dialog', { name: 'Processes', exact: true }); await recovery.locator('.processes[aria-busy=false]').waitFor();
 assert.ok(await recovery.evaluate(node => node.matches(':modal'))); await recovery.getByRole('button', { name: 'Close dialog', exact: true }).click();
 await page.unroute(base + '/api/connection'); await overlay.waitFor({ state: 'detached' });
 assert.deepEqual(errors, []); console.log('PASS process recovery remains accessible during readiness failure');
} catch (error) { await page.screenshot({ path: 'test-results/processes-failure.png' }); throw error; }
finally {
 if (family) { for (const pid of [...family.children, family.parent]) { try { process.kill(pid, 'SIGKILL'); } catch {} } await workerExit; }
 await page.goto('about:blank'); await api('/settings', 'PUT', original).catch(() => {}); await browser.close(); server.kill('SIGTERM'); await serverExit; await rm(state, { recursive: true, force: true });
}
