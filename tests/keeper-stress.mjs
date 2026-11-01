import { appPage } from './app-page.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const container = process.env.TUXEE_TEST_CONTAINER, base = process.env.TUXEE_TEST_URL;
assert.match(container || '', /^tuxee-post-mortem-stress-/);
assert.ok(base);
const out = 'test-results/keeper-stress';
await mkdir(out, {recursive:true});
const docker = (args, input) => spawnSync('docker', args, {input, encoding:'utf8', timeout:60000, maxBuffer:16*1024*1024});
const run = (...args) => { const r=docker(['exec',container,...args]); assert.equal(r.status,0,r.stderr); return r.stdout; };
const put = (path, text) => { const r=docker(['exec','-i',container,'tee',path],text); assert.equal(r.status,0,r.stderr); };
const accounts = [0,1].map(i=>({user:`tuxee-stress-${process.pid}-${i}`,password:randomBytes(24).toString('base64url')}));
const owner=accounts[0], other=accounts[1], home=`/home/${owner.user}`;
const results=[], errors=[];
const pass=(name,details={})=>{results.push({name,...details});console.log('PASS '+name);};
const wait=async(fn,label)=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
let browser, context, page, csrf, current, settings;
const api=async(path,method='GET',data,status=200)=>{
    const r=await context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-CSRF':csrf||'','X-Tuxee-Client':'web'}});
    assert.equal(r.status(),status,path+': '+await r.text());return r.json();
};
const login=async()=>{
    await wait(async()=>{try{return(await context.request.get(base+'/health',{timeout:1000})).ok();}catch{return false;}},'server readiness');
    csrf=(await api('/login','POST',{username:owner.user,password:owner.password})).csrf;
};
const panel=()=>page.locator('[data-panel=subject]');
const live=()=>panel().locator('.xterm-rows > div').allTextContents();
const has=async text=>wait(async()=>(await live()).join('\n').includes(text),'render '+text);
const key=async name=>{await panel().locator('.xterm-helper-textarea').focus();await page.keyboard.press(name);};
const command=async text=>{await panel().locator('.xterm-helper-textarea').focus();await page.keyboard.insertText(text);await page.keyboard.press('Enter');};
const folder=id=>`${home}/.local/state/tuxee/terminals/${id}`;
const archive=async()=> (await api(`/terminals/${current.id}/archive`)).text;
const create=async(shell='bash')=>{
    await page.goto('about:blank');
    settings={howToSeen:true,theme:'dark',shellCommand:shell,useTuxeePrompt:true,workspaces:[]};
    await api('/settings','PUT',settings);
    current=await api('/terminals','POST',{directory:home,name:shell,columns:120,rows:35},201);
    settings.current='stress';settings.workspaces=[{id:'stress',name:'Stress',columns:4,rows:2,active:'subject',panels:[{id:'subject',kind:'terminal',terminal:current.id,path:home,x:0,y:0,w:4,h:2}]}];
    await api('/settings','PUT',settings);await page.goto(base);
    await panel().locator('.terminal-view[data-state=connected]').waitFor();await has('❯');return current;
};
const evidence=async name=>{
    const rows=await live();
    await page.screenshot({path:`${out}/${name}-live.png`});
    await panel().getByRole('button',{name:'Terminal contents as text',exact:true}).click();
    const text=await page.locator('.terminal-text pre').textContent();
    for(const row of rows.map(s=>s.trimEnd()).filter(Boolean))assert.ok(text.includes(row),`${name}: live row absent from T snapshot: ${row}`);
    await writeFile(`${out}/${name}-transcript.txt`,text);
    await page.screenshot({path:`${out}/${name}-text.png`});await page.keyboard.press('Escape');
    const saved=await archive();assert.equal(run('cat',folder(current.id)+'/output.txt'),saved,'disk/archive mismatch');
    await writeFile(`${out}/${name}-archive.txt`,saved);return text;
};
const ended=async()=>{
    await wait(async()=>(await api('/terminals/'+current.id)).exited,'terminal exit');
    await panel().locator('.terminal-archive pre').waitFor();
    const text=await archive();assert.equal(await panel().locator('.terminal-archive pre').textContent(),text);
    assert.equal(run('cat',folder(current.id)+'/output.txt'),text);
    assert.ok(!text.includes('\x1b'));assert.ok(text.split('\n').length<=5000);return text;
};
try {
    for(const a of accounts){run('useradd','-m','-s','/bin/bash','-c','Tuxee prototype test',a.user);assert.equal(docker(['exec','-i',container,'chpasswd'],`${a.user}:${a.password}\n`).status,0);}
    run('usermod','-a','-G',other.user,owner.user);
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
    context=await browser.newContext({viewport:{width:1440,height:950}});await login();page=await appPage(context);page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    await create();
    const uid=Number(run('id','-u',owner.user)),gid=Number(run('id','-g',owner.user)),groups=run('id','-G',owner.user).trim().split(' ').map(Number);
    const ppid=Number(run('ps','-p',String(current.pid),'-o','ppid='));
    for(const pid of [current.pid,ppid]){
        const status=run('cat',`/proc/${pid}/status`);
        assert.ok(status.match(/^Uid:\s+(.+)$/m)[1].trim().split(/\s+/).every(x=>Number(x)===uid));
        assert.ok(status.match(/^Gid:\s+(.+)$/m)[1].trim().split(/\s+/).every(x=>Number(x)===gid));
        assert.deepEqual(status.match(/^Groups:\s*(.*)$/m)[1].trim().split(/\s+/).map(Number).sort(),groups.sort());
    }
    await command("printf 'PRIVATE_%s\\n' 'OUTPUT'");await has('PRIVATE_OUTPUT');await archive();
    const modes={};
    for(const [path,mode] of [[folder(current.id),700],[folder(current.id)+'/keeper.sock',600],[folder(current.id)+'/meta.json',600],[folder(current.id)+'/output.txt',600]]){
        const actual=run('stat','-c','%u %g %a',path).trim();assert.equal(actual,`${uid} ${gid} ${mode}`);modes[path.split('/').at(-1)]=actual;
    }
    const denied=await browser.newContext();
    const r=await denied.request.post(base+'/api/login',{data:{username:other.user,password:other.password},headers:{'X-Tuxee-Client':'web'}});assert.equal(r.status(),200);
    const token=(await r.json()).csrf;
    for(const [suffix,method,data] of [['','GET'],['','DELETE'],['/archive','GET'],['/archive','DELETE'],['/input-history','GET'],['/input-history','POST',{text:'foreign'}],['/input-draft','GET'],['/input-draft','PUT',{text:'foreign',open:true,revision:''}],['/ws','GET']]){
        const response=await denied.request.fetch(base+'/api/terminals/'+current.id+suffix,{method,data,headers:{'X-Tuxee-Client':'web','X-Tuxee-CSRF':token,Origin:base}});assert.equal(response.status(),404,suffix+' '+method);
    }
    assert.equal(docker(['exec',container,'runuser','-u',other.user,'--','cat',folder(current.id)+'/output.txt']).status,1);
    run('runuser','-u',other.user,'--','python3','-c',`import socket\ns=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)\ntry: s.connect(${JSON.stringify(folder(current.id)+'/keeper.sock')})\nexcept PermissionError: pass\nelse: raise AssertionError('foreign user connected')`);
    await denied.close();pass('Linux UID/GID/groups, private storage/socket, cross-user API and filesystem denial',{uid,gid,groups,modes});
    run('kill','-KILL',String(ppid));
    assert.ok((await ended()).includes('PRIVATE_OUTPUT'));
    pass('guardian SIGKILL wakes the terminal and preserves post-mortem output');

    for(const app of [
        {name:'btop',command:'btop --utf-force --update 60000',ready:'CPU',exit:['q']},
        {name:'micro',command:'micro modern.txt',ready:'modern.txt',edit:['UNSAVED_MICRO 界'],exit:['Control+q','n']},
        {name:'fzf',command:"printf 'alpha\\nbeta\\ngamma\\n' | fzf --border --prompt='PICK> '",ready:'PICK>',edit:['beta'],exit:['Enter']},
        {name:'neovim',command:'nvim -u NONE -n modern.txt',ready:'modern.txt',edit:['i','UNSAVED_NEOVIM 界'],exit:['Escape',':q!','Enter']}
    ]){
        await create();await command(app.command);await has(app.ready);
        if(app.name==='btop'){await key('f');await page.keyboard.insertText('keeper');await key('Enter');}
        for(const item of app.edit||[]){if(item==='i')await key(item);else await page.keyboard.insertText(item);}
        await page.waitForTimeout(300);
        await evidence('modern-'+app.name);
        const pid=current.pid;run('tuxee','restart');await wait(async()=>(await context.request.get(base+'/api/me').catch(()=>null))?.status()===401,'restart revocation');await login();await page.goto(base);
        await panel().locator('.terminal-view[data-state=connected]').waitFor();await has(app.edit?.at(-1)||app.ready);assert.equal((await api('/terminals/'+current.id)).pid,pid);
        for(const size of [{width:390,height:844},{width:1440,height:950}]){await page.setViewportSize(size);await page.waitForTimeout(500);}
        await has(app.edit?.at(-1)||app.ready);
        await wait(async()=>(await archive()).includes(app.edit?.at(-1)||app.ready),app.name+' canonical redraw after resize');
        for(const keyName of app.exit){if(keyName===':q!')await page.keyboard.insertText(keyName);else await key(keyName);}
        await wait(()=>docker(['exec',container,'pgrep','-P',String(current.pid),'-x',app.name==='neovim'?'nvim':app.name]).status===1,app.name+' exit');
        await command("printf 'AFTER_%s\\n' 'MODERN'");await has('AFTER_MODERN');await command('exit');
        const text=await ended();assert.ok(text.includes(app.edit?.at(-1)||app.ready));assert.ok(text.includes('AFTER_MODERN'));
        await writeFile(`${out}/modern-${app.name}-post-mortem.txt`,text);pass(`${app.name}: live/T/disk, retained edits across re-exec, mobile resize, ordered post-mortem`);
    }

    for(const shell of ['bash','zsh','fish']){
        await create(shell);
        for(const length of [16,17,18]){
            const env='v'.repeat(length), inline=`~ in ${env} ❯ `;
            await command(shell==='fish'?`set -gx VIRTUAL_ENV /tmp/${env}; clear`:`export VIRTUAL_ENV=/tmp/${env}; clear`);
            await has(env);await page.waitForTimeout(200);
            const rows=(await live()).map(s=>s.trimEnd()).filter(Boolean);
            assert.deepEqual(rows,inline.length<25?[inline.trimEnd()]:[`~ in ${env}`,'❯']);
            await evidence(`prompt-${shell}-${inline.length}`);
        }
        await command('mkdir -p long-prompt-directory; cd long-prompt-directory');await has('long-prompt-directory');
        await command("git init -q; git checkout -qb keeper-branch");await has('keeper-branch');
        const typed='w'.repeat(160);await panel().locator('.xterm-helper-textarea').focus();
        await page.keyboard.insertText(`printf '%s' '${typed}' > ../wrapped-${shell}.txt`);
        await page.keyboard.press('Control+a');await page.keyboard.insertText(' ');await page.keyboard.press('Control+e');await page.keyboard.press('Enter');
        await wait(()=>run('cat',`${home}/wrapped-${shell}.txt`)===typed,'wrapped line edit');
        await evidence(`prompt-${shell}-branch`);await command('exit');await ended();
        pass(`${shell}: real 24/25/26-column prompts, virtualenv/branch, wrapped line editing and post-mortem`);
    }

    put(home+'/storm.py',`import sys,time\nprint('STORM_READY',flush=True)\ntime.sleep(0.5)\nfor i in range(15000):\n print(f'ROW_{i:05d} '+('abcdef '*9),flush=True)\n if i%100==0: time.sleep(0.004)\nprint('\\x1b[1mBOLD\\x1b[0m \\x1b[3mITALIC\\x1b[0m \\x1b[4mUNDERLINE\\x1b[0m \\x1b[7mINVERSE\\x1b[0m')\nfor i in range(16): print(f'\\x1b[48;5;{i}m  {i:02d}  ',end='')\nprint('\\x1b[0m\\n\\x1b[38;2;54;207;167mTRUECOLOR 界 🦊 é\\x1b[0m')\nfor i in range(1000): print(f'\\rPROGRESS {i:04d}',end='',flush=True)\nprint('\\r\\x1b[2KPROGRESS COMPLETE\\nSTORM_DONE',flush=True)\n`);
    await create();const storm=current;await command('python3 storm.py');await has('STORM_READY');
    const server=run('pgrep','-x','tuxee').trim();assert.match(server,/^\d+$/);run('kill','-KILL',server);
    await wait(async()=>(await context.request.get(base+'/api/me').catch(()=>null))?.status()===401,'session revocation');await login();await page.goto(base);
    await panel().locator('.terminal-view[data-state=connected]').waitFor();await has('STORM_DONE');
    assert.equal((await api('/terminals/'+storm.id)).pid,storm.pid);
    const transcript=await evidence('storm-recovered'), saved=await archive();
    for(const text of [transcript,saved]){
        const rows=[...text.matchAll(/^ROW_(\d{5}) /gm)].map(m=>Number(m[1]));assert.ok(rows.length>1000);assert.equal(rows.at(-1),14999);
        rows.forEach((n,i)=>{if(i)assert.equal(n,rows[i-1]+1,'lost/duplicate/reordered row');});
        assert.ok(text.includes('PROGRESS COMPLETE'));assert.ok(!text.includes('PROGRESS 0999'));assert.ok(text.includes('TRUECOLOR 界 🦊 é'));
    }
    const style=await panel().locator('.xterm-rows span').evaluateAll(nodes=>Object.fromEntries(['BOLD','ITALIC','UNDERLINE','INVERSE','TRUECOLOR'].map(word=>{const n=nodes.find(n=>n.textContent.includes(word));const s=n&&getComputedStyle(n);return[word,s?{weight:s.fontWeight,style:s.fontStyle,decoration:s.textDecorationLine,color:s.color,background:s.backgroundColor}:null];})));
    assert.equal(style.BOLD.weight,'700');assert.equal(style.ITALIC.style,'italic');assert.ok(style.UNDERLINE.decoration.includes('underline'));assert.equal(style.TRUECOLOR.color,'rgb(54, 207, 167)');
    await command('exit');await ended();await page.screenshot({path:out+'/storm-post-mortem.png'});pass('15,000 ordered rows across SIGKILL, bounded archive, SGR/truecolor/Unicode and 1,000 carriage-return redraws',{style,archiveBytes:Buffer.byteLength(saved)});

    assert.deepEqual(errors,[]);
} catch(error){results.push({failure:error.stack});await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});if(current)await archive().then(t=>writeFile(out+'/failure.txt',t)).catch(()=>{});throw error;}
finally{
    await writeFile(out+'/stress.json',JSON.stringify({results,errors},null,2));await browser?.close();
    for(const a of accounts){docker(['exec',container,'pkill','-KILL','-u',a.user]);docker(['exec',container,'userdel','-r',a.user]);}
}
