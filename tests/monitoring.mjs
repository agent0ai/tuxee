import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import './monitor-values.mjs';

const user='tuxee-poc-a',fields=spawnSync('getent',['passwd',user],{encoding:'utf8'}).stdout.trim().split(':');
assert.equal(fields[4],'Tuxee prototype test','refusing unrelated account');
const password=randomBytes(24).toString('base64url');assert.equal(spawnSync('chpasswd',[],{input:`${user}:${password}\n`}).status,0);
const base=process.env.TUXEE_TEST_URL||'https://127.0.0.1:9443';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,hasTouch:true,viewport:{width:1440,height:1000}});
assert.equal((await context.request.get(base+'/api/metrics')).status(),401);
assert.equal((await context.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}})).status(),200);
const me=await(await context.request.get(base+'/api/me')).json();
const api=(path,method='GET',data)=>context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-CSRF':me.csrf,'X-Tuxee-Client':'web'}});
const settings={theme:'dark',idleHours:36,current:'monitor',workspaces:[{id:'monitor',name:'Monitor',columns:4,rows:2,active:'files',panels:[{id:'files',kind:'files',path:'/',x:0,y:0,w:4,h:2}]}]};
assert.equal((await api('/settings','PUT',settings)).status(),200);
const initial=await(await api('/metrics')).json();assert.ok(initial.memory.total>0);assert.ok(initial.cpu.cores>0);assert.ok(initial.disks.some(disk=>disk.path==='/'));assert.ok(initial.networks.length);
const network=initial.networks.find(item=>item.name!=='lo'&&item.state==='up')?.name||initial.networks[0].name;
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
 assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['CPU','RAM','Disk']);
 const tools=await page.locator('.panel-additions').boundingBox(),widget=await summary.boundingBox(),theme=await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).boundingBox();
 assert.ok(tools.x+tools.width<=widget.x&&widget.x+widget.width<theme.x);
 assert.equal(await page.locator('.monitor-controls').evaluate(node=>getComputedStyle(node).borderInlineEndWidth),'1px');
 await page.waitForFunction(()=>document.querySelector('.monitor-summary .monitor-value')?.textContent!=='—');
 await summary.click();await dialog.getByRole('heading',{name:'CPU',exact:true}).waitFor();assert.equal(await dialog.locator('.monitor-card').count(),3);assert.equal(await dialog.locator('.monitor-scope').count(),0);
 assert.ok(await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).isVisible());
 await page.screenshot({path:'test-results/monitoring-desktop.png'});check('authenticated live gauges and CPU/RAM/disk details');
 let cpuPercent=0.24;
 await page.route(base+'/api/metrics',async route=>{const response=await route.fetch(),data=await response.json();data.cpu.percent=cpuPercent;await route.fulfill({response,json:data});});
 const cpuWidth=(await summary.locator('.monitor-chip').first().boundingBox()).width;
 for(const [value,label] of [[0.24,'0.2%'],[0.099,'0%'],[0.1,'0.1%'],[0,'0%'],[10.4,'10%'],[100,'100%']]){
  cpuPercent=value;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(text=>document.querySelector('.monitor-summary .monitor-value')?.textContent===text,label);
  assert.equal(await dialog.locator('.monitor-reading').first().textContent(),label);
  assert.equal((await summary.locator('.monitor-chip').first().boundingBox()).width,cpuWidth);
 }
 await page.unroute(base+'/api/metrics');check('small CPU loads remain visible in the widget and details');
 await dialog.getByRole('button',{name:'Configure resource monitor',exact:true}).click();
 await dialog.getByRole('checkbox',{name:'CPU',exact:true}).uncheck();await dialog.getByRole('checkbox',{name:'Swap',exact:true}).check();await dialog.getByRole('checkbox',{name:network,exact:true}).check();
 await dialog.getByRole('combobox',{name:'Resource monitor refresh',exact:true}).selectOption('5');
 const saved=page.waitForResponse(r=>r.url()===base+'/api/settings'&&r.request().method()==='PUT');await dialog.getByRole('button',{name:'Save resource monitor',exact:true}).click();assert.equal((await saved).status(),200);
 await dialog.locator('.monitor-config').waitFor({state:'detached'});assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['RAM','Swap','Disk',network]);
 const expected={cpu:false,memory:true,swap:true,disks:['/'],networks:[network],interval:5};assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 const invalid={...(await(await api('/me')).json()).settings,monitoring:{...expected,networks:['../../etc/passwd']}};
 assert.equal((await api('/settings','PUT',invalid)).status(),400);assert.deepEqual((await(await api('/me')).json()).settings.monitoring,expected);
 await page.reload();await page.locator('.monitor-summary[data-state=ready]').waitFor();assert.deepEqual(await summary.locator('.monitor-label').allTextContents(),['RAM','Swap','Disk',network]);check('cog config selects swap/disks/interfaces, validates preferences and persists across reload');
 let sample=0,receiveRate=2500,sendRate=12000;
 await page.route(base+'/api/metrics',async route=>{
  const response=await route.fetch(),data=await response.json(),item=data.networks.find(item=>item.name===network);
  data.time=new Date(Date.UTC(2030,0,1)+sample*2000).toISOString();item.receiveRate=receiveRate;item.sendRate=sendRate;
  await route.fulfill({response,json:data});
 });
 await page.reload();await page.locator('.monitor-summary[data-state=ready]').waitFor();
 const networkRing=summary.locator('.monitor-network-ring');
 assert.equal(await networkRing.evaluate(node=>node.style.getPropertyValue('--upload')),'90deg');
 assert.equal(await networkRing.evaluate(node=>node.style.getPropertyValue('--download')),'90deg');
 const duplicate=page.waitForResponse(r=>r.url()===base+'/api/metrics');
 await summary.click();await duplicate;await dialog.locator('.monitor-network-ring').waitFor();
 const widths=await summary.locator('.monitor-chip').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
 async function networkSample(receive,send,downloadText,uploadText) {
  receiveRate=receive;sendRate=send;sample++;
  const response=page.waitForResponse(r=>r.url()===base+'/api/metrics');
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await response;
  await page.waitForFunction(({downloadText,uploadText})=>{
   const reading=document.querySelector('.monitor-summary .monitor-network-value');
   return reading?.querySelector('.monitor-download')?.textContent===`↓${downloadText}`&&reading?.querySelector('.monitor-upload')?.textContent===`↑${uploadText}`;
  },{downloadText,uploadText});
 }
 await networkSample(7500,0,'7.5K','0.0B');
 assert.equal(await networkRing.evaluate(node=>node.style.getPropertyValue('--download')),'135deg','cached polls must not count twice');
 assert.equal(await networkRing.evaluate(node=>node.style.getPropertyValue('--upload')),'0deg');
 for(const [value,label] of [[999,'999B'],[12000,'12K '],[999e6,'999M'],[7.8e6,'7.8M'],[null,'—   ']]){
  await networkSample(value,value,label,label);
  assert.equal(await summary.locator('.monitor-download').textContent(),`↓${label}`);
  assert.equal(await summary.locator('.monitor-upload').textContent(),`↑${label}`);
  assert.deepEqual(await summary.locator('.monitor-chip').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width)),widths);
 }
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.unroute(base+'/api/metrics');
 check('network directions scale independently, cached samples are ignored, and all widget widths stay fixed');
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
} catch(error) {await page.screenshot({path:'test-results/monitoring-failure.png'});console.log({errors});throw error;} finally {await browser.close();}
