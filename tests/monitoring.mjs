import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import './monitor-values.mjs';

const user=process.env.TUXEE_TEST_USER||'tuxee-poc-a',fields=spawnSync('getent',['passwd',user],{encoding:'utf8'}).stdout.trim().split(':');
assert.equal(fields[4],'Tuxee prototype test','refusing unrelated account');
const password=randomBytes(24).toString('base64url');assert.equal(spawnSync('chpasswd',[],{input:`${user}:${password}\n`}).status,0);
const base=process.env.TUXEE_TEST_URL||'https://127.0.0.1:9443';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,hasTouch:true,viewport:{width:1440,height:1000}});
assert.equal((await context.request.get(base+'/api/metrics')).status(),401);
assert.equal((await context.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}})).status(),200);
const me=await(await context.request.get(base+'/api/me')).json(),original=me.settings;
const api=(path,method='GET',data)=>context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-CSRF':me.csrf,'X-Tuxee-Client':'web'}});
const settings={theme:'dark',current:'monitor',workspaces:[{id:'monitor',name:'Monitor',columns:4,rows:2,active:'files',panels:[{id:'files',kind:'files',path:'/',x:0,y:0,w:4,h:2}]}]};
assert.equal((await api('/settings','PUT',settings)).status(),200);
const initial=await(await api('/metrics')).json();assert.ok(initial.memory.total>0);assert.ok(initial.cpu.cores>0);assert.ok(initial.disks.some(disk=>disk.path==='/'));assert.ok(initial.networks.length);
assert.ok(initial.memory.cache>=0);assert.ok(initial.memory.used+initial.memory.cache<=initial.memory.total);
const all='/all',aggregate=initial.networks.find(item=>item.name===all),active=initial.networks.filter(item=>item.name!==all&&['up','unknown'].includes(item.state));
assert.ok(aggregate);assert.equal(aggregate.received,active.reduce((sum,item)=>sum+item.received,0));assert.equal(aggregate.sent,active.reduce((sum,item)=>sum+item.sent,0));
for(const key of ['receiveRate','sendRate'])assert.equal(aggregate[key],active.some(item=>item[key]===null)?null:active.reduce((sum,item)=>sum+item[key],0));
const network=initial.networks.find(item=>item.name!==all&&item.name!=='lo'&&item.state==='up')?.name||initial.networks.find(item=>item.name!==all).name;
const page=await context.newPage(),errors=[],external=[];let polls=0;
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.url()===base+'/api/metrics')polls++;if(!request.url().startsWith(base)&&!['data:','blob:'].includes(new URL(request.url()).protocol))external.push(request.url());});
const check=text=>console.log('PASS '+text),summary=page.locator('.topbar .monitor-summary'),dialog=page.getByRole('dialog',{name:'Resource monitor',exact:true});
const displaySwitch=dialog.getByRole('switch',{name:'Display resource monitor widget',exact:true});
async function setDisplay(visible) {
 const saved=page.waitForResponse(r=>r.url()===base+'/api/settings'&&r.request().method()==='PUT');
 await displaySwitch.setChecked(visible);assert.equal((await saved).status(),200);
 await page.waitForFunction(()=>!document.querySelector('.monitor-display input')?.disabled);
 assert.equal(await displaySwitch.isChecked(),visible);
}
async function openFromMenu() {
 await page.getByRole('button',{name:'User menu',exact:true}).click();
 assert.equal(await page.locator('.popover-menu .monitor-strip').count(),0);
 await page.getByRole('menuitem',{name:'Resource monitor',exact:true}).click();
 await dialog.waitFor();
}
await mkdir('test-results',{recursive:true});
try {
 await page.goto(base);await page.locator('.monitor-summary[data-state=ready]').waitFor();
 assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['CPU','RAM','DISK','NET']);
 const tools=await page.locator('.panel-additions').boundingBox(),widget=await summary.boundingBox(),theme=await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).boundingBox();
 assert.ok(tools.x+tools.width<=widget.x&&widget.x+widget.width<theme.x);
 assert.equal(await page.locator('.monitor-controls').evaluate(node=>getComputedStyle(node).borderInlineEndWidth),'1px');
 await page.waitForFunction(()=>document.querySelector('.monitor-summary .monitor-value')?.textContent!=='—');
 await summary.click();await dialog.getByRole('heading',{name:'CPU',exact:true}).waitFor();assert.equal(await dialog.locator('.monitor-card').count(),4);assert.equal(await dialog.locator('.monitor-scope').count(),0);
 assert.ok(await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).isVisible());
 for(const kind of ['cpu','memory','disk','network']) {
  const header=summary.locator(`[data-kind=${kind}]`),card=dialog.locator(`[data-kind=${kind}]`);
  const shape=node=>({text:node.textContent,classes:[...node.querySelectorAll('*')].map(child=>child.getAttribute('class'))});
  assert.deepEqual(await header.evaluate(shape),await card.evaluate(shape),'cards reuse the header widget');
  const scaled=await card.evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  const compact=await header.evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  assert.ok(scaled>compact);
 }
 assert.ok(await dialog.locator('.monitor-unit').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)<parseFloat(getComputedStyle(node.parentElement).fontSize)&&getComputedStyle(node).color!==getComputedStyle(node.parentElement).color)));
 await page.screenshot({path:'test-results/monitoring-desktop.png'});check('authenticated live default CPU/RAM/DISK/NET meters and active-interface aggregate');
 let cpuPercent=0.24;
 await page.route(base+'/api/metrics',async route=>{const response=await route.fetch(),data=await response.json();data.cpu.percent=cpuPercent;await route.fulfill({response,json:data});});
 const cpuWidth=(await summary.locator('.monitor-chip').first().boundingBox()).width;
 for(const [value,label] of [[0.24,'0.2%'],[0.099,'0.1%'],[0.001,'0%'],[0.5,'0.5%'],[0,'0%'],[1,'1.0%'],[9.94,'9.9%'],[9.95,'10%'],[10.49,'10%'],[99.9,'100%'],[null,'—']]){
  cpuPercent=value;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(text=>document.querySelector('.monitor-summary .monitor-value')?.textContent===text,label);
  assert.equal(await dialog.locator('.monitor-value').first().textContent(),label);
  for(const widget of [summary,dialog]) {
   assert.equal(await widget.locator('.monitor-value').first().locator('.monitor-unit').count(),value===null?0:1);
   assert.ok(await widget.locator('.monitor-value').first().evaluate(node=>node.scrollWidth<=node.clientWidth));
  }
  assert.equal((await summary.locator('.monitor-chip').first().boundingBox()).width,cpuWidth);
 }
 await page.unroute(base+'/api/metrics');check('CPU decimals below ten, zero rounding, separate units and stable widths in the widget and details');
 const MiB=1024**2;
 const defaultMemory={total:1024*MiB,used:64*MiB,available:960*MiB,cache:896*MiB,percent:6.25};
 let memory=defaultMemory;
 await page.route(base+'/api/metrics',async route=>{const response=await route.fetch(),data=await response.json();data.memory=memory;await route.fulfill({response,json:data});});
 const ramCard=dialog.locator('.monitor-card').filter({has:page.getByRole('heading',{name:'RAM',exact:true})});
 const ramChip=summary.locator('.monitor-chip').filter({has:page.getByText('RAM',{exact:true})});
 async function memorySample() {
  const previous=await ramCard.elementHandle();
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(node=>!node.isConnected,previous);await previous.dispose();
 }
 await memorySample();
 for(const theme of ['dark','light']) {
  assert.equal(await ramChip.locator('.monitor-value').textContent(),'64M');
  assert.equal(await ramCard.locator('.monitor-value').textContent(),'64M');
  assert.equal(await ramCard.locator('.monitor-cache').textContent(),'Cache 896.0 MB');
  assert.match(await ramCard.textContent(),/Used 64.0 MB \/ 1.0 GB/);
  assert.match(await summary.getAttribute('aria-description'),/Cache 896.0 MB/);
  assert.ok(await summary.locator('.monitor-label, .monitor-value, .monitor-number, .monitor-unit, .monitor-gauge').evaluateAll(nodes=>nodes.every(node=>node.closest('[title]')===node.closest('.monitor-summary'))),'every part of every header metric must use the shared summary tooltip');
  assert.equal(await ramCard.locator('.monitor-value').getAttribute('title'),'Estimated non-reclaimable memory');
  assert.equal(await ramCard.locator('.monitor-cache').getAttribute('title'),'Estimated reclaimable memory');
  for(const item of [ramChip,ramCard]) {
   const gauge=item.locator('.monitor-gauge');
   assert.equal(await gauge.evaluate(node=>node.style.getPropertyValue('--usage')),'6.25');
   assert.equal(await gauge.evaluate(node=>node.style.getPropertyValue('--cache')),'87.5');
  }
  await ramCard.screenshot({path:`test-results/monitoring-memory-${theme}.png`});
  await summary.screenshot({path:`test-results/monitoring-memory-header-${theme}.png`,style:'.monitor-modal::backdrop { background: transparent; backdrop-filter: none; }'});
  for(const [used,cache] of [[10,90],[90,10],[0,100],[100,0],[0,0],[10,20]]) {
   memory={total:1000*MiB,used:used*10*MiB,available:(100-used)*10*MiB,cache:cache*10*MiB,percent:used};await memorySample();
   for(const widget of [ramChip,ramCard]) {
    const gauge=widget.locator('.monitor-gauge');
    const pixels=await gauge.evaluate(async (node,{png,used,cache})=>{
     const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
     const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
     const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
     const styles=getComputedStyle(node),pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data].slice(0,3),result=[];
     for(const percent of [8,25,50,75,92]) {
      const actual=pixel(Math.floor(image.width/2),Math.floor(image.height*(1-percent/100)));
      ctx.fillStyle=styles.getPropertyValue(percent<used?'--monitor-purple':percent<used+cache?'--monitor-green':'--line');
      ctx.fillRect(0,0,1,1);result.push({percent,actual,expected:pixel(0,0)});
     }
     return result;
    },{png:(await gauge.screenshot({style:'.monitor-modal::backdrop { background: transparent; backdrop-filter: none; }'})).toString('base64'),used,cache});
    for(const pixel of pixels) assert.ok(pixel.actual.every((value,i)=>Math.abs(value-pixel.expected[i])<=12),`${theme} RAM ${used}% + cache ${cache}%: ${JSON.stringify(pixel)}`);
   }
   if(used===10&&cache===90) await ramCard.screenshot({path:`test-results/monitoring-memory-full-${theme}.png`});
  }
  memory=defaultMemory;await memorySample();
  await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();await summary.click();
 }
 await page.setViewportSize({width:320,height:720});await page.waitForTimeout(250);
 assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth));assert.ok(await ramCard.locator('.monitor-cache').isVisible());
 await page.screenshot({path:'test-results/monitoring-memory-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(250);
 memory={total:1024*MiB,used:960*MiB,available:64*MiB,cache:0,percent:93.75};await memorySample();
 assert.equal(await ramCard.locator('.monitor-value').textContent(),'960M');
 assert.equal(await ramCard.locator('.monitor-cache').textContent(),'Cache 0 B');
 assert.equal(await ramCard.locator('.monitor-gauge').evaluate(node=>node.style.getPropertyValue('--cache')),'0');
 for(const [used,label] of [[1,'1.0M'],[1.5,'1.5M'],[9.94,'9.9M'],[9.95,'10M'],[1024,'1.0G']]) {
  memory={...defaultMemory,used:used*MiB,available:(1024-used)*MiB,cache:0,percent:used/1024*100};await memorySample();
  for(const widget of [ramChip,ramCard]) assert.equal(await widget.locator('.monitor-value').textContent(),label);
 }
 memory=null;await memorySample();assert.equal(await ramCard.locator('.monitor-value').textContent(),'—');assert.equal(await ramCard.locator('.monitor-gauge').evaluate(node=>node.style.getPropertyValue('--usage')),'0');
 await page.unroute(base+'/api/metrics');check('hard RAM headlines, purple used/green cache/free stacks in header and modal, binary units and unavailable/zero cache in both themes');
 await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).click();
 assert.ok(await dialog.getByRole('checkbox',{name:'NET',exact:true}).isChecked());
 assert.ok(await dialog.getByText('Sum of all active interfaces',{exact:true}).isVisible());
 const allSaved=page.waitForResponse(r=>r.url()===base+'/api/settings'&&r.request().method()==='PUT');
 await dialog.getByRole('button',{name:'Save resource monitor',exact:true}).click();assert.equal((await allSaved).status(),200);
 await dialog.locator('.monitor-config').waitFor({state:'detached'});assert.deepEqual((await(await api('/me')).json()).settings.monitoring.networks,[all]);
 await page.reload();await page.locator('.monitor-summary[data-state=ready]').waitFor();assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['CPU','RAM','DISK','NET']);
 await summary.click();await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).click();
 assert.ok(await dialog.getByRole('checkbox',{name:'NET',exact:true}).isChecked());await dialog.getByRole('checkbox',{name:'NET',exact:true}).uncheck();
 await dialog.getByRole('checkbox',{name:'CPU',exact:true}).uncheck();await dialog.getByRole('checkbox',{name:'Swap',exact:true}).check();await dialog.getByRole('checkbox',{name:network,exact:true}).check();
 await dialog.getByRole('combobox',{name:'Resource monitor refresh',exact:true}).selectOption('5');
 const saved=page.waitForResponse(r=>r.url()===base+'/api/settings'&&r.request().method()==='PUT');await dialog.getByRole('button',{name:'Save resource monitor',exact:true}).click();assert.equal((await saved).status(),200);
 await dialog.locator('.monitor-config').waitFor({state:'detached'});assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['RAM','SWAP','DISK',network]);
 const expected={cpu:false,memory:true,swap:true,disks:['/'],networks:[network],interval:5};assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 const invalid={...(await(await api('/me')).json()).settings,monitoring:{...expected,networks:['../../etc/passwd']}};
 assert.equal((await api('/settings','PUT',invalid)).status(),400);assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 await page.reload();await page.locator('.monitor-summary[data-state=ready]').waitFor();assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['RAM','SWAP','DISK',network]);check('cog config selects swap/disks/interfaces, validates preferences and persists across reload');
 let receiveRate=2500,sendRate=12000,networkPresent=true;
 await page.route(base+'/api/metrics',async route=>{
  const response=await route.fetch(),data=await response.json(),item=data.networks.find(item=>item.name===network);
  item.receiveRate=receiveRate;item.sendRate=sendRate;
  if(!networkPresent)data.networks=data.networks.filter(item=>item.name!==network);
  await route.fulfill({response,json:data});
 });
 await page.reload();await page.locator('.monitor-summary[data-state=ready]').waitFor();await summary.click();
 const networkChip=summary.locator('[data-kind=network]');
 const networkCard=dialog.locator('.monitor-card').filter({has:page.getByRole('heading',{name:network,exact:true})});
 assert.equal(await networkChip.locator('.monitor-gauge').count(),0);
 assert.equal(await networkCard.locator('.monitor-gauge').count(),0);
 const widths=await summary.locator('.monitor-chip').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
 async function networkSample(receive,send,downloadText,uploadText) {
  receiveRate=receive;sendRate=send;
  const previous=await networkChip.elementHandle();
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(node=>!node.isConnected,previous);await previous.dispose();
  for(const widget of [networkChip,networkCard]) {
   assert.equal(await widget.locator('.monitor-download').textContent(),downloadText);
   assert.equal(await widget.locator('.monitor-upload').textContent(),uploadText);
  }
  assert.deepEqual(await summary.locator('.monitor-chip').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width)),widths);
 }
 for(const [value,label] of [[0.001,'0B'],[999,'999B'],[12000,'12K'],[999e6,'999M'],[7.8e6,'7.8M'],[1e21,'1.0Z'],[null,'—']]) await networkSample(value,value,label,label);
 await networkSample(528.5390883183117,910.6452389215688,'529B','911B');
 const networkDetail=networkCard.locator('p');
 assert.equal(await networkDetail.textContent(),'Download 529 B/s · Upload 911 B/s');
 assert.equal(await summary.locator('.monitor-network-value').getAttribute('aria-label'),'Download 529 B/s · Upload 911 B/s');
 await networkSample(1536.123456,0,'1.5K','0B');
 assert.equal(await networkDetail.textContent(),'Download 1.5 KB/s · Upload 0 B/s');
 await networkSample(1,100,'1.0B','100B');
 networkPresent=false;await networkSample(0,0,'—','—');
 networkPresent=true;await networkSample(9940,1000,'9.9K','1.0K');
 for(const theme of ['dark','light']) {
  for(const width of [1440,1101,1100,900,760,390,320]) {
   await page.setViewportSize({width,height:1000});
   await page.waitForTimeout(150);
   assert.ok(await page.locator('.topbar').evaluate(node=>node.scrollWidth<=innerWidth));
   assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth));
   assert.ok(await dialog.locator('.monitor-card').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)));
   assert.ok(await networkCard.locator('.monitor-network-value').evaluate(node=>node.getBoundingClientRect().right<=node.closest('.monitor-card').getBoundingClientRect().right));
   if(width===1440||width===390) await page.screenshot({path:`test-results/monitoring-meters-${theme}-${width}.png`});
  }
  await page.setViewportSize({width:1440,height:1000});
  await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();await summary.click();
 }
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.unroute(base+'/api/metrics');
 check('network decimals below ten, accessible details, direction arrows, no ratio gauges, missing interfaces and stable bounded widgets in both themes');
 const beforeHidden=polls;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(5200);assert.equal(polls,beforeHidden);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForResponse(r=>r.url()===base+'/api/metrics');assert.ok(polls>beforeHidden);check('hidden tabs pause monitoring and resume on visibility');
 await openFromMenu();assert.ok(await displaySwitch.isChecked());await setDisplay(false);
 assert.equal(await summary.isVisible(),false);assert.equal(await page.locator('.monitor-controls').isVisible(),false);assert.deepEqual((await(await api('/me')).json()).settings.monitoring,{...expected,hidden:true});
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await dialog.waitFor({state:'detached'});
 const afterDisable=polls;await page.waitForTimeout(5200);assert.equal(polls,afterDisable);
 await page.reload();await page.locator('.topbar').waitFor();assert.equal(await summary.isVisible(),false);assert.equal(polls,afterDisable);
 await page.getByRole('button',{name:'User menu',exact:true}).click();await page.getByRole('menuitem',{name:'Resource monitor',exact:true}).waitFor();await page.waitForTimeout(5200);assert.equal(polls,afterDisable,'opening the menu must not restart disabled monitoring');await page.keyboard.press('Escape');
 const quickLook=page.waitForResponse(r=>r.url()===base+'/api/metrics');await openFromMenu();assert.equal((await quickLook).status(),200);
 assert.equal(await displaySwitch.isChecked(),false);assert.equal(await summary.isVisible(),false);assert.equal(await dialog.locator('.monitor-card').count(),4);
 assert.equal((await page.waitForResponse(r=>r.url()===base+'/api/metrics')).status(),200);
 await page.screenshot({path:'test-results/monitoring-disabled.png'});
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});const afterQuickLook=polls;await page.waitForTimeout(5200);assert.equal(polls,afterQuickLook,'closing a quick look must stop polling while display is disabled');await openFromMenu();
 await setDisplay(true);assert.ok(await summary.isVisible());assert.ok(await page.locator('.monitor-controls').isVisible());assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 await page.route(base+'/api/settings',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Save unavailable'})}),{times:1});
 await displaySwitch.uncheck();await dialog.getByText('Save unavailable',{exact:true}).waitFor();assert.ok(await displaySwitch.isChecked());assert.ok(await summary.isVisible());
 assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
 const invalidHidden={...(await(await api('/me')).json()).settings,monitoring:{...expected,hidden:'yes'}};assert.equal((await api('/settings','PUT',invalidHidden)).status(),400);
 check('display switch persists, stops background polling, keeps live menu quick looks and recovers from failed saves');
 await page.setViewportSize({width:900,height:750});await page.waitForTimeout(250);assert.ok(await page.locator('.topbar').evaluate(node=>node.scrollWidth<=innerWidth));assert.equal(await summary.locator('.monitor-more').textContent(),'+1');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);assert.equal(await page.locator('.topbar .monitor-summary').count(),0);
 await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();await page.getByRole('button',{name:'User menu',exact:true}).click();
 const menu=page.locator('.popover-menu');await menu.getByRole('menuitem',{name:'Resource monitor',exact:true}).waitFor();assert.equal(await menu.locator('.monitor-strip').count(),0);assert.equal(await menu.getByRole('menuitem',{name:'Resource monitor',exact:true}).textContent(),'Resource monitor');assert.ok(await menu.evaluate(node=>node.scrollWidth<=node.clientWidth));await page.screenshot({path:'test-results/monitoring-mobile-menu.png'});
 await menu.getByRole('menuitem',{name:'Resource monitor',exact:true}).tap();await dialog.waitFor();assert.equal(await page.locator('.popover-menu').count(),0);assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth));await page.screenshot({path:'test-results/monitoring-mobile.png'});
 await setDisplay(false);await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByRole('button',{name:'User menu',exact:true}).click();
 assert.equal(await menu.locator('.monitor-strip').count(),0);const mobileDisabled=polls;await page.waitForTimeout(5200);assert.equal(polls,mobileDisabled,'mobile menu must not poll when display is disabled');const mobileQuickLook=page.waitForResponse(r=>r.url()===base+'/api/metrics');await menu.getByRole('menuitem',{name:'Resource monitor',exact:true}).tap();await dialog.waitFor();assert.equal((await mobileQuickLook).status(),200);assert.equal(await displaySwitch.isChecked(),false);await setDisplay(true);
 await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).click();assert.ok(await dialog.getByRole('checkbox',{name:network,exact:true}).isChecked());check('mobile menu has a plain Resource monitor button; disabled monitoring polls only while its modal is open');
 for(const checkbox of await dialog.getByRole('checkbox').all())await checkbox.uncheck();await dialog.getByRole('button',{name:'Save resource monitor',exact:true}).click();await dialog.getByText('No metrics selected',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(250);await summary.click();await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).click();await dialog.getByRole('checkbox',{name:'CPU',exact:true}).check();await dialog.getByRole('button',{name:'Save resource monitor',exact:true}).click();await dialog.getByRole('heading',{name:'CPU',exact:true}).waitFor();await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();check('all metrics can be hidden and configuration remains reachable');
 await page.getByRole('button',{name:'User menu',exact:true}).click();await page.getByRole('menuitem',{name:'Log out',exact:true}).click();await page.locator('[name=username]').waitFor();const afterLogout=polls;await page.waitForTimeout(2200);assert.equal(polls,afterLogout);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);check('logout stops polling; no browser exceptions or external assets');
} catch(error) {await page.screenshot({path:'test-results/monitoring-failure.png'});console.log({errors});throw error;} finally {
 await page.goto('about:blank');
 await context.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}});
 const restored=await(await context.request.get(base+'/api/me')).json();
 assert.equal((await context.request.put(base+'/api/settings',{data:original,headers:{'X-Tuxee-CSRF':restored.csrf,'X-Tuxee-Client':'web'}})).status(),200);
 await browser.close();
}
