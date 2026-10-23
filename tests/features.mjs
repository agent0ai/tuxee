import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { chromium } from 'playwright';
import './editor-page.mjs';
const user=process.env.TUXEE_TEST_USER||'tuxee-poc-a',fields=spawnSync('getent',['passwd',user],{encoding:'utf8'}).stdout.trim().split(':');
assert.equal(fields[4],'Tuxee prototype test');
const password=randomBytes(24).toString('base64url');assert.equal(spawnSync('chpasswd',[],{input:`${user}:${password}\n`}).status,0);
const home=fields[5],dir=home+'/tuxee-fixtures/features';await rm(dir,{recursive:true,force:true});await mkdir(dir,{recursive:true});
for(const name of ['folder-a','folder-b','destination'])await mkdir(`${dir}/${name}`);
for(const [name,data] of [['alpha.txt','alpha'],['bravo.txt','bravo'],['charlie.txt','charlie'],['script.js','const initial = 1;\n'],['windows.txt','original\r\nsecond\r\n'],['folder-a/inside.txt','nested']])await writeFile(`${dir}/${name}`,data);
const markdown='# Heading\n\n## Subheading\n\n- List item\n\n1. Ordered item\n\n`inline code`\n\n```js\nconst fenced = 1;\n```\n\n[Link](https://example.invalid)\n\n> Quote\n\n**Bold** and *italic* and ~~removed~~\n';
await writeFile(`${dir}/syntax.md`,markdown);
const xml='<?xml version="1.0"?>\n<!-- configuration -->\n<config xmlns:app="urn:tuxee"><app:item enabled="true"><![CDATA[a < b]]></app:item></config>\n';
await writeFile(`${dir}/syntax.xml`,xml);
const pagedText = Array.from({length:22000},(_,i)=>`line ${i}\r\n`).join('');
await writeFile(`${dir}/paged.txt`,pagedText);
await writeFile(`${dir}/wrapped.txt`,'w'.repeat(2001)+'\r\nlast\n');
await writeFile(`${dir}/binary.dat`,Buffer.from([0x7f,0x45,0x4c,0x46,0,1,2]));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
await writeFile(`${dir}/photo-a.png`,png);await writeFile(`${dir}/photo-b.png`,png);
await writeFile(`${dir}/photo-a.txt`,'skip text between images');
await writeFile(`${dir}/photo-z.png`,await readFile(new URL('../assets/tuxee-logo-vertical.png',import.meta.url)));
const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);await writeFile(`${dir}/sound.wav`,wav);
const pdfText='BT /F1 18 Tf 20 100 Td (Tuxee PDF test) Tj ET\n';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;await writeFile(`${dir}/document.pdf`,pdf);
const controls=dir+'/controls';await mkdir(controls+'/z-folder',{recursive:true});await mkdir(controls+'/z-rows');
for(const folder of [controls,controls+'/z-folder'])for(const [name,data,date] of [['a.txt','a',3],['b.txt','bbb',1],['c.txt','cc',2]]){await writeFile(`${folder}/${name}`,data);await utimes(`${folder}/${name}`,new Date(2020,0,date),new Date(2020,0,date));}
for(let i=0;i<70;i++)await writeFile(`${controls}/z-rows/row-${String(i).padStart(2,'0')}.txt`,'row');
assert.equal(spawnSync('chown',['-R',`${fields[2]}:${fields[3]}`,dir]).status,0);
const base=process.env.TUXEE_TEST_URL||'https://127.0.0.1:9443',browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,hasTouch:true,permissions:['clipboard-read','clipboard-write'],viewport:{width:1440,height:1000}});
await context.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}});
let me=await(await context.request.get(base+'/api/me')).json();
const api=(path,method='GET',data,headers={})=>context.request.fetch(base+'/api'+path,{method,data,headers:{'X-Tuxee-CSRF':me.csrf,'X-Tuxee-Client':'web',...headers}});
for (const terminal of await(await api('/terminals')).json()) if (!terminal.attached) await api(`/terminals/${terminal.id}`,'DELETE');
await api('/terminals','POST',{directory:home,name:'Detached regression',columns:80,rows:24});
const profile=fileURLToPath(new URL('../docker/tuxee.profile.sh',import.meta.url));
const promptSession=await(await api('/terminals','POST',{directory:home,name:'Prompt',command:`exec /bin/bash --noprofile --rcfile '${profile.replaceAll("'", "'\\''")}' -i`,columns:80,rows:24})).json();
const settings={theme:'dark',current:'features',workspaces:[{id:'features',name:'Features',columns:4,rows:2,active:'files',panels:[{id:'files',kind:'files',path:dir,x:0,y:0,w:2,h:2},...Array.from({length:4},(_,i)=>({id:`terminal-${i}`,terminal:i===0?promptSession.id:undefined,kind:'terminal',path:home,x:2+i%2,y:Math.floor(i/2),w:1,h:1}))]}]};
assert.equal((await api('/settings','PUT',settings)).status(),200);
const page=await context.newPage(),errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base)&&!['data:','blob:','chrome-extension:','chrome:'].includes(new URL(request.url()).protocol))external.push(request.url())});
const check=message=>console.log('PASS '+message),file=page.locator('.file-view').first(),row=name=>file.locator('.file-entry').filter({has:page.locator('.file-name span',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
async function openedName() { return (await file.locator('..').locator('.path-input').inputValue()).split('/').pop(); }
async function processStopped(pid) {
 for(let i=0;i<100;i++){if(spawnSync('kill',['-0',String(pid)]).status!==0)return;await new Promise(resolve=>setTimeout(resolve,25));}
 assert.fail(`terminal process ${pid} is still alive`);
}
async function refresh(){await file.getByRole('button',{name:'Refresh files',exact:true}).click();await page.waitForTimeout(100);}
async function dragFiles(source,target,modifierTiming='during',modifier='Control'){
 await source.scrollIntoViewIfNeeded();const a=await source.boundingBox(),b=await target.boundingBox();
 await page.mouse.move(a.x+Math.min(60,a.width/2),a.y+a.height/2);if(modifierTiming==='before')await page.keyboard.down(modifier);
 await page.mouse.down();await page.mouse.move(a.x+Math.min(60,a.width/2)+20,a.y+a.height/2+4,{steps:4});
 if(modifierTiming==='during')await page.keyboard.down(modifier);
 await page.mouse.move(b.x+b.width/2,b.y+Math.min(b.height-4,24),{steps:15});await page.mouse.move(b.x+b.width/2+1,b.y+Math.min(b.height-4,24));
 assert.equal(await target.evaluate(node=>node.closest('.panel')?.querySelector('.file-view')?.getAttribute('data-drop')),modifierTiming==='none'?'Move here':'Copy here');
 const feedback=await page.locator('.file-drag-label').textContent();assert.equal(await page.locator('.file-drag-group').textContent(),feedback,'operation hints belong only to the drop target');await page.mouse.up();if(modifierTiming!=='none')await page.keyboard.up(modifier);return feedback;
}
try{
 await page.goto(base);await row('alpha.txt').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.terminal-view[data-state=connected]').length===4);
 assert.equal(await page.locator('.panel-header > svg, .panel-header .terminal-tab > svg').count(),5);
 await page.waitForFunction(()=>{const spans=[...document.querySelector('[data-panel=terminal-0] .xterm-rows').querySelectorAll('span')];const green=spans.find(s=>s.textContent.includes('@')),blue=spans.find(s=>s.textContent.includes('~'));if(!green||!blue)return false;const g=getComputedStyle(green).color.match(/\d+/g).map(Number),b=getComputedStyle(blue).color.match(/\d+/g).map(Number);return g[1]>g[0]&&g[1]>g[2]&&b[2]>b[0]});check('8020 shell profile renders a green user/host and blue directory');
 const plus=await page.getByRole('button',{name:'New workspace',exact:true}).boundingBox(),tab=await page.locator('.workspace-tab-item.active').boundingBox();assert.ok(plus.x-tab.x-tab.width<15);
 const add=await page.getByRole('button',{name:'Add file browser',exact:true}).boundingBox(),monitor=await page.locator('.topbar .monitor-summary').boundingBox(),theme=await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).boundingBox();assert.ok(add.x>plus.x+plus.width&&add.x+add.width<monitor.x&&monitor.x+monitor.width<theme.x);check('workspace plus follows tabs; component tools precede the monitor and theme control');
 await row('alpha.txt').locator('.file-name').click();await page.keyboard.type('brav');await page.waitForFunction(()=>document.querySelectorAll('.file-view .file-entry').length===1);assert.equal(await file.locator('.file-entry .file-name span').textContent(),'bravo.txt');assert.equal(await file.getByRole('searchbox',{name:'Filter files'}).inputValue(),'brav');assert.ok(await file.getByRole('searchbox',{name:'Filter files'}).evaluate(node=>node===document.activeElement));await page.keyboard.press('Escape');await row('alpha.txt').waitFor();
 await row('alpha.txt').locator('.file-name').click();await page.keyboard.press('Shift+ArrowDown');assert.equal(await file.locator('.file-entry[aria-selected=true]').count(),2);await page.keyboard.press('Shift+ArrowDown');assert.equal(await file.locator('.file-entry[aria-selected=true]').count(),3);await page.keyboard.press('Shift+ArrowUp');assert.equal(await file.locator('.file-entry[aria-selected=true]').count(),2);check('type-to-filter and extending/shrinking Shift-arrow selection');
 const list=file.locator('.file-list'),filter=file.getByRole('searchbox',{name:'Filter files'}),filterButton=file.getByRole('button',{name:'Filter files',exact:true});
 await filterButton.click();assert.ok(await filter.evaluate(node=>node===document.activeElement));await filter.fill('ALPHA');assert.deepEqual(await file.locator('.file-name span').allTextContents(),['alpha.txt']);
 await filter.fill('no matching entry');await file.getByText('No matches',{exact:true}).waitFor();await filterButton.click();assert.equal(await filter.isVisible(),false);await row('alpha.txt').waitFor();
 const navigate=async path=>{await file.locator('..').getByRole('textbox',{name:'File or directory path'}).fill(path);const response=page.waitForResponse(r=>r.url().endsWith('/api/files')&&r.request().postDataJSON()?.operation==='list'&&r.request().postDataJSON()?.path===path);await file.locator('..').getByRole('textbox',{name:'File or directory path'}).press('Enter');assert.equal((await response).status(),200);await file.locator('.file-list:not(.loading)').waitFor();};
 const names=()=>file.locator('.file-name span').allTextContents(),selected=()=>file.locator('.file-entry[aria-selected=true] .file-name span').allTextContents();
 await navigate(controls);const defaultNames=await names();assert.deepEqual(defaultNames,['z-folder','z-rows','a.txt','b.txt','c.txt']);
 const nameSort=file.getByRole('button',{name:'Sort by Name',exact:true}),sizeSort=file.getByRole('button',{name:'Sort by Size',exact:true}),dateSort=file.getByRole('button',{name:'Sort by Modified',exact:true});
 await nameSort.click();assert.deepEqual(await names(),['a.txt','b.txt','c.txt','z-folder','z-rows']);assert.equal(await nameSort.locator('.sort-indicator').textContent(),'▲');
 await nameSort.click();assert.deepEqual(await names(),['z-rows','z-folder','c.txt','b.txt','a.txt']);assert.equal(await nameSort.locator('.sort-indicator').textContent(),'▼');
 await row('z-folder').locator('.file-name').dblclick();await row('a.txt').waitFor();await file.locator('.file-list:not(.loading)').waitFor();assert.deepEqual(await names(),['c.txt','b.txt','a.txt']);assert.equal(await nameSort.locator('.sort-indicator').textContent(),'▼');
 await file.getByRole('button',{name:'Parent directory',exact:true}).click();await row('z-folder').waitFor();await nameSort.click();assert.deepEqual(await names(),defaultNames);assert.equal(await nameSort.locator('.sort-indicator').textContent(),'');
 for(const [heading,expected] of [[sizeSort,['a.txt','c.txt','b.txt']],[dateSort,['b.txt','c.txt','a.txt']]]){
  await heading.click();assert.deepEqual((await names()).filter(name=>name.endsWith('.txt')),expected);assert.equal(await heading.locator('.sort-indicator').textContent(),'▲');
  await heading.click();assert.deepEqual((await names()).filter(name=>name.endsWith('.txt')),expected.toReversed());assert.equal(await heading.locator('.sort-indicator').textContent(),'▼');
  await heading.click();assert.deepEqual(await names(),defaultNames);assert.equal(await heading.locator('.sort-indicator').textContent(),'');
 }
 check('editable footer filter and three-state Name/Size/Modified sorting; sorting survives folder navigation');
 await row('a.txt').locator('.file-name').click();const bounds=await list.boundingBox();await page.mouse.click(bounds.x+10,bounds.y+200);assert.deepEqual(await selected(),[]);
 await page.mouse.click(bounds.x+10,bounds.y+200,{button:'right'});assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['New file','New folder','Properties']);
 await page.getByRole('menuitem',{name:'New file',exact:true}).click();await page.getByLabel('File name',{exact:true}).fill('created.txt');await page.getByRole('button',{name:'Continue',exact:true}).click();await row('created.txt').waitFor();assert.equal((await stat(controls+'/created.txt')).size,0);assert.equal((await stat(controls+'/created.txt')).uid,Number(fields[2]));
 await page.mouse.click(bounds.x+10,bounds.y+240,{button:'right'});await page.getByRole('menuitem',{name:'New folder',exact:true}).click();await page.getByLabel('Folder name',{exact:true}).fill('created-folder');await page.getByRole('button',{name:'Continue',exact:true}).click();await row('created-folder').waitFor();assert.ok((await stat(controls+'/created-folder')).isDirectory());
 await file.getByRole('button',{name:'New file',exact:true}).click();await page.getByLabel('File name',{exact:true}).fill('a.txt');const collision=page.waitForResponse(r=>r.url().includes('/api/upload?'));await page.getByRole('button',{name:'Continue',exact:true}).click();assert.equal((await collision).status(),400);assert.equal(await readFile(controls+'/a.txt','utf8'),'a');
 await row('a.txt').locator('.file-name').click({button:'right'});assert.equal(await page.getByRole('menuitem',{name:'New file',exact:true}).count(),0);assert.equal(await page.getByRole('menuitem',{name:'New folder',exact:true}).count(),0);await page.keyboard.press('Escape');
 check('background menus create real empty files/folders as the signed-in user; existing files remain intact');
 const properties=page.getByRole('dialog',{name:'Properties',exact:true}),property=name=>properties.locator('dt').filter({hasText:new RegExp('^'+name+'$')}).evaluate(node=>node.nextElementSibling.textContent);
 await file.getByRole('button',{name:'Properties',exact:true}).click();await properties.waitFor();assert.equal(await property('Path'),controls+'/a.txt');await properties.getByRole('button',{name:'Close dialog',exact:true}).click();
 await row('b.txt').locator('.file-name').click({modifiers:['Control']});await file.getByRole('button',{name:'Properties',exact:true}).click();await properties.waitFor();assert.equal(await property('Name'),'2 items');await properties.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.mouse.click(bounds.x+10,bounds.y+bounds.height-30,{button:'right'});await page.getByRole('menuitem',{name:'Properties',exact:true}).click();await properties.waitFor();assert.equal(await property('Path'),controls);assert.equal(await property('Type'),'Directory');assert.deepEqual(await selected(),[]);await properties.getByRole('button',{name:'Close dialog',exact:true}).click();
 await navigate(controls+'/created-folder');await file.getByRole('button',{name:'Properties',exact:true}).click();await properties.waitFor();assert.equal(await property('Path'),controls+'/created-folder');assert.equal(await property('Type'),'Directory');
 await properties.getByRole('textbox',{name:'Permissions',exact:true}).fill('0750');await properties.getByRole('button',{name:'Save permissions',exact:true}).click();await properties.waitFor({state:'detached'});await file.locator('.file-list:not(.loading)').waitFor();assert.equal((await stat(controls+'/created-folder')).mode&0o777,0o750);
 await navigate('/');await file.getByRole('button',{name:'Properties',exact:true}).click();await properties.waitFor();assert.equal(await property('Path'),'/');assert.equal(await property('Type'),'Directory');await properties.getByRole('button',{name:'Close dialog',exact:true}).click();await navigate(controls);
 check('background Properties targets the current folder; footer handles empty folders/root, permissions and selected files');
 // Selected rows drag their group anywhere; unselected stats and margins start rectangles.
 const aBox=await row('a.txt').boundingBox(),bBox=await row('b.txt').boundingBox(),cBox=await row('c.txt').boundingBox(),aName=await row('a.txt').locator('.file-name').boundingBox();
 assert.equal(aName.y,aBox.y);assert.equal(aName.height,aBox.height);assert.equal(aBox.y+aBox.height,bBox.y);
 await page.mouse.move(aName.x+10,aName.y+1);await page.mouse.down();assert.deepEqual(await selected(),[]);await page.mouse.up();assert.deepEqual(await selected(),['a.txt']);
 await row('c.txt').locator('.file-name').click({modifiers:['Control']});
 await page.mouse.move(aName.x+10,aBox.y+aBox.height-1);await page.mouse.down();await page.mouse.move(aName.x+30,aBox.y+aBox.height+10,{steps:4});
 assert.equal(await page.locator('.file-drag-label').textContent(),'2 files');assert.equal(await file.locator('.file-selection-box').count(),0);await page.keyboard.press('Escape');await page.mouse.up();
 const aSize=await row('a.txt').locator('.file-size').boundingBox(),blankX=(aName.x+aName.width+aSize.x)/2;
 assert.ok(blankX>aName.x+aName.width);
 const aDate=await row('a.txt').locator('.file-date').boundingBox();
 for(const x of [blankX,aSize.x+aSize.width/2,aDate.x+aDate.width/2,aBox.x+aBox.width-2]){
  await page.mouse.move(x,aBox.y+2);await page.mouse.down();assert.deepEqual(await selected(),['a.txt','c.txt']);assert.equal(await page.locator('.file-drag-group').count(),0);
  await page.mouse.move(x,cBox.y+cBox.height-2,{steps:8});await page.locator('.file-drag-group').waitFor();
  assert.equal(await page.locator('.file-drag-label').textContent(),'2 files');assert.equal(await file.locator('.file-selection-box').count(),0);assert.deepEqual(await selected(),['a.txt','c.txt']);
  await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await selected(),['a.txt','c.txt']);
 }
 await row('created.txt').locator('.file-name').click();
 await page.mouse.move(blankX,aBox.y+2);await page.mouse.down();assert.deepEqual(await selected(),['created.txt']);assert.equal(await page.locator('.file-drag-group').count(),0);
 await page.mouse.move(blankX,cBox.y+cBox.height-2,{steps:12});await file.locator('.file-selection-box').waitFor();assert.equal(await page.locator('.file-drag-group').count(),0);await page.screenshot({path:'test-results/features-selection.png'});await page.mouse.up();assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);
 const pasteTarget=page.locator('[data-panel=terminal-0] .terminal-view'),pasteBox=await pasteTarget.boundingBox();
 await page.mouse.move(cBox.x+cBox.width-2,cBox.y+cBox.height/2);await page.mouse.down();await page.mouse.move(pasteBox.x+pasteBox.width/2,pasteBox.y+pasteBox.height/2,{steps:12});
 assert.equal(await page.locator('.file-drag-label').textContent(),'3 files');assert.equal(await file.locator('.file-selection-box').count(),0);assert.equal(await pasteTarget.getAttribute('data-drop'),'Paste');await page.mouse.up();
 await page.waitForFunction(paths=>paths.every(path=>document.querySelector('[data-panel=terminal-0] .xterm-rows').textContent.includes(`'${path}'`)),['a.txt','b.txt','c.txt'].map(name=>`${controls}/${name}`));
 assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);await pasteTarget.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Control+u');
 check('selected rows drag the full group from blank space, stats and edges; a rectangle-selected group pastes every path into a real terminal');
 await page.mouse.click(bounds.x+10,bounds.y+bounds.height-30);
 await page.mouse.move(cBox.x+cBox.width-10,cBox.y+cBox.height-2);await page.mouse.down();await page.mouse.move(aBox.x+aBox.width-20,aBox.y+2,{steps:12});await page.mouse.up();assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);
 await row('created.txt').locator('.file-name').click();await page.keyboard.down('Control');await page.mouse.move(aBox.x+aBox.width-10,aBox.y+2);await page.mouse.down();await page.mouse.move(cBox.x+cBox.width-20,cBox.y+cBox.height-2,{steps:12});await page.mouse.up();await page.keyboard.up('Control');assert.deepEqual(await selected(),['a.txt','b.txt','c.txt','created.txt']);
 await page.mouse.move(bounds.x+10,bounds.y+2);await page.mouse.down();await page.mouse.move(aBox.x+30,aBox.y+20,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await selected(),['a.txt','b.txt','c.txt','created.txt']);assert.equal(await file.locator('.file-selection-box').count(),0);
 const stats=await row('a.txt').locator('.file-size').boundingBox();await page.mouse.move(stats.x+stats.width/2,stats.y+stats.height/2);await page.mouse.down();assert.deepEqual(await selected(),['a.txt','b.txt','c.txt','created.txt']);await page.mouse.up();assert.deepEqual(await selected(),['a.txt']);
 await navigate(controls+'/z-rows');const firstBox=await row('row-00.txt').boundingBox(),scrollBounds=await list.boundingBox();
 await page.mouse.move(firstBox.x+firstBox.width-10,firstBox.y+2);await page.mouse.down();await page.mouse.move(scrollBounds.x+30,scrollBounds.y+scrollBounds.height+35,{steps:15});
 await page.waitForFunction(()=>document.querySelector('.file-list').scrollTop>200);assert.ok(await file.locator('.file-entry[aria-selected=true]').count()>20);const scrolled=await list.evaluate(node=>node.scrollTop);
 await page.mouse.move(scrollBounds.x+30,scrollBounds.y-25,{steps:8});await page.waitForFunction(before=>document.querySelector('.file-list').scrollTop<before,scrolled);await page.mouse.up();const stopped=await list.evaluate(node=>node.scrollTop);await page.waitForTimeout(100);assert.equal(await list.evaluate(node=>node.scrollTop),stopped);assert.equal(await file.locator('.file-selection-box').count(),0);
 check('rectangle selection from stats/margins supports reverse/additive drags, cancellation and edge auto-scroll');
 await navigate(controls);
 const clickRow=async(name,area,count=1)=>{
  const point=await row(name).evaluate((node,area)=>{
   const rect=node.getBoundingClientRect(),name=node.querySelector('.file-name').getBoundingClientRect(),size=node.querySelector('.file-size').getBoundingClientRect(),date=node.querySelector('.file-date').getBoundingClientRect();
   const x=area==='name'?name.left+12:area==='blank'?(name.right+size.left)/2:area==='size'?size.left+size.width/2:area==='date'?date.left+date.width/2:rect.right-2;
   return {x,y:rect.top+rect.height/2};
  },area);
  await page.mouse.click(point.x,point.y,{clickCount:count});
 };
 for(const area of ['name','blank','size','date','right']){
  await clickRow('a.txt',area);assert.deepEqual(await selected(),['a.txt']);
  assert.ok(await row('a.txt').evaluate(node=>node===document.activeElement));
  assert.equal(await file.locator('.file-selection-box').count(),0);
  await clickRow('a.txt',area,2);await file.locator('.cm-content').waitFor();assert.equal(await openedName(),'a.txt');
  assert.equal(await readFile(controls+'/a.txt','utf8'),'a');
  await file.getByRole('button',{name:'Back to files',exact:true}).click();await file.locator('.file-inspector').waitFor({state:'detached'});await file.locator('.file-list:not(.loading)').waitFor();
  await clickRow('z-folder',area,2);await page.waitForFunction(path=>document.querySelector('.path-input').value===path,controls+'/z-folder');await file.locator('.file-list:not(.loading)').waitFor();
  await file.getByRole('button',{name:'Parent directory',exact:true}).click();await page.waitForFunction(path=>document.querySelector('.path-input').value===path,controls);await file.locator('.file-list:not(.loading)').waitFor();
 }
 await row('a.txt').locator('.file-size').click();await row('c.txt').locator('.file-date').click({modifiers:['Shift']});assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);
 await row('b.txt').locator('.file-size').click({modifiers:['Control']});assert.deepEqual(await selected(),['a.txt','c.txt']);
 await row('b.txt').locator('.file-date').click({modifiers:['Meta']});assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);
 const cancelBox=await row('created.txt').boundingBox();await page.mouse.move(cancelBox.x+cancelBox.width-10,cancelBox.y+cancelBox.height/2);await page.mouse.down();
 await page.mouse.move(aBox.x+20,aBox.y+2,{steps:8});await file.locator('.file-selection-box').waitFor();await page.keyboard.press('Escape');await page.mouse.up();assert.deepEqual(await selected(),['a.txt','b.txt','c.txt']);
 assert.equal(await file.locator('.file-inspector').count(),0);assert.equal(await page.locator('.file-drag-group').count(),0);
 await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height-10);assert.deepEqual(await selected(),[]);
 check('whole-row clicks and double-clicks work at the name, middle, size, date and far edge; modifier selection, background deselection and cancelled drags remain intact');
 await navigate(dir);
 const folderIcon=row('folder-a').locator('.file-name svg'),fileIcon=row('alpha.txt').locator('.file-name svg');
 assert.ok(await folderIcon.evaluate(node=>getComputedStyle(node).fill===getComputedStyle(node).color));assert.equal(await fileIcon.evaluate(node=>getComputedStyle(node).fill),'none');
 await row('folder-a').locator('.file-name').click();await row('folder-b').locator('.file-name').click({modifiers:['Control']});await row('alpha.txt').locator('.file-name').click({modifiers:['Control']});
 const zipEvent=page.waitForEvent('download'),beforeZIP=await readdir(dir);
 await row('folder-a').locator('.file-name').click({button:'right'});await page.getByRole('menuitem',{name:'Download',exact:true}).click();
 const zipDownload=await zipEvent;assert.equal(zipDownload.suggestedFilename(),'features.zip');await zipDownload.saveAs('test-results/selected.zip');
 const unzip=spawnSync('python3',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert set(z.namelist())=={\"folder-a/\",\"folder-a/inside.txt\",\"folder-b/\",\"alpha.txt\"}; assert z.read(\"folder-a/inside.txt\")==b\"nested\"; assert z.read(\"alpha.txt\")==b\"alpha\"','test-results/selected.zip'],{encoding:'utf8'});assert.equal(unzip.status,0,unzip.stderr);
 await page.waitForFunction(()=>[...document.querySelectorAll('.transfer')].some(node=>/Zipping & downloading features\.zip.*ZIP.*Done/.test(node.textContent)));
 assert.deepEqual(await readdir(dir),beforeZIP);check('filled folders stay distinct from files; mixed selections stream one ZIP with size/progress and no temporary archive');
 // Assert real pointer input, backend operations and on-disk data, not dispatched drop events.
 await page.evaluate(()=>{window.nativeDrags=0;document.addEventListener('dragstart',()=>window.nativeDrags++);window.fileOperations=[];const originalFetch=fetch;window.fetch=(input,init)=>{if(String(input).endsWith('/api/files')&&init?.body){const op=JSON.parse(init.body);if(['move','copy'].includes(op.operation))window.fileOperations.push(op)}return originalFetch(input,init)}});
 await row('folder-a').locator('.file-name').click();await row('folder-b').locator('.file-name').click({modifiers:['Control']});await row('alpha.txt').locator('.file-name').click({modifiers:['Control']});await row('bravo.txt').locator('.file-name').click({modifiers:['Control']});
 const groupLabel=await dragFiles(row('alpha.txt'),file.locator('.file-columns'));
 for(const name of ['folder-a (copy)','folder-b (copy)','alpha (copy).txt','bravo (copy).txt'])await row(name).waitFor();
 assert.equal(groupLabel,'2 folders, 2 files');assert.equal(await readFile(`${dir}/folder-a (copy)/inside.txt`,'utf8'),'nested');assert.equal(await readFile(`${dir}/alpha (copy).txt`,'utf8'),'alpha');check('real pointer Ctrl-drag duplicates the entire mixed selection in the same browser');
 // Move within this browser is a true no-op, with no API request or progress notice.
 await page.evaluate(()=>window.fileOperations=[]);const notices=await page.locator('.transfer').count();await row('charlie.txt').locator('.file-name').click();await dragFiles(row('charlie.txt'),row('destination'),'none');await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.fileOperations),[]);assert.equal(await page.locator('.transfer').filter({hasText:/^Move/}).count(),0);assert.equal(await readFile(`${dir}/charlie.txt`,'utf8'),'charlie');
 const copyResponse=page.waitForResponse(response=>response.url().endsWith('/api/files')&&response.request().postDataJSON()?.operation==='copy');
 await dragFiles(row('charlie.txt'),row('destination'),'before');assert.equal((await copyResponse).status(),200);assert.equal(await readFile(`${dir}/destination/charlie.txt`,'utf8'),'charlie');check('same-browser moves do nothing; Ctrl-drop onto a folder copies');
 await row('charlie.txt').locator('.file-name').click();await dragFiles(row('charlie.txt'),row('charlie.txt'),'during');await row('charlie (copy).txt').waitFor();check('drag away and back onto the source row also copies');
 for(const [modifier,timing] of [['Control','before'],['Meta','before'],['Meta','during'],['Alt','during']]) {
  const beforeNames=new Set(await readdir(dir));await row('bravo.txt').locator('.file-name').click();const response=page.waitForResponse(r=>r.url().endsWith('/api/files')&&r.request().postDataJSON()?.operation==='copy'&&r.request().postDataJSON()?.path===`${dir}/bravo.txt`);await dragFiles(row('bravo.txt'),file.locator('.file-columns'),timing,modifier);assert.equal((await response).status(),200);const created=(await readdir(dir)).filter(name=>!beforeNames.has(name));assert.equal(created.length,1);assert.equal(await readFile(`${dir}/${created[0]}`,'utf8'),'bravo');await row(created[0]).waitFor();assert.equal(await readFile(`${dir}/bravo.txt`,'utf8'),'bravo');
 }
 await page.evaluate(()=>window.fileOperations=[]);await row('bravo.txt').scrollIntoViewIfNeeded();const cancelRow=await row('bravo.txt').boundingBox();await page.mouse.move(cancelRow.x+50,cancelRow.y+12);await page.mouse.down();await page.mouse.move(cancelRow.x+100,cancelRow.y+25,{steps:5});await page.locator('.file-drag-group').waitFor();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.file-drag-group').count(),0);assert.deepEqual(await page.evaluate(()=>window.fileOperations),[]);check('Escape cancels file dragging without issuing any filesystem operation');
 assert.equal(await page.evaluate(()=>window.nativeDrags),0);assert.equal(await page.locator('.popover-menu').count(),0);check('Command and Option drags copy real files without native OS drag negotiation');
 const terminal=page.locator('[data-panel="terminal-3"]'),h=await terminal.locator('.panel-header').boundingBox(),grid=await page.locator('.grid-stack').boundingBox();
 await page.mouse.move(h.x+50,h.y+15);await page.mouse.down();await page.mouse.move(grid.x+grid.width*.8,grid.y+2,{steps:15});await page.locator('.dock-preview[data-edge=snap]:not(.invalid)').waitFor();await page.locator('.dock-preview').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{}))));const cover=await page.locator('.dock-preview').boundingBox();assert.ok(Math.abs(cover.width-grid.width/2)<2);await page.mouse.up();await page.waitForTimeout(250);assert.equal(await terminal.getAttribute('gs-w'),'2');assert.equal(await page.locator('.grid-stack-item').count(),5);assert.ok(await page.locator('.grid-stack').evaluate(grid=>{const bounds=grid.getBoundingClientRect(), rects=[...grid.querySelectorAll('.grid-stack-item')].map(node=>node.getBoundingClientRect());return rects.every((rect,i)=>rect.x>=bounds.x-1&&rect.y>=bounds.y-1&&rect.right<=bounds.right+1&&rect.bottom<=bounds.bottom+1&&!rects.some((other,j)=>j!==i&&rect.x<other.right-1&&rect.right>other.x+1&&rect.y<other.bottom-1&&rect.bottom>other.y+1))}));check('screen-edge quarter snap grows a small terminal and reflows neighbors');
 const neighbors=await page.locator('.grid-stack-item:not([data-panel="terminal-3"])').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.panel,rect:node.getBoundingClientRect().toJSON()})));
 await terminal.locator('.panel-header').dblclick();await page.waitForTimeout(220);assert.equal(Number(await terminal.getAttribute('gs-w')||1),1);assert.equal(Number(await terminal.getAttribute('gs-h')||1),1);assert.equal(await page.locator('.panel:visible').count(),5);
 await terminal.locator('.panel-header').dblclick();await page.waitForTimeout(220);assert.equal(await terminal.getAttribute('gs-w'),'2');assert.deepEqual(await page.locator('.grid-stack-item:not([data-panel="terminal-3"])').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.panel,rect:node.getBoundingClientRect().toJSON()}))),neighbors);
 await page.getByRole('button',{name:'Rearrange workspace',exact:true}).click();await page.waitForTimeout(300);assert.equal(await page.locator('.grid-stack-item').count(),5);assert.ok((await page.locator('[data-panel=files]').boundingBox()).width<=640);check('double-click uses free space or shrinks without touching neighbors; rearrange balances panels');
 await page.getByRole('button',{name:'Add file browser',exact:true}).click();const targetBrowser=page.locator('.file-view').last();await targetBrowser.locator('..').getByRole('textbox',{name:'File or directory path'}).fill(dir+'/destination');await targetBrowser.locator('..').getByRole('textbox',{name:'File or directory path'}).press('Enter');await targetBrowser.locator('.file-entry').filter({hasText:'charlie.txt'}).waitFor();
 assert.equal(await page.locator('.layout-cycle').getAttribute('data-mode'),'0','adding a panel starts a new custom layout');
 for(const [name,modifier,timing] of [['alpha.txt','Control','before'],['bravo.txt','Meta','during']]) {
  await row(name).locator('.file-name').click();await dragFiles(row(name).locator('.file-size'),targetBrowser.locator('..').locator('.panel-header'),timing,modifier);await targetBrowser.locator('.file-entry').filter({hasText:name}).waitFor();assert.equal(await readFile(`${dir}/destination/${name}`,'utf8'),await readFile(`${dir}/${name}`,'utf8'));
 }
 await row('script.js').locator('.file-name').click();await row('windows.txt').locator('.file-name').click({modifiers:['Control']});
 assert.equal(await dragFiles(row('script.js').locator('.file-size'),targetBrowser.locator('..').locator('.panel-header')),'2 files');
 for(const name of ['script.js','windows.txt']){await targetBrowser.locator('.file-entry').filter({hasText:name}).waitFor();assert.equal(await readFile(`${dir}/destination/${name}`,'utf8'),await readFile(`${dir}/${name}`,'utf8'));}
 await targetBrowser.locator('..').getByRole('button',{name:'Close panel',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.file-view').length===1);check('Control and Command copy across browsers, including header drops; source and destination bytes match');
 // Make room for a readable editor without creating new processes.
 await page.setViewportSize({width:2560,height:1080});await page.waitForTimeout(250);
 await row('script.js').locator('.file-name').dblclick();await file.locator('.cm-content').waitFor();await file.locator('.code-keyword').first().waitFor();assert.equal(await file.getByRole('combobox',{name:'Syntax'}).inputValue(),'javascript');
 assert.equal(await file.getByRole('button',{name:'Page up',exact:true}).count(),0);assert.equal(await file.getByRole('button',{name:'Page down',exact:true}).count(),0);assert.equal(await file.locator('.inspector-page').isVisible(),false);
 assert.equal(await file.locator('.inspector-title').count(),0);assert.equal(await file.locator('..').locator('.path-input').inputValue(),dir+'/script.js');
 await file.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText('const edited = 42;\n');await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('[aria-label=\"Save file\"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');assert.equal(await readFile(`${dir}/script.js`,'utf8'),'const edited = 42;\n');
 for(const mode of ['python','go','shell','toml','yaml','sql','markdown','html','xml','css','json','typescript','jsx','tsx','text']) await file.getByRole('combobox',{name:'Syntax'}).selectOption(mode);await file.getByRole('button',{name:'Back to files',exact:true}).click();check('bundled syntax editor auto-detects, switches syntax and saves real user files');
 await row('syntax.md').locator('.file-name').dblclick();await file.locator('.code-heading').first().waitFor();assert.equal(await file.getByRole('combobox',{name:'Syntax'}).inputValue(),'markdown');
 const syntax=file.getByRole('combobox',{name:'Syntax'}),content=file.locator('.cm-content');
 for(const theme of ['dark','light']){
  if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();
  for(const [kind,text] of [['heading','Heading'],['heading','Subheading'],['markup','List item'],['markup','Ordered item'],['monospace','inline code'],['monospace','const fenced = 1;'],['link','Link'],['quote','Quote'],['strong','Bold'],['emphasis','italic'],['strikethrough','removed']]){
   const token=content.locator('.code-'+kind).filter({hasText:text}).first();await token.waitFor();
   if(['heading','markup','monospace','link','quote'].includes(kind))assert.ok(await token.evaluate(node=>getComputedStyle(node).color!==getComputedStyle(node.closest('.cm-content')).color),`${kind} needs visible color in ${theme}`);
  }
 }
 await syntax.selectOption('text');await page.waitForFunction(()=>!document.querySelector('.cm-content [class*="code-"]'));
 await syntax.selectOption('markdown');await content.locator('.code-heading').first().waitFor();
 assert.ok(await file.getByRole('button',{name:'Save file',exact:true}).isDisabled());assert.equal(await readFile(`${dir}/syntax.md`,'utf8'),markdown);
 await file.getByRole('button',{name:'Back to files',exact:true}).click();await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();
 check('Markdown headings, lists, inline/fenced code, links and emphasis are styled in both themes and after syntax switching');
 await row('syntax.xml').locator('.file-name').dblclick();await content.locator('.code-type').first().waitFor();assert.equal(await syntax.inputValue(),'xml');
 for(const theme of ['dark','light']){
  if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();
  for(const [kind,text] of [['type','app:item'],['comment','configuration'],['string','true']]){
   const token=content.locator('.code-'+kind).filter({hasText:text}).first();await token.waitFor();
   assert.ok(await token.evaluate(node=>getComputedStyle(node).color!==getComputedStyle(node.closest('.cm-content')).color),`XML ${kind} needs visible color in ${theme}`);
  }
 }
 await syntax.selectOption('text');await page.waitForFunction(()=>!document.querySelector('.cm-content [class*="code-"]'));
 await syntax.selectOption('xml');await content.locator('.code-type').first().waitFor();
 assert.ok(await file.getByRole('button',{name:'Save file',exact:true}).isDisabled());assert.equal(await readFile(`${dir}/syntax.xml`,'utf8'),xml);
 await file.getByRole('button',{name:'Back to files',exact:true}).click();await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();
 check('XML auto-detection, namespace tags, comments, attribute values and manual syntax selection in both themes preserve file contents');
 await row('script.js').locator('.file-name').dblclick();await file.locator('.cm-content').waitFor();await page.keyboard.press('Control+a');await page.keyboard.insertText('unsaved');await file.getByRole('button',{name:'Back to files',exact:true}).click();await page.locator('dialog').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await file.locator('.file-inspector').count(),1);await file.getByRole('button',{name:'Back to files',exact:true}).click();await page.keyboard.press('Enter');await file.locator('.file-inspector').waitFor({state:'detached'});assert.equal(await readFile(`${dir}/script.js`,'utf8'),'const edited = 42;\n');check('unsaved changes require explicit discard');
 await row('binary.dat').locator('.file-name').dblclick();await file.getByText('binary or non-UTF-8 file; download it to view',{exact:true}).waitFor();assert.equal(await file.locator('.cm-editor').count(),0);await file.getByRole('button',{name:'Back to files',exact:true}).click();
 await row('wrapped.txt').locator('.file-name').dblclick();await file.locator('.cm-content').waitFor();assert.equal(await file.locator('br.editor-soft-break').count(),2);
 await page.keyboard.press('Control+End');await page.keyboard.insertText('tail');await file.getByRole('button',{name:'Undo',exact:true}).click();assert.ok(await file.getByRole('button',{name:'Save file',exact:true}).isDisabled());await file.getByRole('button',{name:'Redo',exact:true}).click();
 await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('[aria-label=\"Save file\"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');assert.equal(await readFile(`${dir}/wrapped.txt`,'utf8'),'w'.repeat(2001)+'\r\nlast\ntail');await file.getByRole('button',{name:'Back to files',exact:true}).click();
 await row('paged.txt').locator('.file-name').dblclick();await file.locator('.cm-content').waitFor();
 await file.locator('.inspector-page').getByText('Page 1',{exact:true}).waitFor();
 assert.equal(await file.getByRole('button',{name:'Previous file',exact:true}).count(),0);assert.equal(await file.getByRole('button',{name:'Next file',exact:true}).count(),0);assert.ok(await file.getByRole('button',{name:'Page up',exact:true}).isDisabled());
 const readPage=page.waitForResponse(response=>response.url().endsWith('/api/files')&&response.request().postDataJSON()?.operation==='read');
 await file.getByRole('button',{name:'Page down',exact:true}).click();const middle=await(await readPage).json();await file.locator('.inspector-page').getByText('Page 2',{exact:true}).waitFor();
 await file.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.insertText('inserted-');
 await file.getByRole('button',{name:'Page down',exact:true}).click();await page.locator('dialog').getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await file.locator('.inspector-page').textContent(),'Page 2');assert.equal(await readFile(`${dir}/paged.txt`,'utf8'),pagedText);
 await file.getByRole('button',{name:'Page down',exact:true}).click();await page.locator('dialog').getByRole('button',{name:'Save and continue',exact:true}).click();await file.locator('.inspector-page').getByText('Page 3',{exact:true}).waitFor();
 assert.equal(await readFile(`${dir}/paged.txt`,'utf8'),pagedText.slice(0,middle.page.offset)+'inserted-'+pagedText.slice(middle.page.offset));assert.ok(await file.getByRole('button',{name:'Page down',exact:true}).isDisabled());
 await file.getByRole('button',{name:'Page up',exact:true}).click();await file.locator('.inspector-page').getByText('Page 2',{exact:true}).waitFor();assert.ok((await file.locator('.cm-content').textContent()).startsWith('inserted-'));
 await file.getByRole('button',{name:'Back to files',exact:true}).click();check('binary rejection, visual wrapping, undo/redo and paged saves preserve every untouched byte');
 await row('windows.txt').locator('.file-name').dblclick();await file.locator('.cm-content').waitFor();await page.keyboard.press('Control+End');await page.keyboard.insertText('third');await page.keyboard.press('Enter');await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('[aria-label=\"Save file\"]')?.disabled && document.querySelector('.inspector-body')?.getAttribute('aria-busy') === 'false');assert.equal(await readFile(`${dir}/windows.txt`,'utf8'),'original\r\nsecond\r\nthird\r\n');
 await writeFile(`${dir}/windows.txt`,'changed elsewhere\r\n');await page.keyboard.insertText('stale');const staleResponse=page.waitForResponse(response=>response.url().endsWith('/api/files')&&response.request().postDataJSON()?.operation==='write');await page.keyboard.press('Control+s');assert.equal((await staleResponse).status(),400);assert.equal(await readFile(`${dir}/windows.txt`,'utf8'),'changed elsewhere\r\n');await file.getByRole('button',{name:'Back to files',exact:true}).click();await page.keyboard.press('Enter');await file.locator('.file-inspector').waitFor({state:'detached'});check('editor preserves CRLF and rejects stale saves without losing external changes');
 // Save notifications overlap this small panel and would intercept the viewer's wheel input.
 await page.waitForFunction(()=>!document.querySelector('.component-notifications .toast'));
 await row('photo-a.png').locator('.file-name').dblclick();await page.waitForFunction(()=>document.querySelector('.file-image')?.naturalWidth===1);
 const toolbar=file.locator('.inspector-toolbar');
 assert.equal(await file.locator('.inspector-position').textContent(),'2/5');
 assert.deepEqual(await toolbar.locator('button').evaluateAll(nodes=>nodes.map(node=>node.title)),['Back to files','Previous file','Next file','Zoom out','Actual size (100%)','Zoom in','Fit image','Copy image to clipboard','Download file','File tools']);
 assert.equal(await toolbar.getByRole('button',{name:'Back to files',exact:true}).locator('svg path').count(),2);
 assert.equal(await toolbar.getByRole('button',{name:'Previous file',exact:true}).locator('svg path').getAttribute('d'),'m15 18-6-6 6-6');
 assert.equal(await toolbar.getByRole('button',{name:'Next file',exact:true}).locator('svg path').getAttribute('d'),'m9 18 6-6-6-6');
 assert.ok(await toolbar.locator('.image-controls,.inspector-actions').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).borderLeftWidth==='1px')));
 await file.getByRole('button',{name:'Next file',exact:true}).click();assert.equal(await openedName(),'photo-b.png');
 assert.equal(await file.locator('.inspector-position').textContent(),'3/5');
 await file.locator('.file-inspector').focus();await page.keyboard.press('ArrowRight');assert.equal(await openedName(),'photo-z.png');
 for(const [name,position] of [['sound.wav','5/5'],['document.pdf','1/5'],['photo-a.png','2/5']]){
  await file.getByRole('button',{name:'Next file',exact:true}).click();assert.equal(await openedName(),name);assert.equal(await file.locator('.inspector-position').textContent(),position);
 }
 for(const [name,position] of [['document.pdf','1/5'],['sound.wav','5/5'],['photo-z.png','4/5']]){
  await file.locator('.file-inspector').focus();await page.keyboard.press('ArrowLeft');assert.equal(await openedName(),name);assert.equal(await file.locator('.inspector-position').textContent(),position);
 }
 await file.locator('.image-viewport[data-ready]').waitFor();
 const imageViewport=file.locator('.image-viewport'),image=file.locator('.file-image');
 assert.equal(await file.locator('.inspector-position').textContent(),'4/5');
 assert.ok(await image.evaluate(node=>node.width<=node.parentElement.parentElement.clientWidth+1&&node.height<=node.parentElement.parentElement.clientHeight+1));
 await file.getByRole('button',{name:'Actual size (100%)',exact:true}).click();assert.equal(await file.locator('.image-scale').textContent(),'100%');
 await file.getByRole('button',{name:'Zoom in',exact:true}).click();await file.getByRole('button',{name:'Zoom in',exact:true}).click();
 assert.ok(await imageViewport.evaluate(node=>node.scrollWidth>node.clientWidth&&node.scrollHeight>node.clientHeight));
 await imageViewport.evaluate(node=>{node.scrollLeft=0;node.scrollTop=0;});
 const imageBox=await imageViewport.boundingBox(),center={x:imageBox.x+imageBox.width/2,y:imageBox.y+imageBox.height/2};
 await page.mouse.move(center.x,center.y);await page.mouse.wheel(120,80);
 await page.waitForFunction(()=>{const node=document.querySelector('.image-viewport');return node.scrollLeft>0&&node.scrollTop>0;});
 const beforePan=await imageViewport.evaluate(node=>({x:node.scrollLeft,y:node.scrollTop}));
 await page.mouse.down();await page.mouse.move(center.x-50,center.y-40,{steps:5});await page.mouse.up();
 const afterPan=await imageViewport.evaluate(node=>({x:node.scrollLeft,y:node.scrollTop,dragging:node.classList.contains('dragging')}));
 assert.ok(afterPan.x>beforePan.x+45&&afterPan.y>beforePan.y+35);assert.equal(afterPan.dragging,false);
 const anchor={x:center.x-50,y:center.y-40};
 const beforeZoom=await image.evaluate((node,point)=>{const rect=node.getBoundingClientRect();return {width:rect.width,x:(point.x-rect.left)/rect.width,y:(point.y-rect.top)/rect.height};},anchor);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-20);await page.keyboard.up('Control');
 await page.waitForFunction(width=>document.querySelector('.file-image').getBoundingClientRect().width>width,beforeZoom.width);
 const afterZoom=await image.evaluate((node,point)=>{const rect=node.getBoundingClientRect();return {x:(point.x-rect.left)/rect.width,y:(point.y-rect.top)/rect.height};},anchor);
 assert.ok(Math.abs(beforeZoom.x-afterZoom.x)<0.002&&Math.abs(beforeZoom.y-afterZoom.y)<0.002,'pinch zoom preserves the image point beneath the cursor');
 const gestureWidth=await image.evaluate(node=>node.getBoundingClientRect().width);
 await imageViewport.evaluate((node,point)=>{
  for(const [type,scale] of [['gesturestart',1],['gesturechange',1.2],['gestureend',1.2]]){
   const event=new Event(type,{cancelable:true});Object.assign(event,{scale,clientX:point.x,clientY:point.y});node.dispatchEvent(event);
  }
 },anchor);
 assert.ok(Math.abs((await image.evaluate(node=>node.getBoundingClientRect().width))/gestureWidth-1.2)<0.01);
 await file.getByRole('button',{name:'Fit image',exact:true}).click();
 assert.ok(await imageViewport.evaluate(node=>node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+1));
 const fittedWidth=await image.evaluate(node=>node.getBoundingClientRect().width);
 await imageViewport.dblclick({position:{x:imageBox.width/2,y:imageBox.height/2}});
 assert.ok((await image.evaluate(node=>node.getBoundingClientRect().width))>fittedWidth);
 await imageViewport.dblclick({position:{x:imageBox.width/2,y:imageBox.height/2}});
 assert.ok(Math.abs((await image.evaluate(node=>node.getBoundingClientRect().width))-fittedWidth)<1);
 await page.screenshot({path:'test-results/features-image-toolbar.png'});
 await file.getByRole('button',{name:'Copy image to clipboard',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Copy image to clipboard"]').disabled);await file.getByText('Image copied',{exact:true}).last().waitFor();
 const copied=await page.evaluate(async()=>{
  const item=(await navigator.clipboard.read())[0],blob=await item.getType('image/png'),bitmap=await createImageBitmap(blob),source=document.querySelector('.file-image');
  const hash=async image=>{const canvas=document.createElement('canvas');canvas.width=image.naturalWidth||image.width;canvas.height=image.naturalHeight||image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))).join(',');};
  const result={width:bitmap.width,height:bitmap.height,sourceWidth:source.naturalWidth,sourceHeight:source.naturalHeight,actual:await hash(bitmap),expected:await hash(source)};bitmap.close();return result;
 });
 assert.equal(copied.width,copied.sourceWidth);assert.equal(copied.height,copied.sourceHeight);assert.equal(copied.actual,copied.expected);
 const downloadImage=page.waitForEvent('download');await toolbar.getByRole('button',{name:'Download file',exact:true}).click();const downloadedImage=await downloadImage;
 assert.equal(downloadedImage.suggestedFilename(),'photo-z.png');assert.deepEqual(await readFile(await downloadedImage.path()),await readFile(`${dir}/photo-z.png`));
 const desktop=page.viewportSize();
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(300);
  assert.ok(await toolbar.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  assert.ok(await toolbar.getByRole('button',{name:'Back to files',exact:true}).isVisible());if(await toolbar.getByRole('button',{name:'File tools',exact:true}).isVisible()){await toolbar.getByRole('button',{name:'File tools',exact:true}).click();assert.ok(await page.getByRole('dialog',{name:'File tools',exact:true}).getByRole('button',{name:'Download file',exact:true}).isVisible());await page.keyboard.press('Escape');}
  await page.screenshot({path:`test-results/features-image-toolbar-${width}.png`});
  if(width===320){await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();await page.waitForTimeout(200);await page.screenshot({path:'test-results/features-image-toolbar-light.png'});await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click();}
 }
 await page.setViewportSize(desktop);await page.waitForTimeout(300);
 await file.getByRole('button',{name:'Previous file',exact:true}).click();assert.equal(await openedName(),'photo-b.png');
 assert.equal(await file.locator('.image-controls').count(),1);await file.getByRole('button',{name:'Back to files',exact:true}).click();await file.locator('.file-inspector').waitFor({state:'detached'});assert.equal(await file.locator('.image-controls').count(),0);
 for(const name of ['photo-a.png','document.pdf','sound.wav']){
  await filterButton.click();await filter.fill(name);await row(name).locator('.file-name').dblclick();
  assert.equal(await file.locator('.inspector-position').textContent(),'1/1');
  assert.ok(await file.getByRole('button',{name:'Next file',exact:true}).isDisabled());assert.ok(await file.getByRole('button',{name:'Previous file',exact:true}).isDisabled());
  await file.locator('.file-inspector').focus();await page.keyboard.press('ArrowRight');assert.equal(await openedName(),name);
  await file.getByRole('button',{name:'Back to files',exact:true}).click();await filterButton.click();
 }
 check('mixed image/PDF/audio circular navigation and counts, filtered singleton controls, native diagonal scrolling, drag, anchored pinch zoom, fit and viewer cleanup');
 await row('document.pdf').locator('.file-name').dblclick();await file.locator('iframe.file-pdf').waitFor();assert.equal(await toolbar.locator('.image-controls').count(),0);assert.equal(await toolbar.getByRole('button',{name:'Copy image to clipboard',exact:true}).count(),0);await page.waitForTimeout(500);await page.screenshot({path:'test-results/features-pdf.png'});const pdfResponse=await api('/preview/document.pdf?path='+encodeURIComponent(dir+'/document.pdf'));assert.equal(pdfResponse.headers()['content-type'],'application/pdf');assert.ok(pdfResponse.headers()['content-disposition'].includes('filename=document.pdf'));assert.ok((await pdfResponse.body()).subarray(0,8).toString().startsWith('%PDF-'));await file.getByRole('button',{name:'Back to files',exact:true}).click();
 await row('sound.wav').locator('.file-name').dblclick();await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);assert.equal(await toolbar.locator('.image-controls').count(),0);assert.equal(await toolbar.getByRole('button',{name:'Copy image to clipboard',exact:true}).count(),0);const ranged=await api('/preview/sound.wav?path='+encodeURIComponent(dir+'/sound.wav'),'GET',undefined,{Range:'bytes=0-9'});assert.equal(ranged.status(),206);assert.equal((await ranged.body()).length,10);await file.getByRole('button',{name:'Back to files',exact:true}).click();check('images navigate with arrows; PDF and HTML audio previews stream with byte ranges');
 const mediaFixtures=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=48;const ctx=canvas.getContext('2d');ctx.fillStyle='#c82850';ctx.fillRect(0,0,64,48);
  const webp=canvas.toDataURL('image/webp').split(',')[1],stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
  recorder.ondataavailable=event=>chunks.push(event.data);
  const finished=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
  for(let frame=0;frame<4;frame++){ctx.fillStyle=frame%2?'#c82850':'#303030';ctx.fillRect(0,0,64,48);await new Promise(resolve=>setTimeout(resolve,100));}
  recorder.stop();await finished;stream.getTracks().forEach(track=>track.stop());
  return {webp,video:Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))};
 });
 await writeFile(`${dir}/converted.webp`,Buffer.from(mediaFixtures.webp,'base64'));await writeFile(`${dir}/clip.webm`,Buffer.from(mediaFixtures.video));
 assert.equal(spawnSync('chown',[`${fields[2]}:${fields[3]}`,`${dir}/converted.webp`,`${dir}/clip.webm`]).status,0);await refresh();
 await row('converted.webp').locator('.file-name').dblclick();await file.locator('.image-viewport[data-ready]').waitFor();
 await file.getByRole('button',{name:'Copy image to clipboard',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Copy image to clipboard"]').disabled);await file.getByText('Image copied',{exact:true}).last().waitFor();
 const webpCopy=await page.evaluate(async()=>{const bitmap=await createImageBitmap(await(await navigator.clipboard.read())[0].getType('image/png'));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const result={width:bitmap.width,height:bitmap.height,pixel:Array.from(ctx.getImageData(0,0,1,1).data)};bitmap.close();return result;});
 assert.equal(webpCopy.width,64);assert.equal(webpCopy.height,48);assert.ok(webpCopy.pixel[0]>190&&webpCopy.pixel[1]<50&&webpCopy.pixel[2]>70);
 await toolbar.getByRole('button',{name:'Back to files',exact:true}).click();
 await page.evaluate(()=>{window.savedClipboardItem=window.ClipboardItem;window.ClipboardItem=undefined;});
 await row('converted.webp').locator('.file-name').dblclick();assert.equal(await toolbar.getByRole('button',{name:'Copy image to clipboard',exact:true}).count(),0);assert.ok(await toolbar.getByRole('button',{name:'Download file',exact:true}).isVisible());
 await toolbar.getByRole('button',{name:'Back to files',exact:true}).click();await page.evaluate(()=>{window.ClipboardItem=window.savedClipboardItem;delete window.savedClipboardItem;});
 await row('clip.webm').locator('.file-name').dblclick();await page.waitForFunction(()=>document.querySelector('video')?.readyState>=1);
 assert.equal(await toolbar.locator('.image-controls').count(),0);assert.equal(await toolbar.getByRole('button',{name:'Copy image to clipboard',exact:true}).count(),0);assert.ok(await toolbar.getByRole('button',{name:'Download file',exact:true}).isVisible());
 const video=await file.locator('video').elementHandle();await video.evaluate(node=>{node.muted=true;node.loop=true;return node.play();});
 await toolbar.getByRole('button',{name:'Next file',exact:true}).click();await file.locator('.image-viewport[data-ready]').waitFor();
 assert.ok(await video.evaluate(node=>node.paused&&!node.hasAttribute('src')),'navigation stops and releases the preceding video');
 await toolbar.getByRole('button',{name:'Back to files',exact:true}).click();
 await file.locator('.file-inspector').waitFor({state:'detached'});
 const mediaOrder=['clip.webm','converted.webp','document.pdf','photo-a.png','photo-b.png','photo-z.png','sound.wav'];
 for(const start of ['photo-a.png','document.pdf','clip.webm','sound.wav']){
  await row(start).locator('.file-name').dblclick();let index=mediaOrder.indexOf(start);
  for(const direction of [1,-1])for(let step=0;step<=mediaOrder.length;step++){
   const name=mediaOrder[index],isImage=name.endsWith('.png')||name.endsWith('.webp');
   assert.equal(await openedName(),name);
   assert.equal(await file.locator('.inspector-position').textContent(),`${index+1}/${mediaOrder.length}`);
   assert.equal(await toolbar.locator('.image-controls').count(),isImage?1:0);
   assert.equal(await file.locator('.cm-editor').count(),0,'media navigation must never enter a text file');
   if(step%2) {await file.locator('.file-inspector').focus();await page.keyboard.press(direction>0?'ArrowRight':'ArrowLeft');}
   else await toolbar.getByRole('button',{name:direction>0?'Next file':'Previous file',exact:true}).click();
   index=(index+direction+mediaOrder.length)%mediaOrder.length;
  }
  await toolbar.getByRole('button',{name:'Back to files',exact:true}).click();
 }
 check('opening an image, PDF, video or audio starts the same seven-media loop in both directions with stable counts, wraparound and no text files');
 check('media back/chevrons/count and separators, narrow toolbar bounds, original-resolution PNG/WebP clipboard pixels, unsupported clipboard hiding, exact download bytes and video navigation cleanup');
 await row('alpha.txt').locator('.file-name').click({button:'right'});await page.getByRole('menuitem',{name:'Compress…',exact:true}).click();await page.getByRole('combobox',{name:'Archive format'}).selectOption('7z');await page.getByRole('textbox',{name:'Archive name'}).fill('protected.7z');await page.locator('[aria-label="Archive password"]').fill('test-password');await page.getByRole('button',{name:'Compress',exact:true}).click();await row('protected.7z').waitFor();
 await row('protected.7z').locator('.file-name').dblclick();await page.getByRole('textbox',{name:'Extract folder'}).fill('decrypted');await page.locator('[aria-label="Archive password"]').fill('test-password');await page.getByRole('button',{name:'Extract',exact:true}).click();await row('decrypted').waitFor();assert.equal(await readFile(`${dir}/decrypted/alpha.txt`,'utf8'),'alpha');check('browser compression and password-protected extraction round-trip');
 await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(250);
 const sessions=await(await api('/terminals')).json(),openIDs=(await(await api('/me')).json()).settings.workspaces.flatMap(ws=>ws.panels.map(panel=>panel.terminal));
 await page.getByRole('button',{name:'User menu',exact:true}).click();await page.getByRole('menuitem',{name:'Retained terminals',exact:true}).click();for(const session of sessions.filter(s=>openIDs.includes(s.id)))assert.ok(!(await page.locator('dialog').textContent()).includes(session.id));assert.equal(await page.locator('dialog code').count(),0);assert.equal(await page.locator('dialog .retained-row').count(),sessions.filter(s=>!openIDs.includes(s.id)).length);await page.getByRole('button',{name:'Close dialog',exact:true}).click();check('retained list contains only sessions outside all workspaces and omits IDs');
 await page.screenshot({path:'test-results/features-desktop.png'});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);assert.ok(await page.locator('.topbar').evaluate(node=>node.scrollWidth<=innerWidth));if(!await page.locator('[data-component-name=files]').isVisible())await page.getByRole('button',{name:'More components',exact:true}).click();await page.locator('[data-component-name=files]').click();
 await filterButton.tap();assert.ok(await filter.evaluate(node=>node===document.activeElement));await filter.fill('bravo.txt');assert.deepEqual(await names(),['bravo.txt']);assert.ok(await file.locator('.file-footer').evaluate(node=>node.scrollWidth<=node.clientWidth));await page.screenshot({path:'test-results/features-mobile.png'});await filterButton.tap();await row('alpha.txt').waitFor();check('mobile filter button accepts touch and focuses an editable field without overflowing the footer');
 await navigate(controls+'/created-folder');await file.getByRole('button',{name:'Properties',exact:true}).tap();await properties.waitFor();assert.equal(await property('Path'),controls+'/created-folder');await properties.getByRole('button',{name:'Close dialog',exact:true}).click();check('mobile footer opens current-folder properties with no selection');
 await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(250);
 const closingSessions=await(await api('/terminals')).json(),closingIDs=await page.locator('.terminal-view').evaluateAll(nodes=>nodes.map(node=>node.dataset.terminal));
 await page.getByRole('button',{name:'New workspace',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);await page.locator('.workspace-tab-item.active .workspace-menu').click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.locator('dialog input').fill('Keep alive');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.terminal-view')?.dataset.state==='connected');await page.waitForFunction(()=>document.querySelectorAll('.board').length===1);const keepID=await page.locator('.terminal-view').getAttribute('data-terminal');
 await page.getByRole('button',{name:'Features',exact:true}).click({button:'right'});
 assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['Activate','Rename','Close']);
 assert.equal(await page.locator('.workspace-tab-item.active .workspace-tab').textContent(),'Keep alive');
 await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.locator('dialog input').fill('Renamed features');await page.getByRole('button',{name:'Continue',exact:true}).click();
 assert.equal(await page.locator('.workspace-tab-item.active .workspace-tab').textContent(),'Keep alive');
 await page.getByRole('button',{name:'Renamed features',exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'Activate',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.board').length===1&&document.querySelector('.workspace-tab-item.active .workspace-tab')?.textContent==='Renamed features');
 await page.getByRole('button',{name:'Renamed features',exact:true}).press('Shift+F10');
 assert.ok(await page.getByRole('menuitem',{name:'Activate',exact:true}).isDisabled());
 await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.locator('dialog input').fill('Features');await page.getByRole('button',{name:'Continue',exact:true}).click();
 await page.getByRole('button',{name:'Keep alive',exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'Activate',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.board').length===1&&document.querySelector('.workspace-tab-item.active .workspace-tab')?.textContent==='Keep alive');
 await page.getByRole('button',{name:'Features',exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'Close',exact:true}).click();await page.keyboard.press('Escape');
 assert.ok(await page.getByRole('button',{name:'Features',exact:true}).isVisible());
 await page.getByRole('button',{name:'Features',exact:true}).click({button:'right'});await page.getByRole('menuitem',{name:'Close',exact:true}).click();await page.keyboard.press('Enter');
 check('workspace context menus activate, rename and confirm closure with pointer and keyboard access');
 await page.waitForFunction(ids=>fetch('/api/terminals').then(r=>r.json()).then(sessions=>ids.every(id=>!sessions.some(s=>s.id===id))),closingIDs);for(const session of closingSessions.filter(s=>closingIDs.includes(s.id)))await processStopped(session.pid);assert.equal((await api('/terminals/'+keepID)).status(),200);check('closing an inactive workspace kills every terminal process and keeps other workspaces alive');
 let releaseCreate;const gate=new Promise(resolve=>releaseCreate=resolve);await page.route('**/api/terminals',async route=>{if(route.request().method()==='POST')await gate;await route.continue()});const creatingResponse=page.waitForResponse(r=>r.url().endsWith('/api/terminals')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'New workspace',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);await page.locator('.workspace-tab-item.active .workspace-menu').click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();await page.locator('dialog input').fill('Starting');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.workspace-tab.active')?.textContent==='Starting');await page.locator('.workspace-tab-item.active .workspace-menu').click();await page.getByRole('menuitem',{name:'Close',exact:true}).click();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.workspace-tab.active')?.textContent==='Keep alive');releaseCreate();const justCreated=await(await creatingResponse).json();await page.unroute('**/api/terminals');await page.waitForFunction(id=>fetch('/api/terminals/'+id).then(r=>r.status===404),justCreated.id);await processStopped(justCreated.pid);check('closing a workspace during terminal creation removes it immediately and kills the eventual process');
 await page.waitForFunction(()=>document.querySelectorAll('.board').length===1);await page.route('**/api/terminals/'+keepID,async route=>{if(route.request().method()==='DELETE')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Expected termination failure'})});else await route.continue()});await page.locator('.panel:has(> .terminal-view)').getByRole('button',{name:'Close panel',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.terminal-view'));await page.unroute('**/api/terminals/'+keepID);await api('/terminals/'+keepID,'DELETE');check('a failed background kill does not block closing the panel');
 // Exercise the layout cycle through the real settings API, including reload and manual edits.
 await page.waitForTimeout(400);await page.goto('about:blank');await page.setViewportSize({width:2560,height:1080});
 const layoutSettings=await(await api('/me')).json();
 layoutSettings.settings.current='layouts';layoutSettings.settings.workspaces=[{id:'layouts',name:'Layouts',columns:4,rows:2,active:'auto-0',panels:Array.from({length:6},(_,i)=>({id:`auto-${i}`,kind:i%2?'terminal':'files',path:dir,x:i%4,y:Math.floor(i/4),w:1,h:1}))}];
 assert.equal((await api('/settings','PUT',layoutSettings.settings)).status(),200);await page.goto(base);await page.waitForFunction(()=>document.querySelectorAll('.terminal-view[data-state=connected]').length===3);await page.waitForTimeout(400);
 const arrangeButton=page.getByRole('button',{name:'Rearrange workspace',exact:true});
 const layoutLabel=arrangeButton.locator('.layout-label');
 assert.equal(await arrangeButton.getAttribute('title'),'Auto layout');assert.equal(await layoutLabel.evaluate(node=>node.getBoundingClientRect().width),0);
 const geometry=()=>page.locator('.grid-stack-item').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.panel,x:Number(node.getAttribute('gs-x')||0),y:Number(node.getAttribute('gs-y')||0),w:Number(node.getAttribute('gs-w')||1),h:Number(node.getAttribute('gs-h')||1)})));
 async function cycle(mode){
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/settings')&&r.request().method()==='PUT'&&(r.request().postDataJSON().workspaces.find(ws=>ws.id==='layouts')?.layout?.mode||0)===mode);
  await arrangeButton.click();assert.equal((await saved).status(),200);await page.waitForTimeout(200);assert.equal(await arrangeButton.getAttribute('data-mode'),String(mode));
  assert.equal(await layoutLabel.textContent(),['Custom','Balanced','Terminals','Files'][mode]);assert.ok(await layoutLabel.evaluate(node=>node.getBoundingClientRect().width>0));
  if(mode)assert.ok(await page.locator('.grid-stack-item:has(.file-view)').evaluateAll(nodes=>nodes.every(node=>Number(node.getAttribute('gs-w')||1)<=2)),'automatic file browsers must be at most two cells wide');
  return geometry();
 }
 const customGeometry=await geometry(),layoutModes=[];
 await page.evaluate(()=>{window.originalPanel=document.querySelector('[data-panel=auto-1]');window.originalTerminal=window.originalPanel.querySelector('.terminal-view')});
 for(const mode of [1,2,3]){
  layoutModes.push(await cycle(mode));
  assert.ok(await page.evaluate(()=>window.originalPanel===document.querySelector('[data-panel=auto-1]')&&window.originalTerminal===window.originalPanel.querySelector('.terminal-view')),'layout must preserve mounted terminals');
  if(mode===1){assert.equal(layoutModes[0].filter(p=>Number(p.id.split('-')[1])%2).reduce((sum,p)=>sum+p.w*p.h,0),4);await page.screenshot({path:'test-results/layout-balanced-ultrawide.png'});}
  if(mode===2){await page.reload();await page.waitForFunction(()=>document.querySelector('.layout-cycle')?.dataset.mode==='2');await page.waitForFunction(()=>document.querySelectorAll('.terminal-view[data-state=connected]').length===3);await page.evaluate(()=>{window.originalPanel=document.querySelector('[data-panel=auto-1]');window.originalTerminal=window.originalPanel.querySelector('.terminal-view')});}
 }
 const fileArea=panels=>panels.filter(p=>Number(p.id.split('-')[1])%2===0).reduce((sum,p)=>sum+p.w*p.h,0);
 assert.ok(fileArea(layoutModes[1])<fileArea(layoutModes[0]));assert.ok(fileArea(layoutModes[2])>fileArea(layoutModes[0]));
 assert.deepEqual(await cycle(0),customGeometry);assert.equal(await arrangeButton.locator('svg').evaluate(node=>node.style.transform),'rotate(360deg)');
 check('ultrawide type grouping, three distinct priorities, clockwise icon and exact custom restore survive reload without replacing terminals');
 await page.mouse.move(20,200);await page.waitForTimeout(600);assert.ok(await arrangeButton.evaluate(node=>node.classList.contains('expanded')));
 await arrangeButton.hover();await page.waitForTimeout(2100);assert.ok(await arrangeButton.evaluate(node=>node.classList.contains('expanded')),'hover cancels pending collapse');
 await page.mouse.move(20,200);await page.waitForTimeout(1500);assert.ok(await arrangeButton.evaluate(node=>node.classList.contains('expanded')),'keep the label for two seconds after leaving');
 await page.waitForFunction(()=>document.querySelector('.layout-label')?.getBoundingClientRect().width===0);
 assert.ok(await layoutLabel.evaluate(node=>getComputedStyle(node).transitionDuration.split(',').some(value=>parseFloat(value)>0)));
 await arrangeButton.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.layout-cycle')?.dataset.mode==='1');
 assert.equal(await layoutLabel.textContent(),'Balanced');await page.waitForFunction(()=>document.querySelector('.layout-label')?.getBoundingClientRect().width>0);await page.waitForFunction(()=>document.querySelector('.layout-label')?.getBoundingClientRect().width===0);
 await cycle(2);await cycle(3);await cycle(0);check('layout click reveals current mode with animation; hover delays/cancels collapse and keyboard activation also times out');
 await cycle(1);
 let sourceBox=await page.locator('[data-panel=auto-0] .panel-header').boundingBox();
 await page.mouse.move(sourceBox.x+40,sourceBox.y+15);await page.mouse.down();await page.mouse.move(sourceBox.x+70,sourceBox.y+65,{steps:6});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await arrangeButton.getAttribute('data-mode'),'1','cancelled drag preserves the layout cycle');
 await page.waitForTimeout(220);
 const unchangedGeometry=await geometry(),ownBox=await page.locator('[data-panel=auto-0]').boundingBox();
 await page.mouse.move(sourceBox.x+40,sourceBox.y+15);await page.mouse.down();await page.mouse.move(ownBox.x+ownBox.width/2,ownBox.y+ownBox.height/2,{steps:12});
 await page.locator('.dock-preview[data-edge=empty]:not(.invalid)').waitFor();await page.mouse.up();await page.waitForTimeout(220);
 assert.deepEqual(await geometry(),unchangedGeometry,'dropping in the same cells keeps geometry');
 assert.equal(await arrangeButton.getAttribute('data-mode'),'1','same-cell drop preserves automatic mode');
 assert.equal(await layoutLabel.textContent(),'Balanced');assert.equal(await arrangeButton.locator('svg').evaluate(node=>node.style.transform),'rotate(90deg)');
 const resizeGrip=await page.locator('[data-panel=auto-0] .panel-resize-se').boundingBox();
 await page.mouse.move(resizeGrip.x+resizeGrip.width/2,resizeGrip.y+resizeGrip.height/2);await page.mouse.down();await page.mouse.move(resizeGrip.x+resizeGrip.width/2-12,resizeGrip.y+resizeGrip.height/2-12,{steps:6});await page.mouse.up();await page.waitForTimeout(220);
 assert.deepEqual(await geometry(),unchangedGeometry,'a small resize snaps back to the same cells');
 assert.equal(await arrangeButton.getAttribute('data-mode'),'1','unchanged resize preserves automatic mode');
 await page.waitForTimeout(220);sourceBox=await page.locator('[data-panel=auto-0] .panel-header').boundingBox();const swapBox=await page.locator('[data-panel=auto-1]').boundingBox();
 await page.mouse.move(sourceBox.x+40,sourceBox.y+15);await page.mouse.down();await page.mouse.move(swapBox.x+swapBox.width/2,swapBox.y+swapBox.height/2,{steps:15});await page.locator('.dock-preview[data-edge=center]').waitFor();await page.mouse.up();await page.waitForFunction(()=>document.querySelector('.layout-cycle')?.dataset.mode==='0');await page.waitForTimeout(250);
 assert.equal(await layoutLabel.textContent(),'Custom');assert.equal(await arrangeButton.locator('svg').evaluate(node=>node.style.transform),'rotate(0deg)','manual docking restores the upright Custom icon');
 assert.equal(await arrangeButton.locator('svg').evaluate(node=>getComputedStyle(node).transform),'matrix(1, 0, 0, 1, 0, 0)');
 const editedGeometry=await geometry();await cycle(1);await cycle(2);await cycle(3);assert.deepEqual(await cycle(0),editedGeometry);
 await cycle(1);await page.locator('[data-panel=auto-0] .panel-header > svg').dblclick();assert.equal(await arrangeButton.getAttribute('data-mode'),'0');
 assert.equal(await arrangeButton.locator('svg').evaluate(node=>node.style.transform),'rotate(0deg)');
 check('cancelled and same-cell edits preserve the mode; changed geometry restores upright Custom and becomes the next custom snapshot');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);assert.equal(await arrangeButton.count(),0);
 if(!await page.locator('[data-component-name=auto-0]').isVisible())await page.getByRole('button',{name:'More components',exact:true}).click();await page.locator('[data-component-name=auto-0]').click();
 const mobileFiles=page.locator('[data-panel=auto-0] .file-view');await mobileFiles.locator('..').getByRole('textbox',{name:'File or directory path'}).fill(controls);await mobileFiles.locator('..').getByRole('textbox',{name:'File or directory path'}).press('Enter');await page.waitForFunction(()=>document.querySelector('[data-component-name=auto-0] .component-tab-title')?.textContent==='controls');
 assert.equal(await page.locator('[data-component-name=auto-0] > svg').count(),1);
 assert.ok(await page.locator('.component-tabs .visible-tabs > .component-tab-item').count()>=2);
 assert.equal(await page.locator('.component-tabs .visible-tabs > .component-tab-item').nth(1).evaluate(node=>getComputedStyle(node,'::before').opacity),'0.2');
 await page.getByRole('button',{name:'More components',exact:true}).click();assert.ok(await page.locator('.overflow-tabs:popover-open .component-tab').count()>0);assert.ok(await page.locator('.component-tab').evaluateAll(nodes=>nodes.every(node=>node.querySelector(':scope > svg'))));await page.screenshot({path:'test-results/layout-mobile-tabs.png'});await page.keyboard.press('Escape');
 check('mobile hides layout, shows distinct component icons after path updates and in overflow, with subtle tab separators');
 await page.waitForTimeout(400);await page.goto('about:blank');
 const portraitSettings=(await(await api('/me')).json()).settings,portrait=portraitSettings.workspaces[0];
 portrait.columns=2;portrait.rows=4;delete portrait.layout;
 portrait.panels=portrait.panels.filter(p=>['auto-0','auto-1','auto-2','auto-3','auto-5'].includes(p.id)).map((p,i)=>({...p,x:i%2,y:Math.floor(i/2),w:1,h:1}));
 assert.equal((await api('/settings','PUT',portraitSettings)).status(),200);await page.setViewportSize({width:900,height:1200});await page.goto(base);await page.waitForFunction(()=>document.querySelectorAll('.terminal-view[data-state=connected]').length===3);
 const portraitLayout=await cycle(1);assert.ok(portraitLayout.filter(p=>Number(p.id.split('-')[1])%2).every(p=>p.y>=2));await page.screenshot({path:'test-results/layout-balanced-portrait.png'});
 const portraitTerminals=await cycle(2),portraitFiles=await cycle(3);assert.ok(fileArea(portraitTerminals)<fileArea(portraitLayout));assert.ok(fileArea(portraitFiles)>fileArea(portraitLayout));check('portrait Balanced leaves space for both types; each priority visibly redistributes it');
 for(const [width,height,columns,files,terminals] of [[1280,800,4,1,1],[1920,1080,4,2,2],[2560,1080,4,2,2],[3440,1440,4,2,2],[5120,1440,4,2,2]]){
  await page.waitForTimeout(400);await page.goto('about:blank');await page.setViewportSize({width,height});
  const current=(await(await api('/me')).json()).settings;
  const panels=[...portrait.panels.filter(p=>p.kind==='files').slice(0,files),...portrait.panels.filter(p=>p.kind==='terminal').slice(0,terminals)].map((p,i)=>({...p,x:i*columns/(files+terminals),y:0,w:columns/(files+terminals),h:2}));
  current.current='layouts';current.workspaces=[{id:'layouts',name:'Layouts',columns,rows:2,active:panels[0].id,panels}];
  assert.equal((await api('/settings','PUT',current)).status(),200);await page.goto(base);
  await page.waitForFunction(count=>document.querySelectorAll('.terminal-view[data-state=connected]').length===count,terminals);await page.waitForTimeout(400);
  const original=await geometry(),automatic=[];
  for(const mode of [1,2,3,0]){
   const next=await cycle(mode);
   if(mode)automatic.push(next);else assert.deepEqual(next,original);
   if(width===3440&&mode)await page.screenshot({path:`test-results/layout-default-wide-${mode}.png`});
  }
  assert.ok(fileArea(automatic[1])<=fileArea(automatic[0]));
  // Modes may coincide when expanding into spare cells leaves the same useful geometry.
  assert.ok(fileArea(automatic[2])>=fileArea(automatic[0]));
  if(columns===4&&files===1&&terminals===1)assert.ok(automatic.every(panels=>panels.reduce((sum,p)=>sum+p.w*p.h,0)===8),'both components must use all available cells');
  check(`${width}x${height}, saved ${columns}x2 grid, ${files} files/${terminals} terminals: priority modes reclaim spare cells and custom restores`);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);check('no browser exceptions or external network assets; PDF uses the browser’s local viewer');
} catch(error){await page.screenshot({path:'test-results/features-failure.png'});console.log({errors});throw error;}finally{await browser.close()}
