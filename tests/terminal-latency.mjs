import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed`);
    return result.stdout.trim();
};
const dir = await mkdtemp('/tmp/tuxee-terminal-latency-');
const user = `tuxee-lag-${process.pid}`, password = randomBytes(24).toString('base64url');
let added = false, service, stopped, browser;
const timers = new Set(), results = [];
try {
    await chmod(dir, 0o755);
    run('useradd', ['-M', '-d', `${dir}/home`, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]); added = true;
    const fields = run('getent', ['passwd', user]).split(':');
    await mkdir(`${dir}/home`); await chown(`${dir}/home`, Number(fields[2]), Number(fields[3]));
    run('chpasswd', [], `${user}:${password}\n`);
    await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', `${dir}/tuxee`);
    await chmod(`${dir}/tuxee`, 0o755);
    const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn(`${dir}/tuxee`, ['serve', '--http', '--bind', '127.0.0.1:0', '--state', `${dir}/state`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    service.stderr.resume();
    const base = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('server startup timed out')), 10000);
        service.stdout.on('data', data => {
            const match = String(data).match(/listening at (http:\/\/\S+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
        service.once('exit', () => { clearTimeout(timeout); reject(Error('server stopped')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    const context = await browser.newContext({ bypassCSP: true });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const account = await context.request.get(base + '/api/me');
    assert.equal(account.status(), 200, await account.text());
    const me = await account.json();
    const response = await context.request.post(base + '/api/terminals', { data: { name: 'Latency', columns: 80, rows: 24 }, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    assert.equal(response.status(), 201, await response.text());
    const info = await response.json();
    const bundle = await build({ stdin: { contents: `
        import { TerminalView } from './web/term';
        import { setCSRF } from './web/ui';
        window.mount = (me, id) => {
            setCSRF(me.csrf);
            window.view = new TerminalView(document.querySelector('#terminal'), {id:'test',kind:'terminal',terminal:id}, {user:me.user, defaultDirectory:()=>me.user.home, changed(){}});
        };
    `, resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', write: false });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let delay = 0, connections = 0;
    const forward = (socket, message) => {
        if (!delay) { socket.send(message); return; }
        const timer = setTimeout(() => { timers.delete(timer); socket.send(message); }, delay);
        timers.add(timer);
    };
    // Delay both directions independently; preserve WebSocket ordering, with no per-message serialization delay.
    await page.routeWebSocket('**/api/terminals/*/ws', socket => {
        connections++;
        const server = socket.connectToServer();
        socket.onMessage(message => forward(server, message));
        server.onMessage(message => forward(socket, message));
    });
    await page.goto(base + '/health');
    await page.setContent('<div class="panel"><header class="panel-header"><svg></svg><span class="panel-title">Terminal</span><div class="panel-tools"></div></header><main id="terminal" style="height:400px;width:800px"></main></div>');
    await page.addStyleTag({ content: await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8') });
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => typeof mount === 'function');
    await page.evaluate(({me, id}) => mount(me, id), { me, id: info.id });
    await page.waitForFunction(() => view.ready && !view.resizing);
    await page.evaluate(() => {
        window.line = () => { const b = view.term.buffer.active; return b.getLine(b.baseY + b.cursorY)?.translateToString(true).trimEnd(); };
        view.term.input("PS1='L> '; PROMPT_COMMAND=; clear\r");
    });
    await page.waitForFunction(() => line() === 'L>');
    await page.evaluate(() => {
        window.measurement = null;
        view.term.textarea.addEventListener('keydown', event => {
            if (measurement && (event.key === 'a' || event.key === 'Backspace')) measurement.keys.push(performance.now());
        }, true);
        view.term.onRender(() => {
            if (!measurement || !/^L> ?a*$/.test(line())) return;
            const count = (line().match(/a/g) || []).length;
            const completed = measurement.deleting ? 24 - count : count;
            while (measurement.draws.length < completed) measurement.draws.push(performance.now());
        });
        view.term.focus();
    });
    for (const roundTripMS of [0, 100, 200, 400]) {
        await page.waitForFunction(() => view.pendingBytes === 0 && !view.resizing);
        await page.waitForTimeout(delay * 2 + 50);
        delay = roundTripMS / 2;
        for (const deleting of [false, true]) {
            await page.evaluate(deleting => { window.measurement = { deleting, keys: [], draws: [] }; }, deleting);
            if (deleting) {
                for (let i = 0; i < 24; i++) { await page.keyboard.down('Backspace'); await page.waitForTimeout(30); }
                await page.keyboard.up('Backspace');
            } else await page.keyboard.type('a'.repeat(24), { delay: 30 });
            const released = await page.evaluate(() => performance.now());
            await page.waitForFunction(() => measurement.draws.length === 24, null, { timeout: 20000 });
            const result = await page.evaluate(({ released, roundTripMS }) => {
                const {keys, draws, deleting} = measurement;
                const latency = draws.map((draw, i) => draw - keys[i]).sort((a, b) => a - b);
                return { roundTripMS, action: deleting ? 'held Backspace' : 'typing', keyCount: keys.length,
                    medianEchoMS: Math.round(latency[12]), finalEchoMS: Math.round(draws.at(-1) - keys.at(-1)),
                    afterReleaseMS: Math.round(Math.max(0, draws.at(-1) - released)), line: line() };
            }, { released, roundTripMS });
            assert.equal(result.keyCount, 24);
            assert.equal(result.line, deleting ? 'L>' : 'L> ' + 'a'.repeat(24));
            delete result.line;
            results.push(result); console.log(JSON.stringify(result));
        }
    }
    assert.equal(connections, 1, 'input must not trigger recovery');
    assert.deepEqual(errors, []);
    await mkdir('test-results', { recursive: true });
    await writeFile(process.argv[2] || 'test-results/terminal-latency.json', JSON.stringify(results, null, 2) + '\n');
    if (!process.env.TUXEE_LATENCY_BASELINE) for (const result of results) {
        assert.ok(result.finalEchoMS < result.roundTripMS + 250, `input accumulated beyond network delay: ${JSON.stringify(result)}`);
    }
} finally {
    for (const timer of timers) clearTimeout(timer);
    await browser?.close();
    if (service && service.exitCode === null) {
        service.kill('SIGTERM');
        const timeout = setTimeout(() => service.kill('SIGKILL'), 10000);
        await stopped; clearTimeout(timeout);
    }
    if (added) run('userdel', [user]);
    await rm(dir, { recursive: true, force: true });
}
