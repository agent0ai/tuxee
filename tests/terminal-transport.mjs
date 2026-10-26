import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const base = process.env.TUXEE_TEST_URL || 'https://127.0.0.1:9443';
const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-a';
const container = process.env.TUXEE_TEST_CONTAINER;
const run = (command, args, input) => spawnSync(container ? 'docker' : command,
    container ? ['exec', '-i', container, command, ...args] : args, { input, encoding: 'utf8' });
assert.equal(run('getent', ['passwd', user]).stdout.trim().split(':')[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(run('chpasswd', [], `${user}:${password}\n`).status, 0);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
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
    let holdOutput = true, heldOutput = [];
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
            if (holdOutput) { heldOutput.push(message); return; }
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
    const rendering = page.getByRole('status', { includeHidden: true }).filter({ hasText: /^Loading\.\.\.$/ });
    await rendering.waitFor();
    await mkdir('test-results', { recursive: true });
    for (const [width, theme] of [[800, 'dark'], [320, 'light']]) {
        await page.evaluate(({width, theme}) => {
            document.querySelector('#terminal').style.width = `${width}px`;
            document.documentElement.dataset.theme = theme;
        }, {width, theme});
        const host = await page.locator('.terminal-host').boundingBox();
        const text = await rendering.evaluate(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, pointerEvents: getComputedStyle(node).pointerEvents };
        });
        assert.ok(Math.abs(text.x + text.width / 2 - host.x - host.width / 2) < 1);
        assert.ok(Math.abs(text.y + text.height / 2 - host.y - host.height / 2) < 1);
        assert.equal(text.pointerEvents, 'none');
        await page.locator('#terminal').screenshot({path:`test-results/terminal-rendering-${theme}.png`});
    }
    await page.locator('#terminal').evaluate(node => { node.style.width = '800px'; node.style.display = 'none'; });
    await page.waitForFunction(() => view.term._core._renderService._isPaused);
    holdOutput = false; for (const message of heldOutput) client.send(message); heldOutput = [];
    await connected();
    assert.equal(await rendering.count(), 1, 'snapshot restoration waits for the hidden terminal to paint');
    await page.locator('#terminal').evaluate(node => node.style.display = '');
    await rendering.waitFor({state:'detached'});
    console.log('PASS centered Loading... until first snapshot paint, including hidden terminals, in both themes');
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
    await page.getByText('Connection restored', {exact:true}).waitFor();
    await connected(); await idle();
    assert.equal(sent.slice(sentBefore).filter(v=>Buffer.isBuffer(v) && v.toString().includes('ONCE_')).length,1);
    console.log('PASS reconnect is reported and uncertain input is never replayed');

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
    const redraw = `import os,signal,termios,tty,time\nold=termios.tcgetattr(0)\nredraws=0\ndef resize(*_):\n global redraws\n redraws+=1\n time.sleep(.4)\n os.write(1,b'\\x1b[?2026h\\x1b[3J\\x1b[2J\\x1b[HPARTIAL_REDRAW\\r\\n')\n time.sleep(1.6)\n for i in range(80*redraws): os.write(1,('REBUILT_%02d\\r\\n'%i).encode())\n time.sleep(.3)\n os.write(1,b'REDRAW_COMPLETE\\x1b[?2026l')\nsignal.signal(signal.SIGWINCH,resize)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[2J\\x1b[HBEFORE_RESIZE')\n while os.read(0,1)!=b'q': pass\nfinally: termios.tcsetattr(0,termios.TCSANOW,old)\n`;
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
    await page.evaluate(() => view.term.scrollLines(-10));
    await page.locator('#terminal').evaluate(node => node.style.width = '680px');
    await page.waitForFunction(() => view.term.buffer.active.getLine(160)?.translateToString().includes('REBUILT_159'));
    await input('x');
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('REDRAW_COMPLETE'));
    assert.ok(await page.evaluate(() => view.term.buffer.active.viewportY === view.term.buffer.active.baseY), 'real typing during redraw returns to the rebuilt bottom');
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
    const bottom = page.getByRole('button', {name:'Jump to bottom', exact:true});
    await page.waitForFunction(() => document.querySelector('.terminal-footer button[aria-label="Jump to bottom"]').disabled);
    await page.evaluate(() => view.term.scrollLines(-3));
    assert.equal(await bottom.isEnabled(), true, 'footer remains available even a few rows above the bottom');
    await page.evaluate(() => view.term.scrollLines(-1));
    await bottom.waitFor({state:'visible'});
    const inputCount = sent.filter(value => typeof value !== 'string').length;
    for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const host = await page.locator('.terminal-host').boundingBox(), control = await bottom.boundingBox();
        assert.ok(control.x > host.x + host.width / 2 && control.x + control.width < host.x + host.width);
        assert.ok(control.y >= host.y + host.height, 'scroll control is below the renderer in the footer');
        await bottom.screenshot({path:`test-results/terminal-bottom-${theme}.png`});
    }
    await bottom.click();
    await page.waitForFunction(() => document.querySelector('.terminal-footer button[aria-label="Jump to bottom"]').disabled);
    assert.ok(await page.evaluate(() => view.term.buffer.active.baseY === view.term.buffer.active.viewportY));
    assert.ok(await page.evaluate(() => document.activeElement === view.term.textarea));
    await page.evaluate(() => view.term.scrollLines(-10));
    await bottom.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.terminal-footer button[aria-label="Jump to bottom"]').disabled);
    assert.ok(await page.evaluate(() => view.term.buffer.active.baseY === view.term.buffer.active.viewportY));
    assert.equal(sent.filter(value => typeof value !== 'string').length, inputCount, 'jumping never sends terminal input');
    await input("printf '\\033[?1049hALT_SCREEN\\n'\n");
    await page.waitForFunction(() => view.term.buffer.active.type === 'alternate');
    assert.equal(await bottom.isEnabled(), false);
    await input("printf '\\033[?1049l'\n");
    await page.waitForFunction(() => view.term.buffer.active.type === 'normal');
    console.log('PASS persistent footer, scroll placement, themes, pointer/keyboard activation, focus and alternate-screen disabling');
    const top = page.getByRole('button', {name:'Jump to top', exact:true});
    await top.click();
    assert.equal(await page.evaluate(() => view.term.buffer.active.viewportY), 0);
    await bottom.click();

    const textButton = page.getByRole('button', {name:'Terminal contents as text', exact:true});
    const textContent = page.getByRole('textbox', {name:'Terminal contents as text', exact:true});
    const wrapped = 'x'.repeat(await page.evaluate(() => view.term.cols - 1)) + '界_WRAP_DONE';
    await input(`printf '%s\\n' '${wrapped}'\n`);
    await page.waitForFunction(() => Array.from({length:view.term.buffer.active.length}, (_,i) => view.term.buffer.active.getLine(i).translateToString(true)).some(line => line.endsWith('界_WRAP_DONE')));
    const beforeText = await page.evaluate(() => [view.term.cols, view.term.rows]);
    await textButton.click();
    assert.ok((await textContent.inputValue()).includes('HISTORY_0001'));
    assert.ok((await textContent.inputValue()).includes('HISTORY_2000'));
    assert.ok((await textContent.inputValue()).split('\n').includes(wrapped), 'wide-character wrap padding is not copied');
    assert.deepEqual(await page.evaluate(() => [view.term.cols, view.term.rows]), beforeText, 'popover does not resize PTY');
    assert.equal(await textContent.evaluate(node => node.selectionEnd - node.selectionStart), 0, 'opening static text does not select it');
    assert.equal(await textButton.getAttribute('aria-expanded'), 'true');
    await textButton.click();
    await textContent.waitFor({state:'detached'});
    assert.equal(await textButton.getAttribute('aria-expanded'), 'false');
    await textButton.click();
    await page.keyboard.press('Escape');
    await textContent.waitFor({state:'detached'});
    assert.equal(await textButton.getAttribute('aria-expanded'), 'false');
    assert.ok(await textButton.evaluate(node => node === document.activeElement));

    const toggle = page.getByRole('button', {name:'Toggle terminal input', exact:true});
    const drawer = page.getByRole('textbox', {name:'Terminal input drawer', exact:true});
    const initialRows = await page.evaluate(() => view.term.rows);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(rows => view.term.rows < rows, initialRows); await idle();
    assert.equal(await drawer.getAttribute('rows'), '3');
    const drawerGrip = page.getByRole('separator', {name:'Resize terminal input', exact:true});
    const startHeight = (await drawer.boundingBox()).height;
    const startRows = await page.evaluate(() => view.term.rows), startResizes = resizeRequests.length;
    await drawer.fill('draft stays through resize');
    await page.evaluate(() => {
        window.drawerRefreshes = 0; window.originalRefresh = view.term.refresh;
        view.term.refresh = function(...args) { drawerRefreshes++; return originalRefresh.apply(this, args); };
    });
    let grip = await drawerGrip.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.evaluate(() => drawerRefreshes = 0);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 90, {steps:8});
    await page.waitForTimeout(300);
    assert.ok((await drawer.boundingBox()).height > startHeight + 80, 'drawer follows the drag');
    assert.equal(resizeRequests.length, startResizes, 'no PTY resize while dragging');
    assert.equal(await page.evaluate(() => view.term.rows), startRows);
    assert.equal(await page.evaluate(() => drawerRefreshes), 0, 'no explicit terminal redraw while dragging');
    await page.mouse.up();
    await page.waitForFunction(rows => view.term.rows < rows, startRows); await idle();
    assert.equal(resizeRequests.length, startResizes + 1, 'one PTY resize after release');
    const resizedHeight = (await drawer.boundingBox()).height;
    await toggle.click(); assert.equal(await drawerGrip.isVisible(), false);
    await toggle.click(); await page.waitForTimeout(250); await idle();
    assert.equal((await drawer.boundingBox()).height, resizedHeight, 'toggle remembers chosen height');
    assert.equal(await drawer.inputValue(), 'draft stays through resize');
    for (const cancel of ['Escape', 'pointercancel', 'blur']) {
        const before = resizeRequests.length;
        grip = await drawerGrip.boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 40, {steps:4});
        await page.waitForTimeout(150);
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        else await drawerGrip.dispatchEvent('pointercancel', {pointerId:1});
        await page.mouse.up(); await page.waitForTimeout(250); await idle();
        assert.equal((await drawer.boundingBox()).height, resizedHeight, `${cancel} restores height`);
        assert.equal(resizeRequests.length, before, `${cancel} must not resize the PTY`);
    }
    await drawerGrip.focus(); await page.keyboard.press('Home'); await page.waitForTimeout(250); await idle();
    assert.ok((await drawer.boundingBox()).height < startHeight, 'keyboard can shrink to one line');
    await page.keyboard.press('End'); await page.waitForTimeout(250); await idle();
    assert.ok((await page.locator('.terminal-host').boundingBox()).height >= 39, 'maximum leaves terminal visible');
    await drawer.evaluate(node => node.style.height = '');
    await page.waitForTimeout(250); await idle();
    await page.evaluate(() => view.term.refresh = originalRefresh);
    console.log('PASS three-line drawer, drag preview without PTY resize/redraw, one release resize, retained height/draft, cancellation and keyboard bounds');
    await page.evaluate(() => view.term.scrollToTop());
    await drawer.fill('printf DRAWER_ONE'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('DRAWER_ONE'));
    await idle();
    assert.equal(await drawer.inputValue(), '');
    assert.ok(await page.evaluate(() => view.term.buffer.active.viewportY === view.term.buffer.active.baseY));
    assert.ok(await drawer.evaluate(node => node === document.activeElement));
    await drawer.fill('printf DRAWER_TWO'); await page.keyboard.press('Control+Enter'); await idle();
    assert.equal(await drawer.inputValue(), '');
    await page.keyboard.press('Enter'); await idle();
    await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('DRAWER_TWO'));
    await drawer.fill('draft'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('line two');
    assert.equal(await drawer.inputValue(), 'draft\nline two');
    const beforeIME = sent.filter(Buffer.isBuffer).length;
    await drawer.dispatchEvent('keydown', {key:'Enter', isComposing:true});
    assert.equal(sent.filter(Buffer.isBuffer).length, beforeIME);
    await toggle.click(); await toggle.click();
    assert.equal(await drawer.inputValue(), 'draft\nline two', 'toggle retains draft');
    const beforeRejected = sent.filter(Buffer.isBuffer).length;
    await drawer.fill('界'.repeat(100000)); await page.keyboard.press('Enter');
    assert.equal((await drawer.inputValue()).length, 100000, 'rejected paste preserves draft');
    assert.equal(sent.filter(Buffer.isBuffer).length, beforeRejected, 'rejected paste sends no Enter');
    await drawer.fill('retained draft');
    holdOutput = true;
    const beforeReconnect = connections;
    await page.evaluate(() => window.previousSocket = view.socket);
    await page.getByRole('button', {name:'Reconnect terminal', exact:true}).click();
    await page.locator('#terminal[data-state=connecting]').waitFor();
    await rendering.waitFor();
    await page.waitForFunction(() => previousSocket.readyState === WebSocket.CLOSED && view.socket !== previousSocket);
    await drawer.focus(); await page.keyboard.press('Enter');
    assert.equal(await drawer.inputValue(), 'retained draft', 'disconnected send preserves draft');
    for (let i=0; !heldOutput.length && i<100; i++) await page.waitForTimeout(20);
    assert.ok(heldOutput.length);
    holdOutput = false; for (const message of heldOutput) client.send(message); heldOutput=[];
    await connected(); await idle();
    await rendering.waitFor({state:'detached'});
    assert.equal(connections, beforeReconnect + 1);
    assert.equal((await (await api(`/terminals/${info.id}`)).json()).pid, info.pid);
    assert.equal(await drawer.inputValue(), 'retained draft');
    console.log('PASS text history, no-resize popover, three-line input, send/paste/newline/IME, rejection and reconnect draft/PID preservation');

    // A real raw-mode TUI receives exact paste framing and Enter bytes.
    await drawer.fill('');
    const raw = `import os,tty,termios,hashlib
old=termios.tcgetattr(0)
try:
 tty.setraw(0)
 os.write(1,b'\\x1b[?1049h\\x1b[H\\x1b[?2004h\\x1b[31mTUI_TEXT_\\xe7\\x95\\x8c\\x1b[0m\\r\\n')
 data=b''
 while b'END_RAW' not in data: data+=os.read(0,65536)
 os.write(1,b'\\x1b[?2004l\\x1b[?1049l')
 os.write(1,('DRAWER_HASH_'+hashlib.sha256(data).hexdigest()+'\\r\\n').encode())
finally: termios.tcsetattr(0,termios.TCSANOW,old)
`;
    await input(`python3 -c "import base64;exec(base64.b64decode('${Buffer.from(raw).toString('base64')}'))"\n`);
    await page.waitForFunction(() => view.term.buffer.active.type === 'alternate' && view.term.modes.bracketedPasteMode);
    await textButton.click();
    assert.equal(await textContent.inputValue(), 'TUI_TEXT_界');
    await page.keyboard.press('Escape');
    for (const [text, key] of [['first\n界', 'Enter'], ['second', 'Control+Enter'], ['third', 'Meta+Enter']]) {
        await drawer.fill(text); await page.keyboard.press(key); await idle();
        assert.equal(await drawer.inputValue(), '');
    }
    const bytes = '\x1b[200~first\r界\x1b[201~\r\x1b[200~second\x1b[201~\x1b[200~third\x1b[201~END_RAW';
    await input('END_RAW');
    await page.waitForFunction(hash => document.querySelector('.xterm-rows').textContent.includes('DRAWER_HASH_'+hash), createHash('sha256').update(bytes).digest('hex'));
    console.log('PASS plain-text TUI snapshot and exact multiline Unicode bracketed paste, Ctrl/Cmd paste-only and Enter bytes');
    await input(`for i in {1..6000}; do printf '\\e[48;5;%dm%05d%*s\\e[0m\\r\\n' "$((16+i%216))" "$i" "$((COLUMNS-5))" ''; done; printf 'REFRESH_%s\\n' READY\n`);
    await page.waitForFunction(() => Array.from({length:view.term.buffer.active.length}, (_,i) => view.term.buffer.active.getLine(i).translateToString(true)).includes('REFRESH_READY'));
    await idle();
    const beforeHeavyReconnect = connections;
    await page.evaluate(async () => {
        await new Promise(resolve => view.term.write('\r\nLOCAL_STALE_RENDERER\r\n', resolve));
        window.loadingFrames = [];
        window.refreshStarted = performance.now();
        document.querySelector('button[aria-label="Reconnect terminal"]').click();
        const frame = () => {
            if (document.querySelector('.terminal-rendering')) {
                loadingFrames.push(performance.now()); requestAnimationFrame(frame);
            } else window.refreshFinished = performance.now();
        };
        requestAnimationFrame(frame);
    });
    await connected(); await rendering.waitFor({state:'detached'});
    await page.waitForFunction(() => window.refreshFinished !== undefined);
    assert.equal(connections, beforeHeavyReconnect + 1);
    assert.ok(await page.evaluate(() => loadingFrames.length > 0 && refreshFinished - refreshStarted >= 180), 'fast reconnect has visible loading feedback');
    const restored = await page.evaluate(() => Array.from({length:view.term.buffer.active.length}, (_,i) => view.term.buffer.active.getLine(i).translateToString(true)).join('\n'));
    assert.ok(restored.includes('06000') && restored.includes('REFRESH_READY') && !restored.includes('LOCAL_STALE_RENDERER'));
    assert.equal((await (await api(`/terminals/${info.id}`)).json()).pid, info.pid);
    console.log('PASS 6,000 colored lines: real socket replacement, visible loading through repaint and clean snapshot restoration with the same PID');
    for (const width of [800, 320]) for (const theme of ['dark', 'light']) {
        await page.setViewportSize({width:width+16, height:650});
        await page.evaluate(({width, theme}) => {
            document.querySelector('#terminal').style.width = `${width}px`;
            document.documentElement.dataset.theme = theme;
            document.body.classList.toggle('compact', width === 320);
        }, {width, theme});
        await drawer.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven');
        await page.waitForTimeout(250); await idle();
        assert.ok(await drawer.evaluate(node => node.scrollHeight > node.clientHeight), 'input scrolls beyond three lines');
        if (width === 320 && theme === 'dark') {
            const touch = await context.newCDPSession(page), before = resizeRequests.length;
            const rows = await page.evaluate(() => view.term.rows), bounds = await drawerGrip.boundingBox();
            const point = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
            await touch.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
            await touch.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{...point, y:point.y - 55}]});
            await page.waitForTimeout(250);
            assert.equal(resizeRequests.length, before, 'touch preview does not resize PTY');
            await touch.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
            await page.waitForFunction(rows => view.term.rows < rows, rows); await idle();
            assert.equal(resizeRequests.length, before + 1);
            await page.locator('#terminal').screenshot({path:'test-results/terminal-drawer-touch.png'});
            await drawer.evaluate(node => node.style.height = '');
            await page.waitForTimeout(250); await idle(); await touch.detach();
        }
        assert.ok(await page.locator('.terminal-footer').evaluate(node => node.scrollWidth <= node.clientWidth));
        await page.locator('#terminal').screenshot({path:`test-results/terminal-footer-${width}-${theme}.png`});
        await textButton.click();
        for (const control of [textButton, toggle]) {
            assert.equal(await control.getAttribute('aria-expanded'), 'true');
            await page.waitForFunction(label => getComputedStyle(document.querySelector(`.terminal-footer button[aria-label="${label}"]`)).backgroundColor !== 'rgba(0, 0, 0, 0)', await control.getAttribute('aria-label'));
        }
        assert.equal(await textContent.evaluate(node => node.selectionEnd - node.selectionStart), 0);
        const shades = await textContent.evaluate(node => {
            const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
            const shade = color => { ctx.fillStyle = color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].slice(0,3).reduce((a,b)=>a+b); };
            return [shade(getComputedStyle(node).backgroundColor), shade(getComputedStyle(document.documentElement).getPropertyValue('--bg'))];
        });
        assert.ok(theme === 'dark' ? shades[0] > shades[1] : shades[0] < shades[1], 'static surface reduces contrast in both themes');
        const box = await page.locator('.terminal-text').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width+16 && box.y + box.height <= 650);
        assert.deepEqual(box, await page.locator('.terminal-host').boundingBox(), 'text overlays the exact terminal rectangle');
        const geometry = await textContent.evaluate(node => ({font:[getComputedStyle(node).fontFamily, getComputedStyle(node).fontSize, getComputedStyle(node).lineHeight], width:node.clientWidth, scrollWidth:node.scrollWidth}));
        assert.deepEqual(geometry.font, await page.locator('.xterm-rows').evaluate(node => [getComputedStyle(node).fontFamily, getComputedStyle(node).fontSize, getComputedStyle(node).lineHeight]));
        assert.equal(geometry.scrollWidth, geometry.width, 'wrapped text never needs horizontal scrolling');
        for (const key of ['Control+a', 'Meta+a', 'Control+a']) {
            await textContent.click({position:{x:40,y:30}});
            await page.keyboard.press(key);
            assert.deepEqual(await textContent.evaluate(node => [node.selectionStart, node.selectionEnd, document.activeElement === node]), [0, (await textContent.inputValue()).length, true]);
            await page.keyboard.press('Control+c');
            assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await textContent.inputValue(), 'copy contains the field only after repeated click/select-all');
        }
        await page.screenshot({path:`test-results/terminal-text-${width}-${theme}.png`});
        await page.keyboard.press('Escape');
    }
    await toggle.click();
    await drawer.waitFor({state:'hidden'});
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    await page.evaluate(()=>view.dispose());
} finally {
    await context.close();
    const cleanup = await browser.newContext({ignoreHTTPSErrors:true});
    await cleanup.request.post(base+'/api/login',{data:{username:user,password},headers:{'X-Tuxee-Client':'web'}});
    const me=await (await cleanup.request.get(base+'/api/me')).json();
    for(const id of terminals) await cleanup.request.delete(base+'/api/terminals/'+id,{headers:{'X-Tuxee-CSRF':me.csrf,'X-Tuxee-Client':'web'}});
    await browser.close();
}
