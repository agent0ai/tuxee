import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const container = process.env.TUXEE_TEST_CONTAINER;
const base = process.env.TUXEE_TEST_URL;
assert.ok(container && base, 'requires a disposable container and its forwarded URL');
const run = (...args) => {
    const r = spawnSync('docker', ['exec', '-i', container, ...args], {encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const user = 'tuxee-poc-keeper', editorFile = `/home/tuxee-poc-keeper/keeper-unsaved-${process.pid}.txt`;
if (spawnSync('docker',['exec',container,'id',user],{stdio:'ignore'}).status !== 0) run('useradd','-m','-s','/bin/bash','-c','Tuxee prototype test',user);
assert.equal(run('getent','passwd',user).split(':')[4],'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('docker',['exec','-i',container,'chpasswd'],{input:`${user}:${password}\n`}).status,0);
const browser = await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const context = await browser.newContext({bypassCSP:true,viewport:{width:1440,height:950}});
context.setDefaultTimeout(15000);
let me; const sessions = [], pages = [], errors = [], generations = [];
const api = (path,method='GET',data) => context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-Client':'web','X-Tuxee-CSRF':me?.csrf||''}});
const login = async () => {
    assert.equal((await api('/login','POST',{username:user,password})).status(),200);
    me=await (await api('/me')).json();
};
const poll = async (fn,message) => { for(let i=0;i<150;i++){try{if(await fn())return;}catch{} await new Promise(r=>setTimeout(r,100));} throw Error(message); };
const bundle = await build({stdin:{contents:`
import {TerminalView} from './web/term';
import {setCSRF} from './web/ui';
import {setTranslations} from './web/i18n';
window.mount = (me,info) => {
 setCSRF(me.csrf); setTranslations(me.i18n);
 window.view = new TerminalView(document.querySelector('#terminal'),{id:info.id,kind:'terminal',terminal:info.id,path:me.user.home,x:0,y:0,w:4,h:2},{user:me.user,defaultDirectory:()=>me.user.home,changed(){},close(){},openTerminal(){}});
 window.terminalText = () => {const b=view.term.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n');};
};`,resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const mount = async (info) => {
    const page=await context.newPage(); pages.push(page); page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/health');
    await page.setContent('<div class="panel"><header class="panel-header"><svg></svg><span class="panel-title">Terminal</span><div class="panel-tools"></div></header><main id="terminal" style="height:800px;width:1400px"></main></div>');
    await page.addStyleTag({content:await readFile('node_modules/@xterm/xterm/css/xterm.css','utf8')});
    await page.addStyleTag({content:await readFile('web/style.css','utf8')});
    await page.addScriptTag({type:'module',content:bundle.outputFiles[0].text});
    await page.waitForFunction(()=>typeof mount==='function');
    await page.evaluate(({me,info})=>mount(me,info),{me,info});
    await page.waitForFunction(()=>view.ready&&!view.resizing);
    return page;
};
const has = async(page,text)=>page.waitForFunction(text=>terminalText().includes(text),text);
const type = async(page,text)=>{await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type(text);};
const press = async(page,key)=>{await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press(key);};
const listen = async page => {
 await page.evaluate(()=>{
  window.audible=0;
  window.audioSocket=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/audio');audioSocket.binaryType='arraybuffer';
  audioSocket.onmessage=e=>{const d=new DataView(e.data);for(let i=8;i<d.byteLength;i+=2)if(Math.abs(d.getInt16(i,true))>128){audible++;break;}};
 });
 await page.waitForFunction(()=>audible>=5);
};
const identity = pid => run('cat',`/proc/${pid}/stat`).split(') ')[1].split(' ').slice(0,20).filter((_,i)=>i===1||i===19);
try {
 await mkdir('test-results/terminal-keeper',{recursive:true});
 await login();
 for(const info of await(await api('/terminals')).json()) if(!info.exited) await api('/terminals/'+info.id,'DELETE');
 const early=await context.newPage();pages.push(early);await early.goto(base+'/health');
 await early.evaluate(()=>new Promise((resolve,reject)=>{
  window.earlyAudio=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/audio');
  earlyAudio.onopen=resolve;earlyAudio.onerror=reject;
 }));
 run('rm','-f',editorFile);
 console.log('Creating real application sessions');
 for(const [name,command] of [['htop','htop'],['mc','mc'],['micro',`micro ${editorFile}`],['GUI','xterm -title keeper-GUI -e bash'],['shell',''],['audio',`python3 -u -c 'import struct,sys; data=struct.pack("<hh",256,512)*4800
while True: sys.stdout.buffer.write(data)' | tuxee-pacat --playback --raw --format=s16le --rate=48000 --channels=2 --latency-msec=20`]]){
  const response=await api('/terminals','POST',{name,command,columns:120,rows:40});
  assert.equal(response.status(),201,await response.text()); const info=await response.json();sessions.push(info);
 }
 let views=[]; for(const info of sessions) {views.push(await mount(info));console.log('Mounted',info.name);}
 await has(views[0],'Tasks:'); await has(views[1],'Help');
 await type(views[2],'UNSAVED keeper text'); await has(views[2],'UNSAVED keeper text');
 await type(views[4],"export KEEPER_VALUE=survived; cd /tmp; printf '\\nSHELL_READY\\n'"); await press(views[4],'Enter'); await has(views[4],'SHELL_READY');
 await views[3].waitForFunction(()=>view.display.state?.windows?.length>0);
 const display=await views[3].evaluate(()=>view.display.state);
 const xid=display.windows[0].id;
 const original=sessions.map(s=>identity(s.pid));
 // Mouse travels through the real xterm event handler and the PTY to both TUIs.
 await views[0].mouse.click(50,22); await press(views[0],'F2'); await has(views[0],'Meters'); await press(views[0],'Escape');
 await press(views[1],'F9'); await has(views[1],'Left'); await press(views[1],'Escape');
 await views[1].mouse.click(650,65);
 await press(views[2],'ArrowLeft'); await press(views[2],'Delete'); await type(views[2],'!');
 const unsaved='UNSAVED keeper tex!';
 await has(views[2],unsaved);
 await listen(views[5]);
 const audioProcesses=run('ps','-u',user,'-o','pid=,comm=').split('\n').filter(line=>line.includes('pulseaudio')).map(line=>Number(line.trim().split(/\s+/)[0]));
 assert.equal(audioProcesses.length,1);
 console.log('Applications and audio ready');
 for(const mode of ['kill','restart','replace','kill']){
  console.log('Testing',mode);
  for(const page of pages.splice(0)) await page.close();
  const before=Number(run('pgrep','-x','tuxee').split('\n')[0]);
  if(mode==='replace') {
   if(process.env.TUXEE_REPLACEMENT_BINARY) assert.equal(spawnSync('docker',['cp',process.env.TUXEE_REPLACEMENT_BINARY,container+':/usr/local/lib/tuxee/tuxee.next']).status,0);
   else run('cp','/usr/local/lib/tuxee/tuxee','/usr/local/lib/tuxee/tuxee.next');
   run('sh','-c','chmod 755 /usr/local/lib/tuxee/tuxee.next && mv /usr/local/lib/tuxee/tuxee.next /usr/local/lib/tuxee/tuxee');
  }
  if(mode==='kill') run('kill','-KILL',String(before)); else run('/usr/local/bin/tuxee','restart');
  await poll(async()=>{const response=await context.request.get(base+'/api/me'); return response.status()===401;},'old login survived restart');
  await poll(async()=>{await login();return true;},'restart did not become ready');
  for(let i=0;i<sessions.length;i++){
   const restored=await(await api('/terminals/'+sessions[i].id)).json();
   assert.equal(restored.pid,sessions[i].pid,`${mode}: shell replaced`);
   assert.deepEqual(identity(restored.pid),original[i],`${mode}: process identity changed`);
  }
  views=[];for(const info of sessions) views.push(await mount(info));
  await views[3].waitForFunction(xid=>view.display.state?.windows?.some(w=>w.id===xid),xid);
  await listen(views[5]);
  for(const pid of audioProcesses) run('kill','-0',String(pid));
  await has(views[2],unsaved.trim()); await has(views[0],'Tasks:'); await has(views[1],'Help');
  await type(views[4],"printf '\\nSTATE=%s:%s\\n' \"$KEEPER_VALUE\" \"$PWD\"");await press(views[4],'Enter');await has(views[4],'STATE=survived:/tmp');
  generations.push({mode,server:Number(run('pgrep','-x','tuxee').split('\n')[0]),pids:sessions.map(s=>s.pid),xid});
 }
 await press(views[2],'Control+s');
 await poll(()=>run('cat',editorFile)==='UNSAVED keeper tex!','Micro did not save the retained edit');
 for(let i=0;i<3;i++)await views[i].screenshot({path:`test-results/terminal-keeper/survived-${sessions[i].name}.png`});
 assert.deepEqual(errors,[]);
 // Pause only this container's supervisor to observe cleanup while Go is absent.
 const server=Number(run('pgrep','-x','tuxee').split('\n')[0]);
 const supervisor=Number(run('ps','-p',String(server),'-o','ppid='));
 run('kill','-STOP',String(supervisor));
 try {
  run('kill','-KILL',String(server));
  for(const session of sessions) run('kill','-KILL',String(session.pid));
  await poll(()=>audioProcesses.every(pid=>spawnSync('docker',['exec',container,'kill','-0',String(pid)],{stdio:'ignore'}).status!==0),'audio survived its last terminal while Go was absent');
 } finally { run('kill','-CONT',String(supervisor)); }
 await poll(async()=>{await login();return true;},'server did not recover after offline cleanup');
 await writeFile('test-results/terminal-keeper/crash-integration.json',JSON.stringify({generations,unsaved,errors,offlineAudioCleanup:true},null,2));
 console.log(JSON.stringify({checks:'htop, mc, micro edits, GUI identity, shell state; four crash/restart/replacement cycles',generations},null,2));
} catch(error) {
 for(let i=0;i<pages.length;i++) { console.log('screen',i,await pages[i].evaluate(()=>terminalText()).catch(()=>'')); await pages[i].screenshot({path:`test-results/terminal-keeper/failure-${i}.png`}).catch(()=>{}); }
 throw error;
} finally {
 for(const page of pages) await page.close().catch(()=>{});
 for(const s of sessions){const response=await api('/terminals/'+s.id,'DELETE').catch(()=>null);if(response)assert.equal(response.status(),200,await response.text());}
 await browser.close();
}
