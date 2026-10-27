import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
const home = await mkdtemp('/tmp/tuxee-directory-user-'), user = `tuxee-dir-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
assert.equal(fields[4], 'Tuxee prototype test');
const uid = Number(fields[2]), gid = Number(fields[3]);
await chown(home, uid, gid);
const globalPath = home + '/global folder', workspacePath = home + '/workspace folder', otherPath = home + '/other';
for (const path of [globalPath, workspacePath, otherPath]) { await mkdir(path); await chown(path, uid, gid); }
await writeFile(home + '/file.txt', 'directory fixture\n'); await chown(home + '/file.txt', uid, gid);
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-directory-server-');
await chmod(state, 0o755); await copyFile('./bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser, page;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const login = await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } });
    assert.equal(login.status(), 200);
    const csrf = (await login.json()).csrf;
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const saved = async () => (await (await api('/me')).json()).settings;
    const info = async id => (await api(`/terminals/${id}`)).json();
    const cwd = async id => run('runuser', ['-u', user, '--', 'readlink', `/proc/${(await info(id)).pid}/cwd`]);
    page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    const menuitem = name => page.getByRole('menuitem', { name, exact: true });
    const dialog = name => page.getByRole('dialog', { name, exact: true });
    const openSettings = async () => { await button('User menu').click(); await menuitem('Settings').click(); await dialog('Settings').waitFor(); };
    const saveSettings = async (path, status = 200) => {
        await dialog('Settings').getByLabel('Default directory', { exact: true }).fill(path);
        const response = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
        await button('Save', dialog('Settings')).click(); assert.equal((await response).status(), status);
        if (status === 200) await dialog('Settings').waitFor({ state: 'hidden' });
    };
    const openDirectory = async id => {
        const menu = page.locator(`.workspace-tab-item[data-workspace="${id}"] .workspace-menu`);
        if (!await menu.isVisible()) await button('More workspaces').click();
        await menu.click();
        await menuitem('Default directory').click(); await dialog('Default directory').waitFor();
    };
    const setDirectory = async (id, path) => {
        await openDirectory(id); await dialog('Default directory').getByLabel('Directory', { exact: true }).fill(path);
        await button('Save', dialog('Default directory')).click(); await dialog('Default directory').waitFor({ state: 'hidden' });
    };
    const override = async id => (await saved()).workspaces.find(ws => ws.id === id).defaultDirectory;
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await waitFor(async () => (await saved()).workspaces[0]?.panels.every(panel => panel.path === home && (panel.kind !== 'terminal' || panel.terminal)), 'initial home paths');
    const initial = (await saved()).workspaces[0], wsID = initial.id;
    const terminalPanel = initial.panels.find(p => p.kind === 'terminal'), filePanel = initial.panels.find(p => p.kind === 'files');
    const terminal = page.locator(`[data-panel="${terminalPanel.id}"] .terminal-view`);
    const file = page.locator(`[data-panel="${filePanel.id}"]`), list = file.locator('.file-list');
    const row = name => file.locator(`.file-entry[data-path="${home}/${name}"]`);
    const filePath = () => file.getByRole('textbox', { name: 'File or directory path', exact: true });
    const navigate = async path => {
        await filePath().fill(path); await filePath().press('Enter');
        await waitFor(async () => await filePath().inputValue() === path && await file.locator('.file-list.loading').count() === 0, 'file navigation');
    };
    const original = await info(terminalPanel.terminal);
    assert.equal(await cwd(original.id), home);
    await openSettings(); assert.equal(await dialog('Settings').getByLabel('Default directory', { exact: true }).inputValue(), '~');
    await saveSettings('relative', 400); assert.equal((await saved()).defaultDirectory, undefined);
    await saveSettings('~/global folder'); assert.equal((await saved()).defaultDirectory, '~/global folder');
    assert.equal(await filePath().inputValue(), home); assert.equal((await info(original.id)).pid, original.pid);
    await openSettings(); await dialog('Settings').getByLabel('Default directory', { exact: true }).fill('~/other');
    await button('Close dialog', dialog('Settings')).click(); assert.equal((await saved()).defaultDirectory, '~/global folder');
    const defaultResponse = await api('/terminals', 'POST', { columns: 80, rows: 24 });
    assert.equal(defaultResponse.status(), 201); const defaultTerminal = await defaultResponse.json();
    assert.equal(await cwd(defaultTerminal.id), globalPath); await api(`/terminals/${defaultTerminal.id}`, 'DELETE');
    await openDirectory(wsID); assert.equal(await dialog('Default directory').getByLabel('Directory', { exact: true }).inputValue(), '~/global folder');
    await button('Save', dialog('Default directory')).click(); await dialog('Default directory').waitFor({ state: 'hidden' });
    assert.equal(await override(wsID), undefined);
    await row('workspace folder').click({ button: 'right' }); await menuitem('Workspace default').click();
    await waitFor(async () => await override(wsID) === workspacePath, 'folder menu default');
    assert.equal(await filePath().inputValue(), home); assert.equal(await cwd(original.id), home);
    await button('Home directory', file).click(); await waitFor(async () => await filePath().inputValue() === workspacePath, 'workspace Home');
    await button('Add terminal').click();
    await waitFor(async () => (await saved()).workspaces[0].panels.filter(p => p.terminal).length === 2, 'new terminal');
    const added = (await saved()).workspaces[0].panels.find(p => p.terminal && p.terminal !== original.id);
    assert.equal(await cwd(added.terminal), workspacePath);
    await button('Add file browser').click();
    await waitFor(async () => (await saved()).workspaces[0].panels.length === 5, 'new file browser');
    assert.equal((await saved()).workspaces[0].panels.at(-1).path, workspacePath);
    await button('Reset terminal', terminal).click(); await button('Kill and reset', dialog('Reset terminal?')).click();
    await waitFor(async () => await terminal.getAttribute('data-state') === 'connected' && await terminal.getAttribute('data-terminal') !== original.id, 'reset terminal');
    let replacement = await terminal.getAttribute('data-terminal'); assert.equal(await cwd(replacement), workspacePath);
    assert.equal((await api(`/terminals/${original.id}`)).status(), 404);
    assert.equal(await cwd(added.terminal), workspacePath);
    await setDirectory(wsID, '~/other');
    await api(`/terminals/${replacement}`, 'DELETE'); await button('Restart terminal', terminal).click();
    await waitFor(async () => await terminal.getAttribute('data-state') === 'connected' && await terminal.getAttribute('data-terminal') !== replacement, 'lost-session restart');
    replacement = await terminal.getAttribute('data-terminal'); assert.equal(await cwd(replacement), otherPath);
    const reconnectPID = (await info(replacement)).pid;
    await button('Reconnect terminal', terminal).click(); await terminal.locator('.xterm').waitFor();
    assert.equal((await info(replacement)).pid, reconnectPID);
    console.log('PASS per-user default, inheritance, real shell cwd, reset/recovery and retained sessions');

    await navigate(home);
    await row('file.txt').click({ button: 'right' }); assert.equal(await menuitem('Workspace default').count(), 0); await page.keyboard.press('Escape');
    await row('global folder').click(); await row('workspace folder').click({ modifiers: ['Control'] });
    await button('File actions', file).click(); assert.equal(await menuitem('Workspace default').count(), 0); await page.keyboard.press('Escape');
    await button('Properties', file).click(); assert.equal(await button('Workspace default', dialog('Properties')).count(), 0); await button('Close dialog', dialog('Properties')).click();
    await row('global folder').click(); await button('File actions', file).click(); await menuitem('Workspace default').click();
    await waitFor(async () => await override(wsID) === undefined, 'global-equivalent folder removes override');
    await row('workspace folder').click(); await button('Properties', file).click();
    await button('Workspace default', dialog('Properties')).click(); await waitFor(async () => await override(wsID) === workspacePath, 'properties shortcut');
    const permissions = dialog('Properties').getByLabel('Permissions', { exact: true });
    const apply = button('Apply', dialog('Properties'));
    const inputBox = await permissions.boundingBox(), applyBox = await apply.boundingBox();
    assert.ok(applyBox.x >= inputBox.x + inputBox.width && Math.abs(applyBox.y + applyBox.height - inputBox.y - inputBox.height) < 2, 'Apply sits beside the input');
    await permissions.fill('0750'); await apply.click(); await dialog('Properties').waitFor({ state: 'hidden' });
    assert.equal((await stat(workspacePath)).mode & 0o777, 0o750);
    await row('file.txt').waitFor(); await row('file.txt').click();
    await list.click({ button: 'right', position: { x: 20, y: (await list.boundingBox()).height - 8 } });
    await menuitem('Workspace default').click(); await waitFor(async () => await override(wsID) === home, 'background menu targets current folder');
    await button('File actions', file).click(); await menuitem('Properties').click();
    await button('Workspace default', dialog('Properties')).click(); assert.equal(await override(wsID), home);
    await button('Close dialog', dialog('Properties')).click();
    await setDirectory(wsID, globalPath + '/'); assert.equal(await override(wsID), undefined);
    await button('Home directory', file).click(); await waitFor(async () => await filePath().inputValue() === globalPath, 'global Home');
    await navigate(otherPath);
    if (await button('Open terminal here', file).isVisible()) await button('Open terminal here', file).click();
    else { await button('File actions', file).click(); await menuitem('Open terminal here').click(); }
    await waitFor(async () => (await saved()).workspaces[0].panels.filter(p => p.terminal).length === 3, 'explicit terminal');
    const explicit = (await saved()).workspaces[0].panels.at(-1); assert.equal(await cwd(explicit.terminal), otherPath);
    console.log('PASS single-folder shortcuts, background/Properties targeting, Apply permissions and explicit terminal directory');

    await button('New workspace').click();
    await waitFor(async () => (await saved()).workspaces.length === 2 && (await saved()).workspaces[1].panels.every(p => p.path === globalPath && (p.kind !== 'terminal' || p.terminal)), 'new workspace inherits global');
    const secondID = (await saved()).current;
    await setDirectory(secondID, '~/other');
    await openSettings(); await saveSettings('~');
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal((await saved()).defaultDirectory, '~'); assert.equal(await override(secondID), '~/other'); assert.equal(await override(wsID), undefined);
    await button('Home directory', page.locator('.file-view:visible').first()).click();
    await waitFor(async () => await page.getByRole('textbox', { name: 'File or directory path', exact: true }).first().inputValue() === otherPath, 'override after reload/global change');
    await page.locator(`.workspace-tab-item[data-workspace="${wsID}"] .workspace-tab`).click();
    await button('Home directory', file).click(); await waitFor(async () => await filePath().inputValue() === home, 'inherited global after reload');
    await page.locator(`.workspace-tab-item[data-workspace="${secondID}"] .workspace-tab`).click();
    await page.locator(`.workspace-tab-item[data-workspace="${wsID}"] .workspace-tab`).click();
    const movedDOM = await file.elementHandle();
    await file.locator('.panel-header').click({ button: 'right' });
    await menuitem('Move to workspace').click(); await menuitem('Workspace 2').click();
    await waitFor(async () => (await saved()).workspaces.find(ws => ws.id === secondID).panels.some(p => p.id === filePanel.id), 'component move');
    await page.locator(`.workspace-tab-item[data-workspace="${secondID}"] .workspace-tab`).click();
    assert.ok(await movedDOM.evaluate(node => node.isConnected)); assert.equal(await filePath().inputValue(), home);
    await button('Home directory', file).click(); await waitFor(async () => await filePath().inputValue() === otherPath, 'moved Home uses destination workspace');
    await navigate(workspacePath); await button('File actions', file).click(); await menuitem('Workspace default').click();
    await waitFor(async () => await override(secondID) === workspacePath, 'moved shortcut updates destination workspace');
    assert.equal(await override(wsID), undefined); await setDirectory(secondID, '~/other');
    for (const theme of ['dark', 'light']) {
        if ((await saved()).theme !== theme) await button('Toggle light or dark theme').click();
        for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.waitForTimeout(250);
            await openDirectory(secondID);
            const box = await dialog('Default directory').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
            await mkdir('test-results', { recursive: true });
            await page.screenshot({ path: `test-results/default-directory-${theme}-${width}.png` });
            await button('Cancel', dialog('Default directory')).click();
            await button('Properties', page.locator('.file-view:visible').first()).click();
            const fieldBox = await dialog('Properties').getByLabel('Permissions', { exact: true }).boundingBox(), buttonBox = await button('Apply', dialog('Properties')).boundingBox();
            assert.ok(buttonBox.x >= fieldBox.x + fieldBox.width && buttonBox.x + buttonBox.width <= width, 'mobile Apply beside input');
            await page.screenshot({ path: `test-results/default-directory-properties-${theme}-${width}.png` });
            await button('Close dialog', dialog('Properties')).click();
        }
    }
    assert.deepEqual(errors, []);
    console.log('PASS persistence, global changes, workspace isolation and desktop/mobile dialogs in both themes');
} catch (error) {
    if (page) { await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/default-directory-failure.png' }); }
    throw error;
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
