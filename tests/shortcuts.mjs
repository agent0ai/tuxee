import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({ entryPoints: ['web/shortcuts.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const shortcuts = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const defaults = shortcuts.bindings();
assert.equal(Object.keys(defaults).length, 30);
for (const [id, slots] of Object.entries(defaults)) for (const [index, sequence] of slots.entries()) assert.equal(shortcuts.shortcutConflict(defaults, sequence, id, index), undefined);
for (const [first, second] of Object.values(defaults)) {
    assert.equal(first.length, 1); assert.ok(first[0].startsWith('Alt+Shift+')); assert.deepEqual(second, []);
}
assert.deepEqual(shortcuts.bindings({'app.about': [['Control+Shift+Space','KeyI'], []]})['app.about'], [['Control+Shift+Space','KeyI'], []], 'saved bindings remain unchanged');
assert.deepEqual(shortcuts.bindings({'app.about': [[], []]})['app.about'], [[], []]);
assert.equal(shortcuts.shortcutConflict(defaults, ['Alt+Shift+Enter','KeyA'], 'app.about', 1).id, 'panel.terminal');
assert.equal(shortcuts.shortcutLabel(['Alt+Meta+KeyA'], 'MacIntel'), 'Option+Cmd+A');
assert.equal(shortcuts.shortcutLabel(['Meta+KeyA'], 'Linux x86_64'), 'Super+A');
assert.equal(shortcuts.shortcutLabel(['Meta+KeyA'], 'Win32'), 'Win+A');
for (const stroke of ['Control+KeyA', 'Alt+KeyA', 'Shift+Meta+KeyA', 'F12']) assert.ok(shortcuts.validStart(stroke));
for (const stroke of ['KeyA', 'Shift+KeyA', 'Space', 'F13']) assert.ok(!shortcuts.validStart(stroke));
const key = { code: 'KeyA', key: 'a', ctrlKey: true, getModifierState: () => false };
assert.equal(shortcuts.shortcutStroke(key), 'Control+KeyA');
for (const event of [{ ...key, isComposing: true }, { ...key, key: 'Dead' }, { ...key, getModifierState: () => true }]) assert.equal(shortcuts.shortcutStroke(event), undefined);

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
assert.equal(process.getuid(), 0);
const home = await mkdtemp('/tmp/tuxee-shortcuts-user-'), user = `tuxee-keys-${process.pid}`;
run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]);
const fields = run('getent', ['passwd', user]).split(':'); await chown(home, Number(fields[2]), Number(fields[3]));
for (const name of ['first.txt','second.txt']) { await writeFile(`${home}/${name}`,name); await chown(`${home}/${name}`,Number(fields[2]),Number(fields[3])); }
const password = randomBytes(24).toString('base64url'); run('chpasswd', [], `${user}:${password}\n`);
const state = await mkdtemp('/tmp/tuxee-shortcuts-server-');
await chmod(state, 0o755); await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let lastLogin = 0;
    const login = async language => { await new Promise(resolve => setTimeout(resolve, Math.max(0, 2100 - (Date.now() - lastLogin)))); lastLogin = Date.now(); const response = await context.request.post(base + '/api/login', { data: { username: user, password, language }, headers: { 'X-Tuxee-Client': 'web' } }); assert.equal(response.status(), 200); return (await response.json()).csrf; };
    let csrf = await login('en');
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' } });
    const saved = async () => (await (await api('/me')).json()).settings;
    const workspaces = Array.from({ length: 10 }, (_, i) => ({ id: `ws${10-i}`, name: `Desktop ${i + 1}`, columns: 4, rows: 2, active: `files${i}`, panels: [{ id: `files${i}`, kind: 'files', path: home, x: 0, y: 0, w: 4, h: 2 }] }));
    const initial = { theme: 'dark', current: workspaces[0].id, workspaces };
    assert.equal((await api('/settings', 'PUT', { ...initial, shortcuts: defaults })).status(), 200);
    assert.equal((await api('/settings', 'PUT', initial)).status(), 200);
    await context.addInitScript(() => {
        window.shortcutKeyLog = [];
        window.addEventListener('keydown', e => window.shortcutKeyLog.push({ code:e.code, alt:e.altKey, ctrl:e.ctrlKey, shift:e.shiftKey, altGraph:e.getModifierState('AltGraph'), repeat:e.repeat, target:e.target.className, active:e.target.getAttribute?.('aria-label'), time:performance.now() }), true);
        window.shortcutInputs = [];
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function(value) {
            if (this.url.includes('/terminals/') && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) window.shortcutInputs.push(Array.from(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer,value.byteOffset,value.byteLength)));
            return send.call(this, value);
        };
    });
    const page = await appPage(context); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.locator('.user-menu-button').waitFor();
    const hotkey = key => page.keyboard.press(`Alt+Shift+${key}`);
    const waitActive = name => page.waitForFunction(name => document.querySelector('.workspace-tab.active')?.getAttribute('aria-label') === name, name);
    for (let n = 1; n <= 10; n++) {
        await hotkey(String(n % 10));
        try { await waitActive(`Desktop ${n}`); }
        catch(error) { console.log({n,keys:await page.evaluate(() => window.shortcutKeyLog.slice(-20)),dialogs:await page.locator('dialog[open]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),active:await page.locator('.workspace-tab.active').allTextContents()}); throw error; }
    }
    await hotkey('ArrowRight'); await waitActive('Desktop 1');
    await hotkey('ArrowLeft'); await waitActive('Desktop 10');
    await hotkey('1'); await waitActive('Desktop 1');
    await page.locator('.workspace-tab.active[aria-keyshortcuts]').press('Alt+ArrowRight');
    try {
        await page.waitForFunction(() => document.querySelector('.workspace-tabs .visible-tabs .workspace-tab')?.getAttribute('aria-label') === 'Desktop 2');
        await hotkey('1'); await waitActive('Desktop 2');
    } catch(error) { console.log(await page.evaluate(() => window.shortcutKeyLog.slice(-25)), await page.locator('.workspace-tabs .visible-tabs .workspace-tab').allTextContents()); throw error; }
    await hotkey('2'); await waitActive('Desktop 1');
    await page.locator('[data-panel=files0] .file-entry').filter({hasText:'second.txt'}).click();
    await page.keyboard.down('Alt'); assert.equal(await page.locator(':popover-open').count(), 0); await page.keyboard.up('Alt');
    for (const key of ['ContextMenu','Shift+F10']) {
        await page.keyboard.press(key); await page.locator('.popover-menu:popover-open').waitFor(); await page.keyboard.press('Escape');
    }
    await hotkey('Enter'); await page.locator('.terminal-view[data-state=connected]').waitFor();
    const terminal = page.locator('.xterm-helper-textarea'); await terminal.focus();
    await page.keyboard.type("printf 'SHORTCUT_INPUT_OK\\n'"); await page.keyboard.press('Enter');
    await page.locator('.xterm-rows').filter({ hasText: 'SHORTCUT_INPUT_OK' }).waitFor();
    const focused = () => page.evaluate(() => document.activeElement?.closest('[data-panel]')?.dataset.panel);
    const termID = await focused(); assert.ok(termID && termID !== 'files0');
    await page.evaluate(() => window.shortcutInputs = []);
    await hotkey('ArrowDown'); assert.equal(await focused(), 'files0');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), home+'/second.txt');
    await hotkey('ArrowUp'); assert.equal(await focused(), termID);
    assert.deepEqual(await page.evaluate(() => window.shortcutInputs), [], 'shortcuts must send no PTY bytes');
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.shortcutInputs.length > 0);
    assert.deepEqual(await page.evaluate(() => window.shortcutInputs), [[3]], 'ordinary Ctrl+C remains terminal input');
    await hotkey('f'); assert.equal(await page.locator('.file-view').count(), 2);
    const fileID = await focused(), filePanel = page.locator(`[data-panel="${fileID}"]`);
    await filePanel.locator('.file-entry').filter({hasText:'first.txt'}).dblclick();
    await filePanel.locator('.cm-content').fill('unsaved shortcut edit');
    await hotkey('w');
    const discard = page.getByRole('dialog', {name:'Discard changes?', exact:true, includeHidden:true}); await discard.waitFor();
    await page.keyboard.press('Escape'); await discard.waitFor({state:'detached'});
    assert.equal(await filePanel.locator('.cm-content').textContent(), 'unsaved shortcut edit');
    await hotkey('w'); await discard.waitFor(); await discard.getByRole('button', {name:'Discard', exact:true}).click();
    await filePanel.waitFor({state:'detached'});
    assert.equal(await readFile(home+'/first.txt', 'utf8'), 'first.txt');
    assert.equal(await page.locator('[data-panel=files0]').count(), 1);
    assert.equal(await page.locator(`[data-panel="${termID}"]`).count(), 1);
    await hotkey('f'); assert.equal(await page.locator('.file-view').count(), 2);
    await terminal.focus(); await page.mouse.move(0, 0);
    await page.evaluate(() => window.shortcutInputs = []);
    for (const mode of [1, 2, 3, 0]) {
        await hotkey('a');
        const arrange = page.locator('.layout-cycle');
        assert.equal(await arrange.getAttribute('data-mode'), String(mode));
        assert.equal(await arrange.locator('.layout-label').textContent(), ['Custom', 'Balanced', 'Terminals', 'Files'][mode]);
        assert.ok(await arrange.evaluate(node => node.classList.contains('expanded')), 'layout shortcut reveals the mode label');
        await page.waitForFunction(() => document.querySelector('.layout-label')?.getBoundingClientRect().width > 0);
        assert.equal(await focused(), termID, 'layout shortcut preserves terminal focus');
        await page.waitForFunction(() => document.querySelector('.layout-label')?.getBoundingClientRect().width === 0);
    }
    assert.deepEqual(await page.evaluate(() => window.shortcutInputs), [], 'layout shortcuts must send no PTY bytes');
    await hotkey('v'); assert.equal(await page.locator('.volume-toggle').getAttribute('aria-label'), 'Audio: muted');
    await hotkey('v'); assert.equal(await page.locator('.volume-toggle').getAttribute('aria-label'), 'Audio: 100%');
    await hotkey('PageDown'); assert.equal(await page.locator('.volume-toggle').getAttribute('aria-label'), 'Audio: 95%');
    await hotkey('PageUp'); assert.equal(await page.locator('.volume-toggle').getAttribute('aria-label'), 'Audio: 100%');
    for (const [key, title] of [['m','Resource monitor'],['h','About Tuxee'],['s','Settings'],['r','Retained terminals'],['x','Restart Tuxee?']]) {
        await hotkey(key); const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor();
        await hotkey('Enter'); assert.equal(await page.locator('.terminal-view').count(), 1, 'modal must block application shortcuts');
        await hotkey('w'); assert.equal(await page.locator('.file-view').count(), 2, 'modal must block panel closure');
        await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    }
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.down('s');
    const settingName = page.locator('dialog[open] [name=serverName]'); await settingName.waitFor(); await settingName.focus();
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await page.keyboard.down('s'); await page.keyboard.up('s'); assert.equal(await settingName.inputValue(), '', 'held shortcut must not type into its new dialog');
    await page.keyboard.press('Escape');
    const open = async () => { await page.locator('.user-menu-button').click(); await page.locator('.account-menu [data-action=Keyboard]').click(); };
    const editor = page.locator('.shortcuts-modal'), recorder = page.locator('.shortcut-record-modal');
    await hotkey('k'); await editor.waitFor(); assert.equal(await editor.locator('[data-shortcut]').count(), 30);
    await editor.locator('[data-shortcut="app.about"] th').dblclick(); await recorder.waitFor();
    await hotkey('h');
    assert.equal(await recorder.locator('output').textContent(), 'Alt+Shift+H');
    await page.keyboard.press('Escape'); await recorder.waitFor({ state: 'hidden' });
    const record = async (action, slot = 1) => { await editor.locator(`[data-shortcut="${action}"] [data-slot="${slot}"]`).click(); await recorder.waitFor(); };
    const save = async (status = 200) => {
        const response = page.waitForResponse(r => r.url() === base + '/api/settings' && r.request().method() === 'PUT');
        await recorder.getByRole('button', { name: 'Save', exact: true }).click(); assert.equal((await response).status(), status);
        if (status === 200) await recorder.waitFor({ state: 'hidden' });
    };
    await record('app.about'); await hotkey('Enter');
    assert.ok(await recorder.getByRole('button',{name:'Save',exact:true}).isDisabled(), 'duplicate conflict');
    await page.keyboard.press('a'); assert.ok(await recorder.getByRole('button',{name:'Save',exact:true}).isDisabled(), 'prefix conflict');
    await recorder.getByRole('button',{name:'Clear',exact:true}).click();
    await page.keyboard.press('z'); assert.ok((await recorder.locator('p').last().textContent()).includes('Start with'));
    await page.keyboard.press('Control+Shift+u'); await save();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.slot), '1');
    assert.deepEqual((await saved()).shortcuts['app.about'][1], ['Control+Shift+KeyU']);
    await record('app.settings'); await page.keyboard.press('Control+Shift+y');
    await page.route(base + '/api/settings', route => route.fulfill({ status:400, json:{error:'save rejected'} }));
    await save(400); await page.unroute(base + '/api/settings'); await page.keyboard.press('Escape');
    assert.equal((await saved()).shortcuts['app.settings'], undefined);
    await record('app.about'); await page.keyboard.press('Control+Shift+j'); await page.keyboard.press('Escape');
    await editor.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.keyboard.press('Control+Shift+u'); await page.getByRole('dialog',{name:'About Tuxee',exact:true}).waitFor(); await page.keyboard.press('Escape');
    await page.reload(); await page.locator('.user-menu-button').waitFor();
    await page.keyboard.press('Control+Shift+u'); await page.getByRole('dialog',{name:'About Tuxee',exact:true}).waitFor(); await page.keyboard.press('Escape');
    const disk = JSON.parse(await readFile(home + '/.config/tuxee/settings.json','utf8')); assert.deepEqual(disk.shortcuts, (await saved()).shortcuts);
    await open();
    await record('app.about', 0);
    assert.ok(await recorder.getByRole('button',{name:'Save',exact:true}).isDisabled());
    await page.keyboard.press('Control+Shift+j'); await page.keyboard.press('a'); await page.keyboard.press('b'); await page.keyboard.press('c');
    assert.equal(await recorder.locator('output').textContent(),'Ctrl+Shift+J → A → B');
    await save();
    await editor.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.keyboard.press('Control+Shift+j');
    assert.equal(await page.locator('dialog[open]').count(), 0, 'an unrelated shorter second binding must not complete the first');
    await page.locator('.shortcut-pending').waitFor();
    await page.keyboard.press('a'); assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.keyboard.press('b');
    await page.getByRole('dialog',{name:'About Tuxee',exact:true}).waitFor(); await page.keyboard.press('Escape');
    await terminal.focus(); await page.keyboard.press('Control+Shift+j'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.shortcut-pending').count(), 0);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.keyboard.press('Control+Shift+j'); await page.waitForTimeout(2200); assert.equal(await page.locator('.shortcut-pending').count(), 0);
    await open(); await record('app.about',0); await recorder.getByRole('button',{name:'Reset',exact:true}).click(); await save();
    assert.deepEqual((await saved()).shortcuts['app.about'][0], defaults['app.about'][0]);
    await record('app.about'); await recorder.getByRole('button',{name:'Clear',exact:true}).click(); await save();
    await editor.getByRole('button',{name:'Close dialog',exact:true}).click();
    const terminalID = (await saved()).workspaces.flatMap(ws => ws.panels).find(panel => panel.id === termID).terminal;
    await terminal.focus(); await hotkey('w');
    await page.locator(`[data-panel="${termID}"]`).waitFor({state:'detached'});
    await page.waitForFunction(async id => (await (await fetch(`/api/terminals/${id}`)).json()).exited, terminalID);
    assert.equal(await page.locator('.file-view').count(), 2, 'closing the terminal preserves file panels');
    await page.setViewportSize({width:390,height:850});
    await page.locator('#app.compact').waitFor();
    await hotkey('a');
    await page.setViewportSize({width:1440,height:900});
    await page.waitForFunction(() => document.querySelector('.layout-cycle')?.dataset.mode === '1');
    await page.setViewportSize({width:390,height:850});
    await page.locator('#app.compact').waitFor();
    await hotkey('ArrowDown');
    assert.equal(await page.locator('.component-tab.active').getAttribute('data-component-name'), await focused());
    await hotkey('ArrowUp');
    assert.equal(await page.locator('.component-tab.active').getAttribute('data-component-name'), await focused());
    await hotkey('f'); const compactClosed = await focused(); await hotkey('w');
    await page.locator(`[data-panel="${compactClosed}"]`).waitFor({state:'detached'});
    assert.equal(await page.locator('.file-view').count(), 2);
    await hotkey('d'); await waitActive('Desktop 11');
    await hotkey('ArrowDown'); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await page.keyboard.type("printf 'DESKTOP_CLOSE_OK\\n'"); await page.keyboard.press('Enter');
    await page.locator('.xterm-rows').filter({hasText:'DESKTOP_CLOSE_OK'}).waitFor();
    const desktopTerminal = (await (await api('/terminals')).json()).find(info => !info.exited); assert.ok(desktopTerminal);
    await hotkey('c');
    const closeDesktop = page.getByRole('dialog',{name:'Close Desktop 11?',exact:true,includeHidden:true}); await closeDesktop.waitFor();
    await page.keyboard.press('Escape'); await closeDesktop.waitFor({state:'detached'}); await waitActive('Desktop 11');
    assert.equal((await (await api(`/terminals/${desktopTerminal.id}`)).json()).exited,false);
    await hotkey('c'); await closeDesktop.waitFor(); await closeDesktop.getByRole('button',{name:'Close desktop',exact:true}).click();
    await waitActive('Desktop 10');
    await page.waitForFunction(async id => (await (await fetch(`/api/terminals/${id}`)).json()).exited,desktopTerminal.id);
    await hotkey('q'); await page.locator('.login-page').waitFor();
    csrf = await login('cs'); await page.reload(); await page.locator('.user-menu-button').waitFor();
    await open(); assert.equal(await editor.getAttribute('aria-label'),'Zkratky');
    await mkdir('test-results',{recursive:true});
    for (const theme of ['dark','light']) for (const width of [1440,390,320]) {
        await page.setViewportSize({width,height:900}); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const bounds = await editor.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.ok(await editor.evaluate(node => node.scrollWidth <= node.clientWidth));
        await page.screenshot({path:`test-results/shortcuts-${theme}-${width}.png`});
    }
    await editor.locator('[data-shortcut="app.about"] [data-slot="1"]').click();
    await page.keyboard.press('Meta+Alt+u'); assert.ok((await recorder.locator('output').textContent()).includes('Super'));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.goto('about:blank');
    csrf = await login('en');
    await page.addInitScript(() => Object.defineProperty(navigator, 'platform', {value:'MacIntel', configurable:true}));
    await page.goto(base); await page.locator('.user-menu-button').waitFor();
    await hotkey('h'); await page.getByRole('dialog',{name:'About Tuxee',exact:true}).waitFor(); await page.keyboard.press('Escape');
    await open(); assert.equal(await editor.locator('[data-shortcut="app.about"] [data-slot="0"]').textContent(),'Option+Shift+H');
    await record('app.about'); await page.keyboard.press('Meta+Alt+u');
    assert.equal(await recorder.locator('output').textContent(),'Option+Cmd+U'); await save();
    await page.keyboard.press('Escape'); await page.keyboard.press('Meta+Alt+u');
    await page.getByRole('dialog',{name:'About Tuxee',exact:true}).waitFor(); await page.keyboard.press('Escape');
    const checkPanelOrder = async (rectangles, order, width, height) => {
        await page.goto('about:blank');
        await page.setViewportSize({width,height});
        const panels = rectangles.map(([id,x,y,w,h]) => ({id,kind:'files',path:home,x,y,w,h})).reverse();
        const settings = {...await saved(), current:'ordered', workspaces:[{id:'ordered',name:'Ordered',columns:4,rows:2,active:order[0],panels}]};
        assert.equal((await api('/settings','PUT',settings)).status(),200);
        await page.goto(base); await page.locator('.user-menu-button').waitFor();
        for (const id of [...order.slice(1),order[0]]) {
            await hotkey('ArrowDown'); assert.equal(await focused(),id,`next at ${width}x${height}`);
        }
        for (const id of [...order.slice(1).reverse(),order[0]]) {
            await hotkey('ArrowUp'); assert.equal(await focused(),id,`previous at ${width}x${height}`);
        }
        await page.waitForResponse(response => response.url() === base+'/api/settings' && response.request().method() === 'PUT');
    };
    const cells = Array.from({length:8},(_,i) => [String(i+1),Math.floor(i/2),i%2,1,1]);
    const merged = [['A',0,0,2,1],['B',2,0,2,1],['C',0,1,1,1],['D',1,1,1,1],['E',2,1,1,1],['F',3,1,1,1]];
    for (const [width,height] of [[1440,900],[900,1440],[390,850]]) {
        await checkPanelOrder(cells, [...'12345678'], width, height);
        await checkPanelOrder(merged, [...'ACDBEF'], width, height);
    }
    console.log('shortcuts: spatial panel order, merged cells, reverse/wrap, portrait and compact passed');
    for (const file of await readdir('internal/i18n/locales')) {
        const code=file.replace('.json',''), catalog=JSON.parse(await readFile('internal/i18n/locales/'+file,'utf8')).texts;
        await page.goto('about:blank'); csrf=await login(code); await page.goto(base); await page.locator('.user-menu-button').waitFor();
        await open(); assert.equal(await editor.getAttribute('aria-label'),catalog['shortcuts.title']);
        await page.setViewportSize({width:320,height:850});
        assert.ok(await editor.evaluate(node => [...node.querySelectorAll('button,th,td')].every(el => el.scrollWidth <= el.clientWidth+1)), `shortcuts bounds: ${code}`);
        await editor.locator('[data-shortcut="app.about"] [data-slot="1"]').click(); await page.keyboard.press('Control+Shift+u');
        assert.ok(await recorder.evaluate(node => node.scrollWidth <= node.clientWidth), `recorder bounds: ${code}`);
        if (code==='ar') await page.screenshot({path:'test-results/shortcuts-ar-recorder.png'});
        console.log(`shortcuts: ${code} labels and compact bounds passed`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS single-chord Alt+Shift defaults/actions, preserved custom sequences, reordered desktops 1–10, spatial panel cycling, panel focus/closure, unsaved-edit protection, terminal termination, confirmed desktop closure, audio, modal isolation, recorder/conflicts, both slots, save/cancel/failure, disk/reload/login persistence, Czech and compact themes');
} finally {
    await browser?.close(); server.kill('SIGTERM'); await stopped;
    run('userdel',['-f',user]); await rm(home,{recursive:true,force:true}); await rm(state,{recursive:true,force:true});
}
