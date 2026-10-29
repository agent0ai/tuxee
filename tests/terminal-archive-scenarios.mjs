import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Destructive lifecycle checks belong only in a disposable test container.
const container = process.env.TUXEE_TEST_CONTAINER, base = process.env.TUXEE_TEST_URL;
assert.match(container || '', /^tuxee-post-mortem-stress-/);
assert.ok(base, 'provide the disposable container port proxy');
const run = (args, input) => {
    const result = spawnSync('docker', args, {input, encoding:'utf8', timeout:60000});
    assert.equal(result.status, 0, `docker ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
};
const exec = (...args) => run(['exec', container, ...args]);
const user = `tuxee-scenarios-${process.pid}`, home = `/home/${user}`, password = randomBytes(24).toString('base64url');
const results = [], errors = [], archives = [], settingsWrites = new Set();
const pass = (scenario, details = {}) => { results.push({scenario, ...details}); console.log('PASS ' + scenario); };
const wait = async (check, label, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw Error(label);
};
const browser = await chromium.launch({executablePath:'/usr/bin/chromium', args:['--no-sandbox']});
const context = await browser.newContext({viewport:{width:1440,height:950}, permissions:['clipboard-read','clipboard-write']});
let csrf, page, current, settings;
const login = async () => {
    await wait(async () => { try { return (await context.request.get(base+'/health', {timeout:1500})).ok(); } catch { return false; } }, 'server readiness');
    const response = await context.request.post(base+'/api/login', {data:{username:user,password,language:'en'}, headers:{'X-Tuxee-Client':'web'}});
    assert.equal(response.status(),200); csrf = (await response.json()).csrf;
};
const api = async (path, method='GET', data, status=200) => {
    const response=await context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-Client':'web','X-Tuxee-CSRF':csrf}});
    assert.equal(response.status(),status, path+': '+await response.text()); return response.json();
};
const archive = async id => (await api(`/terminals/${id}/archive`)).text;
const panel = () => page.locator('[data-panel=subject]');
const liveText = () => panel().locator('.xterm-rows').textContent();
const command = async value => { await panel().locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText(value); await page.keyboard.press('Enter'); };
const marker = async (prefix, value) => {
    const token = `${prefix}_${value}`;
    await command(`printf '${prefix}_%s\\n' '${value}'`);
    await wait(async () => (await liveText()).includes(token), 'shell output '+token);
    return token;
};
const mount = async session => {
    current=session;
    settings.workspaces=[{id:'work',name:'Subject',columns:4,rows:2,active:'subject',panels:[{id:'subject',kind:'terminal',terminal:session.id,path:home,x:0,y:0,w:4,h:2}]}];
    settings.current='work'; await api('/settings','PUT',settings); await page.goto(base);
    await panel().locator('.terminal-view[data-state=connected]').waitFor();
};
const create = async (shell='bash', commandText) => {
    await page.goto('about:blank');
    await wait(()=>settingsWrites.size===0,'previous layout saves');
    settings={theme:'dark',shellCommand:shell,useTuxeePrompt:true,workspaces:[]}; await api('/settings','PUT',settings);
    const session=await api('/terminals','POST',{directory:home,name:shell,columns:120,rows:30,command:commandText},201);
    await mount(session); return session;
};
const ended = async (id=current.id) => {
    await wait(async () => (await api('/terminals/'+id)).exited, 'terminal did not end');
    await panel().locator('.terminal-archive').waitFor();
    assert.equal(await panel().locator('.terminal-surface:visible').count(),0);
    assert.equal(await panel().locator('.terminal-rendering:visible').count(),0);
    const text=await archive(id);
    assert.equal(await panel().locator('.terminal-archive pre').textContent(),text);
    assert.ok(text.split('\n').length<=5000);
    assert.equal(text.includes('\x1b'),false);
    assert.equal((await api('/terminals/'+id)).closedAt,undefined);
    return text;
};
const programs=[
    {name:'mc',command:'mc -u',screen:/Left\s+File\s+Command/,exit:['F10']},
    {name:'less',command:`less ${home}/less.txt`,screen:/DOCUMENT_less/,exit:['q']},
    {name:'vim',command:`vim.tiny -Nu NONE -n ${home}/vim.txt`,screen:/DOCUMENT_vim/,exit:['Escape',':q!','Enter']},
    {name:'nano',command:`nano --ignorercfiles ${home}/nano.txt`,screen:/DOCUMENT_nano/,exit:['Control+x','n']},
    {name:'htop',command:'htop',screen:/Tasks:/,exit:['F10']},
    {name:'top',command:'top',screen:/top -/,exit:['q']},
];
const openProgram = async program => {
    await command(program.command);
    await wait(async () => program.screen.test(await liveText()), program.name+' rendering');
    // A checkpoint checks the real recorder and gives abrupt-kill cases a useful frame.
    assert.match(await archive(current.id),program.screen);
};
const leaveProgram = async program => {
    for (const key of program.exit) {
        if(key===':q!') await page.keyboard.insertText(key); else await page.keyboard.press(key);
    }
    const executable=program.command.split(' ')[0].split('/').at(-1);
    await wait(()=>spawnSync('docker',['exec',container,'pgrep','-P',String(current.pid),'-x',executable]).status===1,program.name+' exit');
};
try {
    exec('useradd','-m','-s','/bin/bash','-c','Tuxee prototype test',user);
    run(['exec','-i',container,'chpasswd'],`${user}:${password}\n`);
    for(const name of ['less','vim','nano']) {
        const text=`DOCUMENT_${name} 界 🦊 é\n`+Array.from({length:180},(_,i)=>`${name} row ${String(i).padStart(3,'0')} `+'content '.repeat(12)).join('\n')+'\n';
        run(['exec','-i',container,'tee',`${home}/${name}.txt`],text);
        exec('chown',user+':'+user,`${home}/${name}.txt`);
    }
    await mkdir('test-results',{recursive:true}); await login(); page=await context.newPage();
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.url()===base+'/api/settings' && request.method()==='PUT')settingsWrites.add(request);});
    page.on('requestfinished',request=>settingsWrites.delete(request));page.on('requestfailed',request=>settingsWrites.delete(request));
    for(const shell of ['bash','zsh','fish','/bin/sh']) {
        await page.setViewportSize({width:1440,height:950});const session=await create(shell), tokens=[];
        for(const [i,program] of programs.entries()) {
            const label=shell.replaceAll('/','')+'_'+program.name;
            const before=await marker('BEFORE',label);tokens.push(before);
            await openProgram(program);
            // Resize both active application and restored shell, including portrait/mobile.
            for(const size of [{width:900,height:1100},{width:390,height:844},{width:1600,height:950}]) {
                await page.setViewportSize(size);await page.waitForTimeout(400);
                assert.equal((await api('/terminals/'+session.id)).pid,session.pid);
                await wait(async()=>program.screen.test(await liveText()),program.name+' after resize');
            }
            if(i%2===0) {
                await page.reload();await panel().locator('.terminal-view[data-state=connected]').waitFor();
                assert.equal((await api('/terminals/'+session.id)).pid,session.pid);
                await wait(async()=>program.screen.test(await liveText()),'reconnect '+program.name);
            } else {
                await context.setOffline(true);await page.waitForTimeout(500);await context.setOffline(false);
                await wait(async()=>!await page.locator('.connection-overlay:visible').count(),'offline overlay');
                await panel().locator('.terminal-view[data-state=connected]').waitFor();
                await wait(async()=>program.screen.test(await liveText()),'offline recovery '+program.name);
            }
            await panel().locator('.xterm-helper-textarea').focus();
            if(program.name==='mc') {for(const key of ['Tab','ArrowDown','ArrowUp','F9','Escape'])await page.keyboard.press(key);}
            if(program.name==='less') {for(const key of ['PageDown','PageDown','Home'])await page.keyboard.press(key);}
            if(program.name==='vim') {await page.keyboard.press('o');await page.keyboard.insertText('EDIT_'+label);await page.keyboard.press('Escape');}
            if(program.name==='nano') {await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.insertText('EDIT_'+label);}
            if(program.name==='htop') {await page.keyboard.press('F6');await page.keyboard.press('Escape');}
            if(program.name==='top') {await page.keyboard.press('m');await page.keyboard.press('m');}
            // Let curses distinguish a standalone Escape from an Alt/function-key prefix.
            await page.waitForTimeout(1100);
            if(['vim','nano'].includes(program.name)) await wait(async()=> (await archive(session.id)).includes('EDIT_'+label),'last edited screen');
            await panel().locator('.xterm-helper-textarea').focus();await leaveProgram(program);
            const after=await marker('AFTER',label);tokens.push(after);
            const output=await archive(session.id), segment=output.slice(output.indexOf(before)+before.length,output.indexOf(after));
            assert.match(segment,program.screen,`${shell}/${program.name} frame missing between shell output`);
            if(['vim','nano'].includes(program.name))assert.ok(segment.includes('EDIT_'+label),'final edited frame was lost');
            assert.equal(output.split(before).length-1,1,'duplicated shell before application');
            assert.equal(output.split(after).length-1,1,'duplicated shell after application');
            pass(`${shell}: ${program.name}, three resizes, ${i%2?'offline/online':'reload'}, shell continuation`);
        }
        await command('exit');const output=await ended(session.id);let last=-1;
        for(const token of tokens) {const at=output.indexOf(token);assert.ok(at>last,token+' lost/reordered');last=at;}
        archives.push({id:session.id,text:output});
        const original=output;
        for(const theme of ['dark','light']) for(const width of [1600,390,320]) {
            await page.setViewportSize({width,height:900});
            if(await page.locator('html').getAttribute('data-theme')!==theme) await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();
            const header=width<760?page.locator('[data-component-name=subject]'):panel().locator('.terminal-tab');
            await header.click();await header.click();
            const pre=panel().locator('.terminal-archive pre');assert.equal(await pre.textContent(),original);
            assert.equal(await panel().locator('.terminal-surface:visible').count(),0);
            await panel().getByRole('button',{name:'Jump to top',exact:true}).click();assert.equal(await pre.evaluate(e=>e.scrollTop),0);
            await panel().getByRole('button',{name:'Jump to bottom',exact:true}).click();assert.ok(await pre.evaluate(e=>e.scrollTop>0));
            await pre.focus();await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),original);
            if(width===320)assert.ok(await pre.evaluate(e=>{e.scrollLeft=200;return e.scrollLeft>0;}));
            assert.ok(await panel().locator('.terminal-footer:visible').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
        }
        await page.screenshot({path:`test-results/archive-scenarios-${shell.replaceAll('/','')}.png`});
        pass(`${shell}: exit, all six frames ordered, archive header/scroll/copy at six theme/size combinations`);
    }
    await page.setViewportSize({width:1440,height:950});
    const warm=await create('bash');await openProgram(programs[0]);
    settings.workspaces.push(...Array.from({length:9},(_,i)=>({id:`cache-${i}`,name:`Cache ${i}`,columns:4,rows:2,active:`archive-${i}`,panels:[
        {id:`archive-${i}`,kind:'terminal',terminal:archives[i%archives.length].id,path:home,x:0,y:0,w:4,h:2}
    ]})));
    await api('/settings','PUT',settings);await page.reload();await panel().locator('.terminal-view[data-state=connected]').waitFor();
    const visit=async name=>{
        const tab=page.locator('.workspace-tab').filter({hasText:new RegExp(`^${name}$`)});
        if(!await tab.isVisible())await page.getByRole('button',{name:'More desktops',exact:true}).click();
        await tab.click();
    };
    for(const i of [0,1,2,3,4,5,6,7,8,0]) {
        await visit(`Cache ${i}`);const archived=page.locator(`[data-panel=archive-${i}]`);
        await archived.locator('.terminal-archive pre').waitFor();
        assert.equal(await archived.locator('.terminal-archive pre').textContent(),archives[i%archives.length].text);
        await archived.locator('.terminal-tab').click();assert.equal(await archived.locator('.terminal-surface:visible').count(),0);
        assert.equal((await api('/terminals/'+warm.id)).pid,warm.pid);
    }
    await visit('Subject');await panel().locator('.terminal-view[data-state=connected]').waitFor();
    await wait(async()=>programs[0].screen.test(await liveText()),'MC after cache eviction');
    await page.getByRole('button',{name:'User menu',exact:true}).click();await page.getByRole('menuitem',{name:'Log out',exact:true}).click();
    await page.locator('[name=username]').waitFor();await login();await page.goto(base);await panel().locator('.terminal-view[data-state=connected]').waitFor();
    assert.equal((await api('/terminals/'+warm.id)).pid,warm.pid);
    await wait(async()=>programs[0].screen.test(await liveText()),'MC after logout');
    await panel().locator('.xterm-helper-textarea').focus();await leaveProgram(programs[0]);await command('exit');await ended(warm.id);
    pass('ten workspaces: archive visits, cache eviction, live MC identity, logout/login');

    for(const program of [programs[0],programs[3],programs[4]]) {
        const session=await create('bash');await openProgram(program);
        const child=exec('pgrep','-P',String(session.pid),'-x',program.name);assert.match(child,/^\d+$/);
        exec('runuser','-u',user,'--','kill','-KILL',child);
        // SIGKILL cannot run the application's terminal cleanup; restore shell modes.
        await command('reset');await marker('AFTER','KILLED_CHILD_'+program.name);await command('exit');
        const output=await ended(session.id);
        // The surviving shell can overwrite/scroll part of a killed TUI before reset.
        assert.match(output,{mc:/Modify time/,nano:/nano row 010/,htop:/Load average/}[program.name]);
        assert.ok(output.includes('AFTER_KILLED_CHILD_'+program.name));
        pass(`${program.name} child SIGKILL, shell reset and continued output`);
    }
    for(const signal of ['TERM','KILL']) for(const program of [programs[0],programs[2],programs[4]]) {
        const session=await create('bash');await marker('BEFORE',signal+'_'+program.name);await command('exec '+program.command);
        await wait(async()=>program.screen.test(await liveText()),'exec '+program.name);assert.match(await archive(session.id),program.screen);
        // Signal from another shell under the same Linux credentials.
        exec('runuser','-u',user,'--','sh','-c',`kill -${signal} ${session.pid}`);
        assert.match(await ended(session.id),program.screen);pass(`exec ${program.name}: SIG${signal} from another shell`);
    }
    for(const commandText of ['kill -TERM $$','kill -KILL $$',`python3 -c 'import os,signal; print("CHILD_"+"KILLS_SHELL",flush=True); os.kill(os.getppid(),signal.SIGKILL)'`]) {
        const session=await create('bash');const token=await marker('BEFORE','SELF_KILL');await command(commandText);
        if(commandText==='kill -TERM $$') {
            await marker('IGNORED','SIGTERM');assert.equal((await api('/terminals/'+session.id)).exited,false);await command('exit');
        }
        const output=await ended(session.id);assert.ok(output.includes(token));
        if(commandText.startsWith('python3'))assert.ok(output.includes('CHILD_KILLS_SHELL'));
        pass('shell/program termination: '+commandText.split(' ')[0]+' '+commandText.split(' ')[1]);
    }
    // Kill the shell while a separate fullscreen child owns the PTY.
    const foreground=await create('bash');await openProgram(programs[0]);
    exec('runuser','-u',user,'--','sh','-c',`kill -KILL ${foreground.pid}`);
    assert.match(await ended(foreground.id),programs[0].screen);pass('shell SIGKILL with foreground MC child');

    // Explicit closure while a TUI runs must capture it and start retention.
    const closed=await create('bash');await openProgram(programs[3]);
    await panel().getByRole('button',{name:'Close panel',exact:true}).click();
    await wait(async()=>!!(await api('/terminals/'+closed.id)).closedAt,'explicit Close retention');
    assert.match(await archive(closed.id),programs[3].screen);pass('Close panel while Nano runs captures text and starts retention');

    // Graceful re-exec and hard container loss must retain the checkpoint and layout ID.
    for(const mode of ['cli','kill-server','container-stop','container-kill']) {
        const session=await create('bash');await openProgram(programs[4]);
        const expected=await archive(session.id);
        if(mode==='cli')exec('tuxee','restart');
        else if(mode==='kill-server') {
            const pid=exec('pgrep','-f','^/usr/local/bin/tuxee serve');assert.match(pid,/^\d+$/);exec('kill','-KILL',pid);
        }
        else {run(mode==='container-stop'?['stop','--time','15',container]:['kill',container]);run(['start',container]);}
        await page.locator('[name=username]').waitFor({timeout:30000});await login();await page.goto(base);await panel().locator('.terminal-archive').waitFor();
        assert.equal((await api('/me')).settings.workspaces[0].panels[0].terminal,session.id);
        const output=await archive(session.id);assert.match(output,programs[4].screen);
        if(mode!=='cli')assert.equal(output,expected);
        await panel().locator('.terminal-tab').click();assert.equal(await panel().locator('.terminal-surface:visible').count(),0);
        pass(`${mode}: active htop checkpoint, same saved ID, post-mortem after login`);
    }
    assert.deepEqual(errors,[]);
} catch(error) {
    results.push({failure:error.stack});
    await page?.screenshot({path:'test-results/archive-scenarios-failure.png'}).catch(()=>{});
    if(current)await archive(current.id).then(text=>writeFile('test-results/archive-scenarios-failure.txt',text)).catch(()=>{});
    throw error;
} finally {
    await writeFile('test-results/archive-scenarios.json',JSON.stringify(results,null,2));
    await browser.close();
    // Cleanup only the account created by this suite, even after a failure.
    spawnSync('docker',['exec',container,'pkill','-KILL','-u',user]);
    spawnSync('docker',['exec',container,'userdel','-r',user]);
}
