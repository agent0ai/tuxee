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
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'], env });
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
    const disk = async id => ({ text: await readFile(folder(id)+'/output.txt', 'utf8') });
    const ended = id => wait(async()=>{const info=await json(`/terminals/${id}`);return info.exited && info;},'terminal did not end');
    let settings={theme:'dark',current:'archive',workspaces:[{id:'archive',name:'Archives',columns:4,rows:2,active:'primary',panels:[]}]};
    const mount = async id => {
        settings.workspaces[0].panels=[{id:'primary',kind:'terminal',terminal:id,path:user.home,x:0,y:0,w:4,h:2}];
        await json('/settings','PUT',settings);
    };
    const usagePage = await context.newPage(); usagePage.on('pageerror', error => errors.push(error.message));
    for (const used of [false, true]) {
        const terminal = await create('', used ? 'Arrow input' : 'Untouched');
        await mount(terminal.id); await usagePage.goto(base);
        await usagePage.locator('.terminal-view[data-state=connected]').waitFor();
        await usagePage.locator('.xterm-screen').click();
        await usagePage.setViewportSize({width:1100,height:800});
        await usagePage.reload(); await usagePage.locator('.terminal-view[data-state=connected]').waitFor();
        assert.ok((await output(terminal.id)).text.trim(), 'shell startup produced output');
        assert.equal(JSON.parse(await readFile(folder(terminal.id)+'/meta.json')).used, false, 'startup, focus, resize and reconnect are not use');
        if (used) {
            await usagePage.locator('.xterm-helper-textarea').focus(); await usagePage.keyboard.press('ArrowUp');
            await wait(async()=>{await output(terminal.id);return JSON.parse(await readFile(folder(terminal.id)+'/meta.json')).used;},'accepted key did not mark terminal used');
        }
        const closed = usagePage.waitForResponse(response=>response.url()===base+`/api/terminals/${terminal.id}` && response.request().method()==='DELETE');
        await usagePage.getByRole('button',{name:'Close panel',exact:true}).click();
        assert.equal((await closed).status(),200);
        await usagePage.goto('about:blank');
        assert.equal((await json('/terminals')).some(info=>info.id===terminal.id),used);
        if (used) {
            assert.ok((await json(`/terminals/${terminal.id}`)).closedAt);
            await json(`/terminals/${terminal.id}/archive`,'DELETE');
        } else {
            assert.equal((await api(`/terminals/${terminal.id}`)).status(),404);
            await assert.rejects(stat(folder(terminal.id)),{code:'ENOENT'});
        }
    }
    await usagePage.close();
    console.log('PASS unused closure removes files; focus/resize/reload do not count, one arrow key preserves an archive');
    const natural=await create("printf 'UNICODE 界 🦊 é\\n'; for i in $(seq 1 200); do printf '%080d\\n' $i; done; sleep 1");
    await json(`/terminals/${natural.id}/input-history`,'POST',{text:'original\n日本語 🦊'});
    const naturalInfo=await ended(natural.id);
    assert.ok(natural.startedAt && naturalInfo.terminatedAt);
    assert.equal(naturalInfo.startedAt,natural.startedAt); assert.equal(naturalInfo.foundDeadAt,undefined);
    assert.ok(Date.parse(naturalInfo.terminatedAt)>=Date.parse(natural.startedAt));
    assert.equal((await api(`/terminals/${natural.id}/archive`,'DELETE')).status(),409);

    const saved=await output(natural.id); assert.ok(saved.text.includes('UNICODE 界 🦊 é')); assert.equal(saved.version,2);
    assert.deepEqual(JSON.parse(await readFile(folder(natural.id)+'/input-history.json')),['original\n日本語 🦊']);
    for (const file of ['meta.json','input-history.json','output.txt','output.json']) {
        const info=await stat(folder(natural.id)+'/'+file); assert.equal(info.uid,user.uid); assert.equal(info.mode & 0o777,0o600);
    }
    const second=await browser.newContext(); const otherCSRF=await login(other,second);
    for (const suffix of ['', '/archive']) assert.equal((await second.request.get(`${base}/api/terminals/${natural.id}${suffix}`)).status(),404);
    assert.equal((await second.request.delete(`${base}/api/terminals/${natural.id}`,{headers:{'X-Tuxee-CSRF':otherCSRF,'X-Tuxee-Client':'web'}})).status(),404);
    assert.equal((await context.request.delete(`${base}/api/terminals/${natural.id}`,{headers:{'X-Tuxee-Client':'web'}})).status(),403);
    assert.equal((await second.request.delete(`${base}/api/terminals/${natural.id}/archive`,{headers:{'X-Tuxee-CSRF':otherCSRF,'X-Tuxee-Client':'web'}})).status(),404);
    assert.equal((await context.request.delete(`${base}/api/terminals/${natural.id}/archive`,{headers:{'X-Tuxee-Client':'web'}})).status(),403);
    assert.equal((await api(`/terminals/${natural.id}/archive`,'DELETE')).status(),409);
    await second.close();
    await chmod(folder(natural.id)+'/meta.json',0);
    for (const [path,method] of [[`/terminals/${natural.id}/archive`,'GET'],[`/terminals/${natural.id}`,'DELETE']]) {
        assert.equal((await api(path,method)).status(),500,'storage errors must not masquerade as missing archives');
    }
    await chmod(folder(natural.id)+'/meta.json',0o600);
    await mount(natural.id);
    const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message)); page.setDefaultTimeout(10000);
    await page.goto(base); await page.locator('.terminal-archive pre').waitFor();
    assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.text);
    assert.equal(await page.locator('.terminal-footer:visible [data-action=browse-shell-folder]').count(),0);
    assert.equal(await page.locator('.terminal-footer:visible button').count(),3);
    assert.equal(await page.locator('.terminal-dead-label').textContent(),'Post mortem');
    for (const size of [13,26]) for (const fraction of [.25,.75]) {
        const bounds=await page.locator('.terminal-archive pre').evaluate((pre,{size,fraction})=>{
            pre.style.fontSize=`${size}px`;
            const style=getComputedStyle(pre), range=document.createRange(); range.selectNodeContents(pre);
            const width=range.getBoundingClientRect().width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+pre.offsetWidth-pre.clientWidth;
            pre.style.width=`${width-size*fraction}px`; pre.dispatchEvent(new Event('scroll'));
            return {overflow:pre.scrollWidth-pre.clientWidth,mode:getComputedStyle(pre).overflowX};
        },{size,fraction});
        assert.ok(bounds.overflow>0);
        assert.equal(bounds.mode,fraction<.5?'hidden':'auto',JSON.stringify({size,fraction,...bounds}));
    }
    await page.locator('.terminal-archive pre').evaluate(pre=>{pre.style.width='';pre.style.fontSize='13px';pre.dispatchEvent(new Event('scroll'));});
    await page.locator('.terminal-archive pre').focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),saved.text);
    await mkdir('test-results',{recursive:true});
    for (const theme of ['dark','light']) for (const width of [1280,390,320]) {
        await page.goto('about:blank'); await page.setViewportSize({width,height:850});
        settings.theme=theme; await json('/settings','PUT',settings); await page.goto(base); await page.locator('.terminal-archive pre').waitFor();
        if (width<400) assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>{p.scrollLeft=100;return p.scrollLeft>0;}),'fixed columns must scroll horizontally');
        assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollHeight>p.clientHeight),'history must scroll vertically');
        await page.getByRole('button',{name:'Jump to top',exact:true}).click();
        assert.equal(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollTop),0);
        await page.getByRole('button',{name:'Jump to bottom',exact:true}).click();
        assert.ok(await page.locator('.terminal-archive pre').evaluate(p=>p.scrollTop>0));
        assert.equal(await page.locator('.terminal-archive pre').evaluate(p=>getComputedStyle(p).color), await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--text').trim()).then(c=>page.evaluate(c=>{const e=document.createElement('span');e.style.color=c;document.body.append(e);const color=getComputedStyle(e).color;e.remove();return color;},c)));
        await page.locator(width<760?'[data-component-name=primary]':'.terminal-tab:visible').click();
        assert.equal(await page.locator('.terminal-surface:visible').count(),0,'archive header stays read-only');
        assert.equal(await page.locator('.terminal-rendering:visible').count(),0);
        assert.equal(await page.locator('.terminal-dead-label').evaluate(p=>getComputedStyle(p).color),theme==='dark'?'rgb(255, 208, 120)':'rgb(166, 101, 0)');
        const bounds=await page.locator('.terminal-archive .terminal-footer').evaluate(f=>({width:f.clientWidth,scroll:f.scrollWidth})); assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
        await page.screenshot({path:`test-results/terminal-archive-${theme}-${width}.png`});
    }
    await page.goto('about:blank'); await page.setViewportSize({width:1280,height:850});
    const originalLayout=structuredClone(settings);
    Object.assign(settings.workspaces[0].panels[0],{w:2,h:1});
    settings.workspaces.push({id:'destination',name:'Destination',columns:4,rows:2,panels:[]});
    await json('/settings','PUT',settings);await page.goto(base);await page.locator('.terminal-archive pre').waitFor();
    const archiveNode=await page.locator('.terminal-archive').elementHandle();
    await page.locator('[data-panel=primary] .panel-header').dblclick();
    await wait(async()=>await page.locator('[data-panel=primary]').getAttribute('gs-w')==='4','archive header expansion');
    for(const [name,id] of [['Destination','destination'],['Archives','archive']]) {
        await page.locator('[data-panel=primary] .panel-header').click({button:'right',position:{x:20,y:10}});
        const menu=page.locator('.menu-actions.popover-menu');
        assert.equal(await menu.getByRole('menuitem',{name:'Rename',exact:true}).count(),0);
        await menu.getByRole('menuitem',{name:'Move to desktop',exact:true}).click();
        await menu.getByRole('menuitem',{name,exact:true}).click();
        await wait(async()=> (await json('/me')).settings.workspaces.find(w=>w.id===id).panels.some(p=>p.id==='primary'),'archive move');
        await page.locator('.workspace-tab').filter({hasText:new RegExp('^'+name+'$')}).click();
        await page.locator('.terminal-archive pre').waitFor();
        assert.ok(await archiveNode.evaluate(node=>node.isConnected));
        assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.text);
        assert.equal(await page.locator('.terminal-surface:visible').count(),0);
    }
    await page.goto('about:blank');settings=originalLayout;await json('/settings','PUT',settings);await page.goto(base);await page.locator('.terminal-archive pre').waitFor();
    console.log('PASS archive header expansion, context menus and desktop moves preserve output without live rendering');
    let created = 0;
    page.on('response', response => { if (response.url()===base+'/api/terminals' && response.request().method()==='POST' && response.status()===201) created++; });
    await page.route(base+`/api/terminals/${natural.id}`, route=>route.request().method()==='DELETE' ? route.fulfill({status:409,json:{error:'Test archive close failure'}}) : route.continue());
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Test archive close failure',{exact:true}).waitFor();
    assert.equal(created,0); assert.equal((await json(`/terminals/${natural.id}`)).closedAt,undefined);
    assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.text);
    await page.unroute(base+`/api/terminals/${natural.id}`);
    await page.route(base+'/api/terminals', route=>route.request().method()==='POST' ? route.fulfill({status:409,json:{error:'Test archive create failure'}}) : route.continue());
    await page.getByRole('button',{name:'Restart',exact:true}).click();
    await page.getByText('Test archive create failure',{exact:true}).waitFor();
    assert.equal(await page.locator('.terminal-archive pre').textContent(),saved.text);
    const restartedArchive=await json(`/terminals/${natural.id}`);
    assert.ok(restartedArchive.closedAt); assert.equal(restartedArchive.terminatedAt,naturalInfo.terminatedAt);
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
    assert.deepEqual(await output(natural.id),saved); assert.equal((await json(`/terminals/${natural.id}`)).closedAt,restartedArchive.closedAt);
    const openRetained=async()=>{ await page.getByRole('button',{name:'User menu',exact:true}).click(); await page.getByRole('menuitem',{name:'Retained terminals',exact:true}).click(); };
    await openRetained();
    const dialog=page.getByRole('dialog',{name:'Retained terminals',exact:true});
    await dialog.getByRole('tab').nth(0).waitFor();
    assert.deepEqual(await dialog.getByRole('tab').allTextContents(),['Lost (0)','Closed (1)']);
    assert.equal(await dialog.locator('.retained-status[data-exited=true]').count(),0);
    await dialog.getByRole('tab').nth(1).click();
    await dialog.locator('.retained-row').filter({hasText:'Archive fixture'}).getByRole('button',{name:'View',exact:true}).waitFor();
    assert.match((await dialog.locator('.retained-times').first().textContent()).replace(/[\u2066\u2069]/g,''),/Started \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}, closed by user /);
    const spacing=await dialog.locator('.retained-row').first().evaluate(row=>({top:parseFloat(getComputedStyle(row).paddingTop),bottom:parseFloat(getComputedStyle(row).paddingBottom)}));
    assert.ok(spacing.top>=14 && spacing.top===spacing.bottom,'uniform first-row padding');
    const closedInfo=await json(`/terminals/${natural.id}`);
    assert.equal(Date.parse(closedInfo.expiresAt)-Date.parse(closedInfo.closedAt),168*3600000);
    assert.match(await dialog.locator('.retained-times').textContent(),/closed by user .*Expires /);
    assert.equal(await dialog.locator('.retained-row button[aria-label="Delete"] svg').count(),1);
    assert.ok((await json(`/terminals/${natural.id}`)).closedAt); assert.deepEqual(await output(natural.id),saved);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'User menu',exact:true}).click(); await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
    const retention=page.locator('[name=closedTerminalHistoryHours]'); assert.equal(await retention.inputValue(),'168'); await retention.fill('72');
    await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Save',exact:true}).click();
    await wait(async()=> (await json('/me')).settings.closedTerminalHistoryHours===72,'retention save');
    const changedExpiry=await json(`/terminals/${natural.id}`);
    assert.equal(Date.parse(changedExpiry.expiresAt)-Date.parse(changedExpiry.closedAt),72*3600000);
    assert.equal((await api('/settings','PUT',{...settings,closedTerminalHistoryHours:-1})).status(),400);
    assert.equal((await api('/settings','PUT',{...settings,closedTerminalHistoryHours:1.5})).status(),400);
    await page.close();
    const closing=await create("printf 'CLOSE_DURING_RESTART\\n'",'Closing archive');
    await ended(closing.id); await mount(closing.id);
    const closingPage=await context.newPage(); closingPage.on('pageerror',error=>errors.push(error.message));
    await closingPage.goto(base); await closingPage.locator('.terminal-archive pre').waitFor();
    let entered, release, replacements=0;
    const requested=new Promise(resolve=>entered=resolve), held=new Promise(resolve=>release=resolve);
    closingPage.on('request',request=>{ if(request.url()===base+'/api/terminals' && request.method()==='POST') replacements++; });
    await closingPage.route(base+`/api/terminals/${closing.id}`,async route=>{
        if(route.request().method()==='DELETE') { entered(); await held; }
        await route.continue();
    });
    await closingPage.getByRole('button',{name:'Restart',exact:true}).click(); await requested;
    await closingPage.locator('[data-panel=primary]').getByRole('button',{name:'Close panel',exact:true}).click();
    await closingPage.locator('.terminal-archive').waitFor({state:'detached'}); release();
    await wait(async()=>Boolean((await json(`/terminals/${closing.id}`)).closedAt),'close during archive restart');
    await closingPage.unrouteAll({behavior:'wait'}); await closingPage.close();
    assert.equal(replacements,0,'closing during archive restart must not create a shell');
    await json(`/terminals/${closing.id}/archive`,'DELETE');
    console.log('PASS archive Restart closes old output; close/create/save failures and concurrent panel closure preserve lifecycle');
    const killed=await create("printf 'KILLED_OUTPUT\\n'; sleep 300",'Killed');
    await wait(async()=> (await output(killed.id))?.text.includes('KILLED_OUTPUT'),'kill output'); process.kill(killed.pid,'SIGKILL'); await ended(killed.id);
    assert.ok((await output(killed.id)).text.includes('KILLED_OUTPUT')); assert.equal((await json(`/terminals/${killed.id}`)).closedAt,undefined);
    const mc=await create("printf 'BEFORE_MC\\n'; mc -u; printf 'BETWEEN_MC\\n'; mc -u; printf 'AFTER_MC\\n'",'Midnight Commander');
    await mount(mc.id);
    const mcPage=await context.newPage(); mcPage.on('pageerror',error=>errors.push(error.message));
    let fitted=false;
    mcPage.on('websocket',socket=>socket.on('framereceived',({payload})=>{ if(typeof payload==='string'&&JSON.parse(payload).type==='resize-ack') fitted=true; }));
    await mcPage.goto(base); await mcPage.locator('.terminal-view[data-state=connected]').waitFor();
    await wait(()=>fitted,'MC initial terminal resize');
    for (const visit of [1,2]) {
        try { await wait(async()=>{ const a=await output(mc.id); return (a?.text.match(/Help/g)||[]).length>=visit; },`real MC visit ${visit} did not render`); }
        catch (error) { await mcPage.screenshot({path:'test-results/terminal-archive-mc-failure.png'}); await writeFile('test-results/terminal-archive-mc-failure.json',JSON.stringify(await output(mc.id))); throw error; }
        await mcPage.locator('.xterm-helper-textarea').focus(); await mcPage.keyboard.press('F10');
    }
    await ended(mc.id); await mcPage.locator('.terminal-archive').waitFor();
    const mcArchive=await output(mc.id), text=mcArchive.text;
    assert.ok(text.indexOf('BEFORE_MC')<text.indexOf('Help'));
    assert.ok(text.indexOf('Help')<text.indexOf('BETWEEN_MC'));
    assert.ok(text.indexOf('BETWEEN_MC')<text.lastIndexOf('Help'));
    assert.ok(text.lastIndexOf('Help')<text.indexOf('AFTER_MC'));
    for (const token of ['BEFORE_MC','BETWEEN_MC','AFTER_MC']) assert.equal(text.split(token).length-1,1);
    assert.equal(text.trimEnd().split('\n').at(-1),'AFTER_MC');
    assert.equal(await mcPage.locator('.terminal-archive select').count(),0);
    assert.equal(await mcPage.locator('.terminal-archive pre').textContent(),text);
    await mcPage.locator('.terminal-tab:visible').click();
    assert.equal(await mcPage.locator('.terminal-surface:visible').count(),0,'header must not expose the live loader');
    await mcPage.screenshot({path:'test-results/terminal-archive-mc.png'}); await mcPage.close();
    const shutdown=await create("printf 'SHUTDOWN_OUTPUT\\n'; trap 'printf \"\\033[2J\"; exit' HUP TERM; while :; do sleep 1; done",'Shutdown');
    await wait(async()=> (await output(shutdown.id))?.text.includes('SHUTDOWN_OUTPUT'),'shutdown output');
    await mount(shutdown.id); await stop(); await start(); csrf=await login();
    assert.equal((await json('/me')).settings.workspaces[0].panels[0].terminal,shutdown.id);
    assert.ok((await output(shutdown.id)).text.includes('SHUTDOWN_OUTPUT')); assert.equal((await json(`/terminals/${shutdown.id}`)).closedAt,undefined);
    const shutdownInfo=await json(`/terminals/${shutdown.id}`); assert.ok(shutdownInfo.terminatedAt); assert.equal(shutdownInfo.foundDeadAt,undefined);
    const crash=await create("printf 'CRASH_CHECKPOINT\\n'; sleep 300",'Crash');
    await wait(async()=>{try{return (await disk(crash.id)).text.includes('CRASH_CHECKPOINT');}catch{return false;}},'periodic checkpoint missing');
    await stop('SIGKILL'); await start(); csrf=await login();
    assert.ok((await output(crash.id)).text.includes('CRASH_CHECKPOINT')); assert.equal((await json(`/terminals/${crash.id}`)).closedAt,undefined);
    const crashInfo=await json(`/terminals/${crash.id}`); assert.ok(crashInfo.foundDeadAt); assert.equal(crashInfo.terminatedAt,undefined); assert.equal(crashInfo.startedAt,crash.startedAt);
    const metadata=JSON.parse(await readFile(folder(natural.id)+'/meta.json')); metadata.closedAt=new Date(Date.now()-169*3600000).toISOString();
    await writeFile(folder(natural.id)+'/meta.json',JSON.stringify(metadata));
    csrf=await login(); assert.equal((await api(`/terminals/${natural.id}`)).status(),404);
    assert.ok((await output(crash.id)).text.includes('CRASH_CHECKPOINT'),'unclosed archives must never expire');
    const registry=JSON.parse(await readFile(state+'/state/terminal-accounts.json')); assert.equal(registry[user.name],user.uid); assert.equal(registry[other.name],other.uid);
    const closedFixture=await create("printf 'DELETE_ME\\n'; sleep 300",'Closed list fixture');
    await json(`/terminals/${closedFixture.id}`,'DELETE');
    const liveFixture=await create("printf 'LIVE_LIST\\n'; sleep 1800",'Live list fixture');
    assert.equal((await api(`/terminals/${liveFixture.id}/archive`,'DELETE')).status(),409);
    const olderClosed=await create("printf 'OLDER_CLOSED\\n'",'Older closed fixture');
    await ended(olderClosed.id); await json(`/terminals/${olderClosed.id}`,'DELETE');
    for (let i=0;i<16;i++) {
        const counted=await create(`printf 'COUNT_${i}\\n'`,'Count fixture '+i);
        await ended(counted.id); await json(`/terminals/${counted.id}`,'DELETE');
    }
    const hour=3600000, now=Date.now(), stamp=hours=>new Date(now-hours*hour).toISOString();
    for(const [id,times] of [
        [mc.id,{startedAt:stamp(100),terminatedAt:stamp(24+8+34/60)}],
        [killed.id,{startedAt:stamp(10),terminatedAt:stamp(1.5)}],
        [shutdown.id,{startedAt:stamp(401*24),terminatedAt:stamp(400*24)}],
        [crash.id,{startedAt:stamp(7),foundDeadAt:stamp(53/60)}],
        [closedFixture.id,{startedAt:stamp(3)}],
        [olderClosed.id,{startedAt:stamp(2),terminatedAt:stamp(1),closedAt:stamp(1)}],
    ]) {
        const path=folder(id)+'/meta.json', value=JSON.parse(await readFile(path));
        await writeFile(path,JSON.stringify({...value,...times}));
    }
    await mount(mc.id);
    const mobile=await context.newPage(); mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.clock.setFixedTime(now);
    await mobile.setViewportSize({width:320,height:700});
    for (const [index,file] of (await readdir('internal/i18n/locales')).entries()) {
        if (index===20) { console.log('Waiting for the real login rate-limit window before remaining languages.'); await new Promise(resolve=>setTimeout(resolve,60000)); }
        const language=file.replace('.json',''), catalog=JSON.parse(await readFile('internal/i18n/locales/'+file)).texts; csrf=await login(user,context,language);
        await mobile.goto(base); await mobile.locator('.terminal-archive pre').waitFor();
        assert.equal(await mobile.locator('.terminal-archive select').count(),0);
        const bounds=await mobile.locator('.terminal-archive .terminal-footer').evaluate(f=>({width:f.clientWidth,scroll:f.scrollWidth}));
        assert.ok(bounds.scroll<=bounds.width+1,language+': '+JSON.stringify(bounds));
        assert.equal(await mobile.locator('.terminal-archive pre').textContent(),mcArchive.text);
        if (['ar','cs'].includes(language)) await mobile.screenshot({path:`test-results/terminal-archive-${language}-320.png`});
        await mobile.getByRole('button',{name:catalog['app.userMenu'],exact:true}).click();
        await mobile.getByRole('menuitem',{name:catalog['app.retainedTerminals'],exact:true}).click();
        const inventory=mobile.getByRole('dialog',{name:catalog['app.retainedTerminals'],exact:true});
        for (const theme of ['dark','light']) {
            await mobile.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
            for (const tab of ['term.lostTerminals','term.closedArchives']) {
                await inventory.getByRole('tab').nth(tab==='term.lostTerminals'?0:1).click();
                const layout=await inventory.evaluate(dialog=>{
                    const body=dialog.querySelector('.modal-body');
                    return {width:body.clientWidth,scroll:body.scrollWidth,rows:[...dialog.querySelectorAll('.retained-row')].map(row=>({id:row.dataset.terminalId,width:row.clientWidth,scroll:row.scrollWidth,path:row.querySelector('.retained-directory').textContent,pathWeight:getComputedStyle(row.querySelector('.retained-directory')).fontWeight,pathColor:getComputedStyle(row.querySelector('.retained-directory')).color,nameWeight:getComputedStyle(row.querySelector('.retained-label')).fontWeight,nameColor:getComputedStyle(row.querySelector('.retained-label')).color,times:row.querySelector('.retained-times').textContent,color:getComputedStyle(row.querySelector('.retained-status')).backgroundColor,exited:row.querySelector('.retained-status').dataset.exited}))};
                });
                assert.ok(layout.scroll<=layout.width+1,language+theme+tab+JSON.stringify(layout));
                const selected=inventory.getByRole('tab',{selected:true});
                const countedLabel=catalog[tab].replace('{count}',String(layout.rows.length));
                assert.equal(await selected.textContent(),countedLabel);
                assert.equal(await selected.getAttribute('aria-label'),countedLabel);
                assert.equal(await selected.getAttribute('title'),countedLabel);
                if(tab==='term.closedArchives') assert.equal(layout.rows.length,18);
                const chronology=tab==='term.lostTerminals'?[crash.id,killed.id,mc.id,shutdown.id]:[closedFixture.id,olderClosed.id];
                assert.deepEqual(layout.rows.map(row=>row.id).filter(id=>chronology.includes(id)),chronology);
                if(tab==='term.lostTerminals') assert.equal(layout.rows[0].id,liveFixture.id,'live terminal uses its start timestamp');
                for (const [id,key,vars] of [
                    [liveFixture.id,'term.ageMinutes',{minutes:0}],
                    [crash.id,'term.ageMinutes',{minutes:53}],
                    [killed.id,'term.ageHours',{hours:1,minutes:30}],
                    [mc.id,'term.ageDays',{days:1,hours:8,minutes:34}],
                    [shutdown.id,'term.ageDays',{days:400,hours:0,minutes:0}],
                    [closedFixture.id,'term.ageMinutes',{minutes:0}],
                    [olderClosed.id,'term.ageHours',{hours:1,minutes:0}],
                ]) if(layout.rows.some(row=>row.id===id)) {
                    const expected=catalog[key].replace(/\{(\w+)\}/g,(_,key)=>vars[key]);
                    assert.equal(await inventory.locator(`[data-terminal-id="${id}"] .retained-age`).textContent(),'• '+expected);
                }
                for (const row of layout.rows) {
                    assert.equal(row.path,user.home); assert.equal(row.pathWeight,'400'); assert.ok(Number(row.nameWeight)>=600); assert.notEqual(row.pathColor,row.nameColor);
                    assert.ok(row.scroll<=row.width+1,language+JSON.stringify(row)); assert.ok(!row.times.includes('[!'));
                    assert.equal(row.color,row.exited==='true' ? (theme==='dark'?'rgb(173, 148, 247)':'rgb(121, 83, 191)') : (theme==='dark'?'rgb(54, 207, 167)':'rgb(24, 123, 102)'));
                }
                if (['en','ar','cs','pl'].includes(language)) await mobile.screenshot({path:`test-results/terminal-list-${language}-${theme}-${tab.split('.').at(-1)}-320.png`});
            }
        }
        await mobile.keyboard.press('Escape');
    }
    await mobile.close();
    csrf=await login();
    const listPage=await context.newPage(); listPage.on('pageerror',error=>errors.push(error.message)); await listPage.goto(base); await listPage.locator('.terminal-archive pre').waitFor();
    await listPage.getByRole('button',{name:'User menu',exact:true}).click(); await listPage.getByRole('menuitem',{name:'Retained terminals',exact:true}).click();
    const inventory=listPage.getByRole('dialog',{name:'Retained terminals',exact:true}); await inventory.waitFor();
    const listed=id=>inventory.locator(`[data-terminal-id="${id}"]`);
    assert.equal(await listed(liveFixture.id).getByRole('button',{name:'Connect',exact:true}).count(),1);
    assert.equal(await listed(mc.id).getByRole('button',{name:'View',exact:true}).count(),1);
    assert.equal(await listed(liveFixture.id).locator('button[aria-label="Close"] svg').count(),1);
    await inventory.getByRole('tab').nth(1).click();
    assert.equal(await inventory.getByRole('tab').nth(1).textContent(),'Closed (18)');
    await listed(closedFixture.id).getByRole('button',{name:'Delete',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Delete terminal output?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await api(`/terminals/${closedFixture.id}`)).status(),200);
    await listed(closedFixture.id).getByRole('button',{name:'Delete',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Delete terminal output?',exact:true}).getByRole('button',{name:'Delete',exact:true}).click();
    await wait(async()=>!(await listed(closedFixture.id).count()),'single archive deletion');
    assert.equal(await inventory.getByRole('tab').nth(1).textContent(),'Closed (17)');
    assert.equal((await api(`/terminals/${closedFixture.id}/archive`)).status(),404);
    await assert.rejects(stat(folder(closedFixture.id)),{code:'ENOENT'});
    await inventory.getByRole('tab').nth(0).click();
    await inventory.getByRole('button',{name:'Close all',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Close all',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await json(`/terminals/${liveFixture.id}`)).exited,false);
    await wait(()=>inventory.locator('[data-action=all-terminals]').isEnabled(),'bulk cancellation completed');
    const later=await create("sleep 1800",'Not yet displayed');
    const refreshed=listPage.waitForResponse(response=>response.url()===base+'/api/terminals'&&response.request().method()==='GET');
    await listPage.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); await refreshed;
    assert.equal(await listed(later.id).count(),0);
    // One failed item must not hide successful closures or stop the remaining batch.
    await listPage.route(base+`/api/terminals/${crash.id}`,route=>route.request().method()==='DELETE'?route.fulfill({status:409,json:{error:'Expected batch close failure'}}):route.continue());
    await inventory.getByRole('button',{name:'Close all',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Close all',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await wait(async()=> (await json(`/terminals/${liveFixture.id}`)).closedAt,'bulk closure');
    await listPage.getByText('Expected batch close failure',{exact:true}).waitFor();
    assert.equal((await json(`/terminals/${later.id}`)).exited,false,'All must use only the displayed list');
    assert.equal((await json(`/terminals/${crash.id}`)).closedAt,undefined);
    await listPage.unroute(base+`/api/terminals/${crash.id}`);
    await inventory.getByRole('button',{name:'Close all',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Close all',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
    await wait(async()=> !(await inventory.locator('.retained-row').count()),'bulk retry');
    await inventory.getByRole('tab').nth(1).click();
    await listPage.screenshot({path:'test-results/terminal-list-closed-desktop.png'});
    await inventory.getByRole('button',{name:'Delete all',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Delete terminal output?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.ok((await json('/terminals')).length>0);
    await inventory.getByRole('button',{name:'Delete all',exact:true}).click();
    await listPage.getByRole('dialog',{name:'Delete terminal output?',exact:true}).getByRole('button',{name:'Delete',exact:true}).click();
    await wait(async()=> (await json('/terminals')).length===0,'bulk deletion');
    await wait(async()=> !(await inventory.locator('.retained-row').count()),'empty deleted list');
    assert.deepEqual(await inventory.getByRole('tab').allTextContents(),['Lost (0)','Closed (0)']);
    assert.equal(await inventory.getByRole('button',{name:'Delete all',exact:true}).isDisabled(),true);
    await inventory.getByText('No closed terminals.',{exact:true}).waitFor();
    await inventory.getByRole('tab').nth(0).click();
    await inventory.getByText('No lost terminals.',{exact:true}).waitFor();
    await listPage.close();
    assert.deepEqual(errors,[]);
    console.log('Terminal archives: Unicode/copy, natural exit, shell kill, MC, restart, closed retention, permissions, crash and shutdown passed.');
} catch (error) {
    console.error(logs.join('')); throw error;
} finally {
    await browser?.close(); if (server?.exitCode===null && server?.signalCode===null) await stop();
    for (const user of accounts.reverse()) { spawnSync('pkill',['-KILL','-u',String(user.uid)]); run('userdel',[user.name]); }
    await rm(state,{recursive:true,force:true});
}
