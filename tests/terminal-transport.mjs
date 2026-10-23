import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
assert.equal(spawnSync('getent', ['passwd', user], { encoding: 'utf8' }).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
const terminals = [], errors = [];
try {
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const me = await (await context.request.get(base + '/api/me')).json();
    const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const response = await api('/terminals', 'POST', { name: 'Transport test', columns: 80, rows: 24 });
    assert.equal(response.status(), 201, await response.text());
    const info = await response.json(); terminals.push(info.id);
    const bundle = await build({ stdin: { contents: `
        import { TerminalView } from './web/term';
        import { setCSRF } from './web/ui';
        import { retainedScrollback } from './web/terminal/state';
        window.retainedScrollback = retainedScrollback;
        window.mount = (me, id) => {
            setCSRF(me.csrf);
            const panel = {id:'test',kind:'terminal',terminal:id,path:me.user.home,x:0,y:0,w:4,h:2};
            window.view = new TerminalView(document.querySelector('#terminal'), panel, {user:me.user, changed(){}, close(){}, openTerminal(){}});
        };
    `, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const sent = [], resizeRequests = [], trace=[], snapshots=[];
    let client, upstream, connections = 0, holdAcks = false, heldAcks = [], holdResize = false, heldResize = [];
    await page.routeWebSocket('**/api/terminals/*/ws', ws => {
        client = ws; upstream = ws.connectToServer(); connections++;
        const server = upstream;
        ws.onMessage(message => {
            sent.push(message); trace.push(typeof message === 'string' ? ['send',message] : ['input',message.length]);
            if (typeof message === 'string' && JSON.parse(message).type === 'resize') resizeRequests.push(JSON.parse(message));
            server.send(message);
        });
        server.onClose((code,reason)=>{trace.push(['server close',code,reason]); ws.close({code,reason});});
        server.onMessage(message => {
            trace.push(['receive',typeof message === 'string' ? message.slice(0,100) : message.length]);
            if (typeof message === 'string') {
                const value = JSON.parse(message);
                if(value.type==='snapshot') snapshots.push(message.length);
                if (holdAcks && value.type === 'ack') { heldAcks.push(message); return; }
                if (holdResize && value.type === 'resize-ack') { heldResize.push(message); return; }
            }
            ws.send(message);
        });
    });
    await page.goto(base + '/health');
    await page.setContent('<div class="panel"><header class="panel-header"><svg></svg><span class="panel-title">Terminal</span><div class="panel-tools"></div></header><main id="terminal" style="height:400px;width:800px"></main></div>');
    await page.addStyleTag({ content: await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('web/style.css', 'utf8') });
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => typeof window.mount === 'function');
    await page.evaluate(({me,id}) => mount(me,id), {me,id:info.id});
    const connected = () => page.waitForFunction(() => document.querySelector('#terminal').dataset.state === 'connected').catch(async error => { console.error({errors, state:await page.locator('#terminal').getAttribute('data-state'), notices:await page.locator('.toast').allTextContents(), connections,trace:trace.slice(-25)}); throw error; });
    const idle = () => page.waitForFunction(() => !view.inFlight.length && !view.resizing && view.queue.length === 0);
    const input = text => page.evaluate(text => view.term.input(text), text);
    await connected(); await idle();
    await input("printf 'BINARY_%s\\n' WORKS\n");
    await page.waitForFunction(() => view.term.buffer.active.getLine(view.term.buffer.active.cursorY - 1)?.translateToString().includes('BINARY_WORKS'));
    await idle();
    assert.equal(await page.evaluate(() => view.term.options.scrollback), await page.evaluate(() => retainedScrollback(view.term.cols, view.term.rows)));
    console.log('PASS real PTY binary output, input acknowledgement and canonical scrollback');

    let linkReferer;
    await context.route('https://terminal-link.invalid/**',route=>{linkReferer=route.request().headers().referer;return route.fulfill({body:'Terminal link test'});});
    await input("printf '\\033]8;;https://terminal-link.invalid/check\\aOPEN_TEST_LINK\\033]8;;\\a\\n'\n");
    const link=page.locator('.xterm-rows span').filter({hasText:/^OPEN_TEST_LINK$/});
    await link.waitFor(); await idle();
    await page.waitForTimeout(250);
    const linkBox=await link.boundingBox(), linkX=linkBox.x+linkBox.width/2, linkY=linkBox.y+linkBox.height/2;
    await page.mouse.move(linkX,linkY);
    await page.waitForFunction(()=>!!document.querySelector('.xterm-cursor-pointer'));
    const opened=context.waitForEvent('page'); await page.mouse.click(linkX,linkY);
    const popup=await opened; await popup.waitForLoadState();
    assert.equal(await popup.evaluate(()=>window.opener),null); assert.equal(linkReferer,undefined); await popup.close();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.xterm-scrollable-element')).overscrollBehavior),'contain');
    await page.evaluate(()=>{view.term.focus();view.term.select(0,0,4);});
    await page.locator('.xterm-selection > div').first().waitFor({state:'attached'});
    assert.ok(await page.locator('.xterm-selection > div').first().evaluate(node=>Number(getComputedStyle(node).backgroundColor.match(/[\d.]+/g).at(-1))>=.4));
    await page.evaluate(()=>view.term.clearSelection());
    console.log('PASS direct terminal links isolate the opener/referrer, selection contrast and contained scrolling');

    // Keep one real write pending while the next connection delivers its snapshot.
    await page.evaluate(() => {
        const write = view.term.write.bind(view.term);
        view.term.write = (data, callback) => {
            view.term.write = write;
            window.releaseRender = () => write('STALE_DRAW', callback);
        };
    });
    await input("printf 'RECOVERY_%s\\n' ORDER\n");
    await page.waitForFunction(() => typeof releaseRender === 'function');
    client.send(JSON.stringify({type:'error',message:'Immediate test notice'}));
    await page.getByText('Immediate test notice', {exact:true}).waitFor();
    const before = connections;
    client.close({code:4000}); upstream.close({code:4000});
    await assert.doesNotReject(async () => {
        for (let i=0; connections===before && i<100; i++) await page.waitForTimeout(50);
        assert.equal(connections,before+1);
    });
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => view.ready), false, 'new snapshot must wait for old writes');
    await page.evaluate(() => releaseRender());
    await connected(); await idle();
    assert.equal(await page.evaluate(() => [...Array(view.term.buffer.active.length)].map((_,i)=>view.term.buffer.active.getLine(i).translateToString()).join('\n').includes('STALE_DRAW')), false);
    assert.equal((await (await api(`/terminals/${info.id}`)).json()).pid, info.pid);
    console.log('PASS immediate errors during drawing; reconnect waits for old writes and preserves PID');

    // A lost acknowledgement must not cause a command to be replayed.
    holdAcks = true;
    const sentBefore = sent.length;
    await input("printf 'ONCE_%s\\n' ONLY\n");
    for(let i=0; !heldAcks.length && i<100; i++) await page.waitForTimeout(20);
    assert.equal(heldAcks.length,1);
    client.close({code:4000}); upstream.close({code:4000}); holdAcks=false; heldAcks=[];
    await page.getByText('Connection restored; check your last input before continuing', {exact:true}).waitFor();
    await connected(); await idle();
    assert.equal(sent.slice(sentBefore).filter(v=>Buffer.isBuffer(v) && v.toString().includes('ONCE_')).length,1);
    console.log('PASS uncertain input is reported and never replayed');

    // Bound both bytes and tiny frames while the real server's ack is held.
    holdAcks=true;
    const byteFrames = sent.filter(Buffer.isBuffer).length;
    await page.evaluate(() => {
        view.term.input('x'.repeat(262145));
        view.term.input('界'.repeat(100000));
    });
    assert.equal(sent.filter(Buffer.isBuffer).length,byteFrames,'oversized pastes rejected whole');
    await input('x');
    await page.waitForFunction(() => !!view.inFlight.length);
    await input('x'.repeat(262144));
    assert.deepEqual(await page.evaluate(()=>[view.queue.length,view.pendingBytes]),[0,1],'in-flight bytes count against the paste budget');
    await page.evaluate(() => { for(let i=0;i<600;i++) view.term.input('x'); });
    assert.deepEqual(await page.evaluate(()=>[view.queue.length,view.inFlight.length,view.pendingBytes]),[448,64,512]);
    for(let i=0; heldAcks.length<64 && i<100; i++) await page.waitForTimeout(20);
    assert.equal(heldAcks.length,64,'the input window must pipeline tiny frames without waiting for a round trip');
    // Drain the burst's echo before deliberately holding a render callback below.
    await page.waitForFunction(()=>Array.from({length:view.term.buffer.active.length},(_,i)=>view.term.buffer.active.getLine(i).translateToString(true)).join('').includes('x'.repeat(64)));
    await page.evaluate(()=>view.displayQueue);
    // Control loss drops queued keys immediately, even with a render callback held.
    await page.evaluate(() => {
        const write=view.term.write.bind(view.term);
        view.term.write=(data,callback)=>{view.term.write=write;window.releaseControlDraw=()=>write(data,callback);};
    });
    await page.locator('#terminal').evaluate(node=>node.style.width='780px');
    await page.waitForFunction(()=>typeof window.releaseControlDraw==='function');
    const observer = await context.newPage();
    await observer.goto(base + '/health');
    await observer.evaluate(async id => {
        window.other=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/terminals/${id}/ws`);
        other.binaryType='arraybuffer';
        other.onmessage=event=>{
            const value=typeof event.data==='string'?JSON.parse(event.data):{sequence:Number(new DataView(event.data).getBigUint64(0))};
            if(value.sequence) other.send(JSON.stringify({type:'rendered',sequence:value.sequence}));
            if(value.type==='snapshot') other.send(JSON.stringify({type:'take-control'}));
        };
    },info.id);
    await page.locator('#terminal[data-state=viewing]').waitFor().catch(async error => {
        console.error({state:await page.locator('#terminal').getAttribute('data-state'),trace:trace.slice(-30),notices:await page.locator('.toast').allTextContents()}); throw error;
    });
    assert.deepEqual(await page.evaluate(()=>[view.queue.length,view.pendingBytes,view.term.options.disableStdin]),[0,64,true]);
    holdAcks=false; for(const ack of heldAcks) client.send(ack); heldAcks=[];
    await page.waitForFunction(()=>!view.inFlight.length);
    await observer.close();
    await page.evaluate(async()=>{releaseControlDraw();await view.displayQueue;});
    await page.getByRole('button',{name:'Take control',exact:true}).click();
    await connected(); await idle();
    await input('\x15'); await idle();
    console.log('PASS paste byte/frame limits, immediate control loss, and input gates');

    const paste = '界a'.repeat(40000), suffix = 'Z!';
    const expectedHash = createHash('sha256').update(paste + suffix).digest('hex');
    const receiver = `import os,tty,termios,hashlib
old=termios.tcgetattr(0)
try:
 tty.setraw(0)
 os.write(1,b'PASTE_READY\\r\\n')
 data=b''
 while len(data)<160002: data+=os.read(0,160002-len(data))
 os.write(1,('PASTE_HASH_'+hashlib.sha256(data).hexdigest()+'\\r\\n').encode())
finally: termios.tcsetattr(0,termios.TCSANOW,old)
`;
    await input(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(receiver).toString('base64')}'))"\n`);
    await page.waitForFunction(()=>document.querySelector('.xterm-rows').textContent.includes('PASTE_READY'));
    await idle(); holdAcks=true;
    await input(paste); await input(suffix);
    for(let i=0; !heldAcks.length && i<100; i++) await page.waitForTimeout(20);
    assert.equal(heldAcks.length,1);
    assert.deepEqual(await page.evaluate(()=>[view.inFlight,view.queue.map(frame=>frame.length),view.pendingBytes]),[[65536],[65536,28928,2],160002]);
    holdAcks=false; for(const ack of heldAcks) client.send(ack); heldAcks=[];
    await idle();
    await page.waitForFunction(hash=>document.querySelector('.xterm-rows').textContent.includes('PASTE_HASH_'+hash),expectedHash);
    console.log('PASS 160 KB Unicode paste and following input preserve exact bytes across the 64 KiB window');

    holdResize=true; const resizeBefore=resizeRequests.length;
    await page.locator('#terminal').evaluate(node=>node.style.width='600px');
    for(let i=0; !heldResize.length && i<100; i++) await page.waitForTimeout(20);
    assert.equal(heldResize.length,1);
    for(const width of [680,740,900]) { await page.locator('#terminal').evaluate((node,width)=>node.style.width=width+'px',width); await page.waitForTimeout(100); }
    assert.equal(resizeRequests.length,resizeBefore+1,'one outstanding resize');
    holdResize=false; for(const ack of heldResize) client.send(ack); heldResize=[];
    await idle(); await page.waitForTimeout(200); await idle();
    assert.equal(resizeRequests.length,resizeBefore+2,'only latest pending dimensions sent');
    assert.equal(await page.evaluate(()=>view.term.options.scrollback),await page.evaluate(()=>retainedScrollback(view.term.cols,view.term.rows)));
    console.log('PASS coalesced resize and matching retained history');

    // Fill the real transport window while parsing is held, then drain it in order.
    await page.evaluate(() => {
        const write = view.term.write.bind(view.term);
        window.outputWrites = [];
        view.term.write = (data, callback) => outputWrites.push(() => write(data, callback));
        window.releaseOutput = () => { view.term.write = write; for (const submit of outputWrites) submit(); };
    });
    const burst = `import os\nfor i in range(2000): os.write(1,('BATCH_%04d '%i+'x'*30+'\\r\\n').encode())\nos.write(1,b'BATCH_DONE\\r\\n')\n`;
    await input(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(burst).toString('base64')}'))"\n`);
    await page.waitForFunction(() => outputWrites.length >= 8);
    const columns = await page.evaluate(() => view.term.cols), barrierStart = resizeRequests.length;
    await page.locator('#terminal').evaluate(node => node.style.width = '820px');
    for (let i=0; resizeRequests.length===barrierStart && i<100; i++) await page.waitForTimeout(20);
    assert.equal(resizeRequests.length, barrierStart+1);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => view.term.cols), columns, 'resize waits for preceding writes');
    await page.evaluate(() => releaseOutput());
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('BATCH_DONE'));
    await idle();
    const batchHistory = await page.evaluate(() => [...Array(view.term.buffer.active.length)].map((_,i) => view.term.buffer.active.getLine(i).translateToString()).join('\n'));
    assert.equal((batchHistory.match(/BATCH_\d{4}/g) || []).length, 2000);
    assert.ok(await page.evaluate(() => view.term.cols) !== columns);
    console.log('PASS output pipelines while parsing is pending; resize is an ordered barrier and all 2,000 rows survive');

    // A real SIGWINCH handler rebuilds scrollback slowly, beyond xterm's one-second timeout.
    const redraw = `import os,signal,termios,tty,time\nold=termios.tcgetattr(0)\ndef resize(*_):\n time.sleep(.4)\n os.write(1,b'\\x1b[?2026h\\x1b[3J\\x1b[2J\\x1b[HPARTIAL_REDRAW\\r\\n')\n time.sleep(1.6)\n for i in range(80): os.write(1,('REBUILT_%02d\\r\\n'%i).encode())\n os.write(1,b'REDRAW_COMPLETE\\x1b[?2026l')\nsignal.signal(signal.SIGWINCH,resize)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[2J\\x1b[HBEFORE_RESIZE')\n while os.read(0,1)!=b'q': pass\nfinally: termios.tcsetattr(0,termios.TCSANOW,old)\n`;
    await input(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(redraw).toString('base64')}'))"\n`);
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('BEFORE_RESIZE'));
    await idle(); await page.waitForTimeout(350);
    await page.evaluate(() => {
        window.beforeResize = document.querySelector('.xterm-rows').textContent;
        window.beforeScrollbar = document.querySelector('.xterm .slider').getAttribute('style');
        window.resizePaints = [];
        window.resizeObserver = new MutationObserver(() => resizePaints.push(document.querySelector('.xterm-rows').textContent));
        resizeObserver.observe(document.querySelector('.xterm-rows'), {childList:true,characterData:true,subtree:true});
    });
    await mkdir('test-results', {recursive:true});
    await page.screenshot({path:'test-results/terminal-resize-before.png'});
    await page.locator('#terminal').evaluate(node => node.style.width = '700px');
    await page.waitForFunction(() => view.term.buffer.active.getLine(0)?.translateToString().includes('PARTIAL_REDRAW'));
    await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => document.querySelector('.xterm-rows').textContent === beforeResize), 'old frame stays visible beyond the synchronized-output timeout');
    assert.ok(await page.evaluate(() => document.querySelector('.xterm .slider').getAttribute('style') === beforeScrollbar), 'scrollbar stays stable during reconstruction');
    await page.screenshot({path:'test-results/terminal-resize-during.png'});
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('REDRAW_COMPLETE'));
    assert.ok(await page.evaluate(() => resizePaints.every(text => text === beforeResize || text.includes('REDRAW_COMPLETE'))), 'no partial transcript is painted');
    await page.evaluate(() => resizeObserver.disconnect());
    await page.screenshot({path:'test-results/terminal-resize-after.png'});
    await input('q'); await idle();
    console.log('PASS real PTY resize reconstructs in the background beyond one second, preserving the old frame and scrollbar until completion');

    for(const malformed of [Buffer.alloc(3),JSON.stringify({type:'resize',columns:999,rows:24,sequence:2}),JSON.stringify({type:'mystery'}),JSON.stringify({type:'ack'}),JSON.stringify({type:'exit',sequence:Number.MAX_SAFE_INTEGER+1}),JSON.stringify({type:'closed'})]) {
        const before=connections; client.send(malformed);
        await page.locator('#terminal[data-state=disconnected]').waitFor();
        await connected(); await idle();
        assert.equal(connections,before+1);
    }
    assert.equal((await (await api(`/terminals/${info.id}`)).json()).pid,info.pid);
    assert.deepEqual(errors,[]);
    console.log('PASS malformed output disconnects only its view and recovers the same shell');
    await input("seq -f 'HISTORY_%04g' 1 2000; printf 'HISTORY_%s\\n' END\n");
    await page.waitForFunction(()=>[...Array(view.term.buffer.active.length)].some((_,i)=>view.term.buffer.active.getLine(i).translateToString().includes('HISTORY_END')));
    await idle();
    client.close({code:4000}); upstream.close({code:4000});
    await page.locator('#terminal[data-state=disconnected]').waitFor(); await connected(); await idle();
    assert.ok(snapshots.at(-1)>1<<20, 'large recovery must bypass the live-output queue limit');
    const history=await page.evaluate(()=>[...Array(view.term.buffer.active.length)].map((_,i)=>view.term.buffer.active.getLine(i).translateToString()).join('\n'));
    assert.ok(history.includes('HISTORY_0001') && history.includes('HISTORY_2000') && history.includes('HISTORY_END'));
    assert.equal((await (await api(`/terminals/${info.id}`)).json()).pid,info.pid);
    console.log('PASS multi-megabyte recovery preserves 2,000 history rows and the shell');
    await page.evaluate(()=>view.dispose());
} finally {
    await context.close();
    const cleanup = await browser.newContext({ignoreHTTPSErrors:true});
    await cleanup.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}});
    const me=await (await cleanup.request.get(base+'/api/me')).json();
    for(const id of terminals) await cleanup.request.delete(base+'/api/terminals/'+id,{headers:{'X-Tuxee-CSRF':me.csrf,'X-Tuxee-Client':'web'}});
    await browser.close();
}
