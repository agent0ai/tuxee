import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return result.stdout.trim();
};
assert.equal(process.getuid(), 0);
const state = await mkdtemp('/tmp/tuxee-archives-'); await chmod(state, 0o755);
await copyFile(process.env.TUXEE_TEST_BINARY || './bin/tuxee', state + '/tuxee'); await chmod(state + '/tuxee', 0o755);
const accounts = [];
let server, stopped, base, browser, context, csrf;
const errors = [], logs = [];
async function account(suffix) {
    const name = `tuxee-arc-${process.pid}-${suffix}`, home = state + '/' + suffix;
    await mkdir(home); run('useradd', ['-M', '-d', home, '-s', '/bin/bash', '-c', 'Tuxee prototype test', name]);
    const fields = run('getent', ['passwd', name]).split(':');
    const user = { name, home, uid: Number(fields[2]), gid: Number(fields[3]), password: randomBytes(24).toString('base64url') };
    accounts.push(user); await chown(home, user.uid, user.gid); run('chpasswd', [], `${name}:${user.password}\n`); return user;
}
async function start() {
    server = spawn(state + '/tuxee', ['serve', '--http', '--bind', base ? new URL(base).host : '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => server.once('exit', resolve));
    server.stderr.on('data', data => logs.push(String(data)));
    base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('startup timed out')), 10000);
        server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
        server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
    });
}
async function stop(signal = 'SIGTERM') { server.kill(signal); await stopped; }
const wait = async (check, message) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw Error(message);
};
try {
    const user = await account('a'), other = await account('b');
    await start();
    const env = { ...process.env }; for (const key of ['DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']) delete env[key];
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], env });
    context = await browser.newContext({ viewport: { width: 1280, height: 850 }, permissions:['clipboard-read','clipboard-write'] });
    const login = async (account = user, client = context, language = 'en') => {
        const response = await client.request.post(base + '/api/login', { data: {username:account.name,password:account.password,language}, headers:{'X-Tuxee-Client':'web'} });
        assert.equal(response.status(),200,await response.text()); return (await response.json()).csrf;
    };
    csrf = await login();
    const api = (path, method='GET', data) => context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-CSRF':csrf,'X-Tuxee-Client':'web'}});
    const json = async (path, method='GET', data, status=200) => { const response=await api(path,method,data); assert.equal(response.status(),status,await response.text()); return response.json(); };
    const create = (command, name='Archive fixture') => json('/terminals','POST',{directory:user.home,columns:80,rows:24,command,name},201);
    const output = id => json(`/terminals/${id}/archive`);
    const folder = id => `${user.home}/.local/state/tuxee/terminals/${id}`;
    const disk = async id => ({ normal: { text: await readFile(folder(id)+'/normal.txt', 'utf8') } });
    const ended = id => wait(async()=>{const info=await json(`/terminals/${id}`);return info.exited && info;},'terminal did not end');
    let settings={theme:'dark',current:'archive',workspaces:[{id:'archive',name:'Archives',columns:4,rows:2,active:'primary',panels:[]}]};
    const mount = async id => {
        settings.workspaces[0].panels=[{id:'primary',kind:'terminal',terminal:id,path:user.home,x:0,y:0,w:4,h:2}];
        await json('/settings','PUT',settings);
    };
    const natural=await create("printf 'UNICODE 界 🦊 é\\n'; for i in $(seq 1 200); do printf '%080d\\n' $i; done; sleep 1");
    await json(`/terminals/${natural.id}/input-history`,'POST',{text:'original\n日本語 🦊'});
    await ended(natural.id);
    const saved=await output(natural.id); assert.ok(saved.normal.text.includes('UNICODE 界 🦊 é')); assert.equal(saved.active,'normal');
    assert.deepEqual(JSON.parse(await readFile(folder(natural.id)+'/input-history.json')),['original\n日本語 🦊']);
    for (const file of ['meta.json','input-history.json','normal.txt','output.json']) {
        const info=await stat(folder(natural.id)+'/'+file); assert.equal(info.uid,user.uid); assert.equal(info.mode & 0o777,0o600);
    }
    const second=await browser.newContext(); const otherCSRF=await login(other,second);
    for (const suffix of ['', '/archive']) assert.equal((await second.request.get(`${base}/api/terminals/${natural.id}${suffix}`)).status(),404);
    assert.equal((await second.request.delete(`${base}/api/terminals/${natural.id}`,{headers:{'X-Tuxee-CSRF':otherCSRF,'X-Tuxee-Client':'web'}})).status(),404);
    assert.equal((await context.request.delete(`${base}/api/terminals/${natural.id}`,{headers:{'X-Tuxee-Client':'web'}})).status(),403);
    await second.close();
    await chmod(folder(natural.id)+'/meta.json',0);
    for (const [path,method] of [[`/terminals/${natural.id}/archive`,'GET'],[`/terminals/${natural.id}`,'DELETE']]) {
        assert.equal((await api(path,method)).status(),500,'storage errors must not masquerade as missing archives');
    }
    await chmod(folder(natural.id)+'/meta.json',0o600);
    await mount(natural.id);
    const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message)); page.setDefaultTimeout(10000);
    await page.goto(base); await page.locator('.terminal-archive pre').waitFor();
    assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.normal.text);
    assert.equal(await page.locator('.terminal-footer:visible [data-action=browse-shell-folder]').count(),0);
    assert.equal(await page.locator('.terminal-footer:visible button').count(),3);
    assert.equal(await page.locator('.terminal-dead-label').textContent(),'Post mortem');
    await page.locator('.terminal-archive pre').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),saved.normal.text);
    await mkdir('test-results',{recursive:true});
    for (const theme of ['dark','light']) for (const width of [1280,390,320]) {
        settings.theme=theme; await json('/settings','PUT',settings); await page.setViewportSize({width,height:850}); await page.reload(); await page.locator('.terminal-archive pre').waitFor();
        if (width<400) assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>{p.scrollLeft=100;return p.scrollLeft>0;}),'fixed columns must scroll horizontally');
        assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollHeight>p.clientHeight),'history must scroll vertically');
        await page.getByRole('button',{name:'Jump to top',exact:true}).click();
        assert.equal(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollTop),0);
        await page.getByRole('button',{name:'Jump to bottom',exact:true}).click();
        assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollTop>0));
        assert.equal(await page.locator('.terminal-archive pre').evaluate(p=>getComputedStyle(p).color), await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--text').trim()).then(c=>page.evaluate(c=>{const e=document.createElement('span');e.style.color=c;document.body.append(e);const color=getComputedStyle(e).color;e.remove();return color;},c)));
        const bounds=await page.locator('.terminal-archive .terminal-footer').evaluate(f=>({width:f.clientWidth,scroll:f.scrollWidth})); assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
        await page.screenshot({path:`test-results/terminal-archive-${theme}-${width}.png`});
    }
    await page.setViewportSize({width:1280,height:850});
    let created = 0;
    page.on('response', response => { if (response.url()===base+'/api/terminals' && response.request().method()==='POST' && response.status()===201) created++; });
    await page.route(base+'/api/terminals', route=>route.request().method()==='POST' ? route.fulfill({status:409,json:{error:'Test archive create failure'}}) : route.continue());
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Test archive create failure',{exact:true}).waitFor();
    assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.normal.text);
    await page.unroute(base+'/api/terminals');
    await page.route(base+'/api/settings', route=>route.request().method()==='PUT' ? route.fulfill({status:409,json:{error:'Test archive save failure'}}) : route.continue());
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Test archive save failure',{exact:true}).waitFor();
    assert.equal(created,1);
    await page.unroute(base+'/api/settings');
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal(created,1,'retry must save the existing replacement');
    const replacement=(await json('/me')).settings.workspaces[0].panels[0].terminal;
    assert.notEqual(replacement,natural.id); assert.deepEqual(await json(`/terminals/${replacement}/input-history`),[]);
    assert.deepEqual(await output(natural.id),saved); assert.equal((await json(`/terminals/${natural.id}`)).closedAt,undefined);
    const openRetained=async()=>{ await page.getByRole('button',{name:'User menu',exact:true}).click(); await page.getByRole('menuitem',{name:'Retained terminals',exact:true}).click(); };
    await openRetained();
    const dialog=page.getByRole('dialog',{name:'Retained terminals',exact:true});
    const row=dialog.locator('.retained-row').filter({hasText:'Archive fixture'}); await row.getByRole('button',{name:'Close',exact:true}).click();
    await dialog.getByRole('tab',{name:'Closed',exact:true}).click(); await dialog.locator('.retained-row').filter({hasText:'Archive fixture'}).getByRole('button',{name:'Open',exact:true}).waitFor();
    assert.ok((await json(`/terminals/${natural.id}`)).closedAt); assert.deepEqual(await output(natural.id),saved);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'User menu',exact:true}).click(); await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
    const retention=page.locator('[name=closedTerminalHistoryHours]'); assert.equal(await retention.inputValue(),'168'); await retention.fill('72');
    await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await wait(async()=> (await json('/me')).settings.closedTerminalHistoryHours===72,'retention save');
    assert.equal((await api('/settings','PUT',{...settings,closedTerminalHistoryHours:-1})).status(),400);
    assert.equal((await api('/settings','PUT',{...settings,closedTerminalHistoryHours:1.5})).status(),400);
    await page.close();
    const killed=await create("printf 'KILLED_OUTPUT\\n'; sleep 300",'Killed');
    await wait(async()=> (await output(killed.id))?.normal.text.includes('KILLED_OUTPUT'),'kill output'); process.kill(killed.pid,'SIGKILL'); await ended(killed.id);
    assert.ok((await output(killed.id)).normal.text.includes('KILLED_OUTPUT')); assert.equal((await json(`/terminals/${killed.id}`)).closedAt,undefined);
    const mc=await create("printf 'BEFORE_MC\\n'; mc; printf 'AFTER_MC\\n'",'Midnight Commander');
    await mount(mc.id);
    const mcPage=await context.newPage(); mcPage.on('pageerror',error=>errors.push(error.message)); await mcPage.goto(base); await mcPage.locator('.terminal-view[data-state=connected]').waitFor();
    await wait(async()=>{ const a=await output(mc.id); return a?.active==='alternate' && a.alternate?.text.includes('Help'); },'real MC did not render');
    await mcPage.locator('.xterm-helper-textarea').focus(); await mcPage.keyboard.press('F10');
    await ended(mc.id); await mcPage.locator('.terminal-archive').waitFor();
    const mcArchive=await output(mc.id); assert.equal(mcArchive.active,'normal'); assert.ok(mcArchive.normal.text.includes('BEFORE_MC')); assert.ok(mcArchive.normal.text.includes('AFTER_MC')); assert.ok(mcArchive.alternate.text.includes('Help'));
    await mcPage.locator('.terminal-archive select').selectOption('alternate'); assert.equal(await mcPage.locator('.terminal-archive pre').textContent(),mcArchive.alternate.text);
    await mcPage.screenshot({path:'test-results/terminal-archive-mc.png'}); await mcPage.close();
    const shutdown=await create("printf 'SHUTDOWN_OUTPUT\\n'; trap 'printf \"\\033[2J\"; exit' HUP TERM; while :; do sleep 1; done",'Shutdown');
    await wait(async()=> (await output(shutdown.id))?.normal.text.includes('SHUTDOWN_OUTPUT'),'shutdown output');
    await mount(shutdown.id); await stop(); await start(); csrf=await login();
    assert.equal((await json('/me')).settings.workspaces[0].panels[0].terminal,shutdown.id);
    assert.ok((await output(shutdown.id)).normal.text.includes('SHUTDOWN_OUTPUT')); assert.equal((await json(`/terminals/${shutdown.id}`)).closedAt,undefined);
    const crash=await create("printf 'CRASH_CHECKPOINT\\n'; sleep 300",'Crash');
    await wait(async()=>{try{return (await disk(crash.id)).normal.text.includes('CRASH_CHECKPOINT');}catch{return false;}},'periodic checkpoint missing');
    await stop('SIGKILL'); await start(); csrf=await login();
    assert.ok((await output(crash.id)).normal.text.includes('CRASH_CHECKPOINT')); assert.equal((await json(`/terminals/${crash.id}`)).closedAt,undefined);
    const metadata=JSON.parse(await readFile(folder(natural.id)+'/meta.json')); metadata.closedAt=new Date(Date.now()-169*3600000).toISOString();
    await writeFile(folder(natural.id)+'/meta.json',JSON.stringify(metadata));
    csrf=await login(); assert.equal((await api(`/terminals/${natural.id}`)).status(),404);
    assert.ok((await output(crash.id)).normal.text.includes('CRASH_CHECKPOINT'),'unclosed archives must never expire');
    const registry=JSON.parse(await readFile(state+'/state/terminal-accounts.json')); assert.equal(registry[user.name],user.uid); assert.equal(registry[other.name],other.uid);
    await mount(mc.id);
    const mobile=await context.newPage(); mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.setViewportSize({width:320,height:700});
    for (const [index,file] of (await readdir('internal/i18n/locales')).entries()) {
        if (index===20) { console.log('Waiting for the real login rate-limit window before remaining languages.'); await new Promise(resolve=>setTimeout(resolve,60000)); }
        const language=file.replace('.json',''); csrf=await login(user,context,language);
        await mobile.goto(base); await mobile.locator('.terminal-archive pre').waitFor();
        await mobile.locator('.terminal-archive select').selectOption('alternate');
        const bounds=await mobile.locator('.terminal-archive .terminal-footer').evaluate(f=>({width:f.clientWidth,scroll:f.scrollWidth}));
        assert.ok(bounds.scroll<=bounds.width+1,language+': '+JSON.stringify(bounds));
        assert.equal(await mobile.locator('.terminal-archive pre').textContent(),mcArchive.alternate.text);
        if (['ar','cs'].includes(language)) await mobile.screenshot({path:`test-results/terminal-archive-${language}-320.png`});
    }
    await mobile.close();
    assert.deepEqual(errors,[]);
    console.log('Terminal archives: Unicode/copy, natural exit, shell kill, MC, restart, closed retention, permissions, crash and shutdown passed.');
} catch (error) {
    console.error(logs.join('')); throw error;
} finally {
    await browser?.close(); if (server?.exitCode===null && server?.signalCode===null) await stop();
    for (const user of accounts.reverse()) { spawnSync('pkill',['-KILL','-u',String(user.uid)]); run('userdel',[user.name]); }
    await rm(state,{recursive:true,force:true});
}
