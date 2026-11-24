import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
const waitFor = async (check, label) => {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw Error(label);
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-archive-user-'), user = `tuxee-arc-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
await chown(home, Number(fields[2]), Number(fields[3]));
const project = home + '/project';
await mkdir(project); await chown(project, Number(fields[2]), Number(fields[3]));
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-archive-server-');
await chmod(state, 0o755); await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
await mkdir('test-results/archived-desktops', { recursive: true });
const shot = (page, name) => page.screenshot({ path: `test-results/archived-desktops/${name}.png`, animations: 'disabled' });
let browser, page;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
    assert.equal(login.status(), 200);
    const csrf = (await login.json()).csrf;
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const saved = async () => (await (await api('/me')).json()).settings;
    page = await appPage(context); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    const menuitem = name => page.getByRole('menuitem', { name, exact: true });
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    const tab = id => page.locator(`.workspace-tab-item[data-workspace="${id}"]`);
    const terminalIDs = ws => ws.panels.filter(panel => panel.kind === 'terminal').map(panel => panel.terminal);
    const startMenu = async () => { await button('Tuxee menu').click(); await page.locator('.start-menu').waitFor(); };
    const menuCount = name => page.locator(`.start-menu .start-apps [data-action="${name}"] .menu-count`);

    await page.goto(base);
    await waitFor(async () => (await saved()).workspaces[0]?.panels.some(panel => panel.terminal), 'first desktop terminals were not created');
    const first = (await saved()).workspaces[0];
    // Give the project desktop a recognizable name and default directory to restore later.
    await tab(first.id).locator('.workspace-menu').click(); await menuitem('Rename').click();
    await page.getByRole('dialog').locator('input').fill('Website'); await page.keyboard.press('Enter');
    await tab(first.id).locator('.workspace-menu').click(); await menuitem('Default directory').click();
    await dialog('Default directory').locator('input').fill('~/project'); await button('Save', dialog('Default directory')).click();
    await dialog('Default directory').waitFor({ state: 'hidden' });
    await button('New desktop').click();
    await waitFor(async () => (await saved()).workspaces[1]?.panels.some(panel => panel.terminal), 'second desktop terminals were not created');
    let settings = await saved();
    const second = settings.workspaces[1], original = settings.workspaces[0];
    assert.equal(original.name, 'Website'); assert.equal(original.defaultDirectory, '~/project');
    const archivedTerminals = terminalIDs(original);
    assert.ok(archivedTerminals.length && archivedTerminals.every(Boolean));

    // Empty archive: the Tuxee menu item has no count and opens the explanatory message.
    await startMenu();
    const items = await page.locator('.start-menu .start-apps [role=menuitem]').evaluateAll(nodes => nodes.map(node => node.dataset.action));
    assert.equal(items[items.indexOf('SquareTerminal') + 1], 'Archive', 'Archived desktops follows Retained terminals');
    assert.equal(await menuCount('Archive').textContent(), '0', 'zero is shown');
    await waitFor(async () => await menuCount('SquareTerminal').textContent().catch(() => '') === '0', 'zero retained count missing');
    assert.equal(await page.locator('.start-menu [data-action="Archive"]').getAttribute('aria-label'), 'Archived desktops: 0');
    await shot(page, 'menu-empty');
    await menuitem('Archived desktops: 0').click();
    await dialog('Archived desktops').getByText('No archived desktops yet.', { exact: false }).waitFor();
    await shot(page, 'empty');
    await button('Close dialog', dialog('Archived desktops')).click();

    // Archive sits directly above Close; cancelling keeps everything running.
    await tab(original.id).locator('.workspace-tab').click({ button: 'right' });
    const actions = await page.locator('.menu-actions [role=menuitem]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.equal(actions[actions.indexOf('Close') - 1], 'Archive', 'Archive is directly above Close');
    await shot(page, 'context-menu');
    await menuitem('Archive').click();
    await dialog('Archive Website?').waitFor();
    assert.match(await dialog('Archive Website?').textContent(), /terminals and GUI apps.*Archived desktops in the Tuxee menu/);
    await shot(page, 'confirm');
    await button('Cancel', dialog('Archive Website?')).click();
    assert.equal(await tab(original.id).count(), 1);
    for (const id of archivedTerminals) assert.equal((await (await api(`/terminals/${id}`)).json()).exited, false);

    await tab(original.id).locator('.workspace-menu').click(); await menuitem('Archive').click();
    await button('Archive', dialog('Archive Website?')).click();
    await tab(original.id).waitFor({ state: 'detached' });
    await waitFor(async () => {
        for (const id of archivedTerminals) {
            const response = await api(`/terminals/${id}`);
            if (response.status() !== 404 && !(await response.json()).exited) return false;
        }
        return true;
    }, 'archived desktop terminals kept running');
    await waitFor(async () => (await saved()).archivedWorkspaces?.length === 1, 'archive was not saved');
    settings = await saved();
    const archived = settings.archivedWorkspaces[0];
    assert.deepEqual(settings.workspaces.map(ws => ws.id), [second.id]);
    assert.equal(settings.current, second.id);
    assert.equal(archived.id, original.id); assert.equal(archived.name, 'Website'); assert.equal(archived.defaultDirectory, '~/project');
    assert.deepEqual(archived.panels.map(({ terminal, ...panel }) => panel), original.panels.map(({ terminal, ...panel }) => panel), 'layout and panels are kept');
    assert.ok(archived.panels.every(panel => !panel.terminal), 'archived desktops own no terminals');

    // A running terminal outside every desktop makes Retained terminals count and warn.
    const lost = await (await api('/terminals', 'POST', { directory: home, columns: 80, rows: 24 })).json();
    await startMenu();
    // The count covers both Retained terminals tabs: lost and closed.
    const listed = new Set(terminalIDs((await saved()).workspaces[0]));
    const retainedTotal = (await (await api('/terminals')).json()).filter(info => info.closedAt || info.exited || !listed.has(info.id)).length;
    assert.ok(retainedTotal >= 1);
    await waitFor(async () => await menuCount('SquareTerminal').textContent().catch(() => '') === String(retainedTotal), 'retained terminals count missing');
    assert.equal(await menuCount('Archive').textContent(), '1');
    assert.equal(await page.locator('.start-menu [data-action="Archive"]').getAttribute('aria-label'), 'Archived desktops: 1');
    assert.equal(await page.locator('.start-menu [data-action="SquareTerminal"]').getAttribute('aria-label'), `Retained terminals: ${retainedTotal}`);
    await shot(page, 'menu-counts');
    await menuitem(`Retained terminals: ${retainedTotal}`).click();
    const retained = dialog('Retained terminals');
    await retained.waitFor();
    assert.deepEqual(await retained.getByRole('tab').evaluateAll(tabs => tabs.map(tab => [tab.firstChild.textContent, tab.querySelector('.tab-count').textContent])), [['Lost', '1'], ['Closed', String((await (await api('/terminals')).json()).filter(info => info.closedAt).length)]]);
    await shot(page, 'retained-tabs');
    await button('Close dialog', retained).click();
    await api(`/terminals/${lost.id}`, 'DELETE');

    await startMenu(); await menuitem('Archived desktops: 1').click();
    const list = dialog('Archived desktops');
    await list.getByText('Website', { exact: true }).waitFor();
    assert.equal(await list.locator('.retained-directory').textContent(), '~/project');
    await shot(page, 'list');
    await button('Restore', list).click();
    await list.waitFor({ state: 'hidden' });
    await tab(original.id).waitFor();
    await waitFor(async () => { const value = await saved(); return !value.archivedWorkspaces && value.current === original.id && terminalIDs(value.workspaces[1]).every(Boolean); }, 'restored desktop did not start terminals');
    settings = await saved();
    const restored = settings.workspaces[1];
    assert.deepEqual(settings.workspaces.map(ws => ws.id), [second.id, original.id], 'restored desktop is appended');
    assert.equal(restored.defaultDirectory, '~/project');
    assert.deepEqual(restored.panels.map(({ terminal, ...panel }) => panel), archived.panels);
    assert.ok(terminalIDs(restored).every(id => !archivedTerminals.includes(id)), 'restoration starts fresh terminals');
    await shot(page, 'restored');

    // Deleting an archived desktop removes it permanently after confirmation.
    await tab(second.id).locator('.workspace-menu').click(); await menuitem('Archive').click();
    await button('Archive', page.getByRole('dialog')).click();
    await tab(second.id).waitFor({ state: 'detached' });
    await startMenu(); await menuitem('Archived desktops: 1').click();
    await button('Delete', list).click();
    await button('Delete', dialog(`Delete ${second.name}?`)).click();
    await list.getByText('No archived desktops yet.', { exact: false }).waitFor();
    await waitFor(async () => !(await saved()).archivedWorkspaces, 'deletion was not saved');
    await button('Close dialog', list).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await startMenu(); await shot(page, 'menu-compact');
    assert.deepEqual(errors, []);
    console.log('PASS archive placement, confirmation, terminal shutdown, persistence, menu counts, retained tab counts, restore and delete');
} catch (error) {
    if (page) await page.screenshot({ path: 'test-results/archived-desktops/failure.png' });
    throw error;
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    spawnSync('pkill', ['-KILL', '-u', user]);
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
