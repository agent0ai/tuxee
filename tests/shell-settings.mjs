import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return result.stdout.trim();
};
assert.equal(process.getuid(), 0, 'requires an isolated test account');
const home = await mkdtemp('/tmp/tuxee-shell-user-'), user = `tuxee-shell-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':');
await chown(home, Number(fields[2]), Number(fields[3]));
const profiles = { '.bash_profile': 'source ~/.bashrc\n', '.bashrc': "PS1='SYSTEM> '\n", '.zshrc': "PROMPT='SYSTEM> '\n", '.config/fish/config.fish': "function fish_prompt; printf 'SYSTEM> '; end\n" };
for (const [name, content] of Object.entries(profiles)) { await mkdir(home + '/' + name.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(home + '/' + name, content); }
run('chown', ['-R', `${fields[2]}:${fields[3]}`, home]);
const password = randomBytes(24).toString('base64url');
run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-shell-server-');
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
    const create = async () => { const response = await api('/terminals', 'POST', { columns: 80, rows: 24 }); assert.equal(response.status(), 201); return response.json(); };
    const first = await create();
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'shells', workspaces: [{ id: 'shells', name: 'Shells', columns: 4, rows: 2, active: 'first', panels: [{ id: 'first', kind: 'terminal', terminal: first.id, path: home, x: 0, y: 0, w: 2, h: 2 }] }] })).status(), 200);
    page = await appPage(context); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const shell = dialog.getByLabel('Shell command', { exact: true });
    const prompt = dialog.getByRole('switch', { name: 'Use Tuxee shell prompt', exact: true });
    const open = async () => { await page.getByRole('button', { name: 'User menu', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings', exact: true }).click(); await shell.waitFor(); };
    const close = async () => { await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); };
    const save = async (status = 200) => {
        const response = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click(); assert.equal((await response).status(), status);
        if (status === 200) await dialog.waitFor({ state: 'hidden' });
    };
    await page.goto(base); await page.locator('[data-panel=first] .xterm-rows').filter({ hasText: '❯' }).waitFor();
    await page.locator('[data-panel=first] .xterm-helper-textarea').focus();
    await page.keyboard.type('mkdir -p wrapped-prompt-directory; cd wrapped-prompt-directory'); await page.keyboard.press('Enter');
    await page.locator('[data-panel=first] .xterm-rows').filter({ hasText: '~/wrapped-prompt-directory' }).waitFor();
    const typed = 'w'.repeat(160);
    await page.keyboard.type(`printf '%s' '${typed}' > ../wrapped.txt`);
    await page.keyboard.press('Control+a'); await page.keyboard.type(' '); await page.keyboard.press('Control+e'); await page.keyboard.press('Enter');
    for (let attempt = 0; ; attempt++) {
        try { assert.equal(await readFile(home + '/wrapped.txt', 'utf8'), typed); break; }
        catch (error) { if (attempt === 100) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    await open(); assert.equal(await shell.inputValue(), 'bash'); assert.ok(await prompt.isChecked());
    await shell.fill('zsh'); await prompt.uncheck(); await close();
    await open(); assert.equal(await shell.inputValue(), 'bash'); assert.ok(await prompt.isChecked());
    await shell.fill('fish'); await prompt.uncheck();
    await page.route(base + '/api/settings', route => route.fulfill({ status: 400, json: { error: 'save rejected' } }));
    await save(400); await page.unroute(base + '/api/settings'); await close();
    await open(); assert.equal(await shell.inputValue(), 'bash'); assert.ok(await prompt.isChecked());
    await prompt.uncheck(); await save(); assert.equal((await saved()).useTuxeePrompt, false);
    await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
    await page.locator('.xterm-rows').filter({ hasText: 'SYSTEM>' }).waitFor();
    assert.ok((await page.locator('[data-panel=first] .xterm-rows').innerText()).includes('❯'), 'saved setting must not replace an existing prompt');
    assert.equal((await (await api('/terminals/' + first.id)).json()).pid, first.pid);
    for (const command of ["'/bin/bash' --login", 'zsh', 'fish']) {
        await open(); await shell.fill(command); await prompt.check(); await save();
        const terminal = await create();
        for (let attempt = 0; attempt < 100; attempt++) {
            const executable = run('runuser', ['-u', user, '--', 'readlink', `/proc/${terminal.pid}/exe`]);
            if (executable.endsWith('/' + (command.startsWith("'") ? 'bash' : command))) break;
            if (attempt === 99) assert.fail(`shell did not exec: ${command}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        await api('/terminals/' + terminal.id, 'DELETE');
    }
    await page.reload(); await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    await open(); assert.equal(await shell.inputValue(), 'fish'); assert.ok(await prompt.isChecked());
    await mkdir('test-results', { recursive: true });
    for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await prompt.scrollIntoViewIfNeeded();
        const bounds = await prompt.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        await page.screenshot({ path: `test-results/shell-settings-${width}.png` });
    }
    for (const [name, content] of Object.entries(profiles)) assert.equal(await readFile(home + '/' + name, 'utf8'), content);
    assert.deepEqual(errors, []);
    console.log('PASS default Bash/prompt, wrapped input, save/cancel/failure, retained terminal, new shell commands, persistence, mobile bounds and unchanged dotfiles');
} catch (error) {
    if (page) { await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/shell-settings-failure.png' }); }
    throw error;
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel', [user]); await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
}
