import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, chown, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { appPage } from './app-page.mjs';

const dir = await mkdtemp('/tmp/tuxee-microphone-test-'), user = `tuxee-mic-${process.pid}`, password = randomBytes(24).toString('base64url');
const run = (command, args, input) => { const result = spawnSync(command, args, { input, encoding: 'utf8' }); assert.equal(result.status, 0, command); return result.stdout.trim(); };
let page, service, browser, account = false, api, terminal, stopped;
try {
    await chmod(dir, 0o755);
    run('useradd', ['-M', '-d', `${dir}/home`, '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]); account = true;
    const fields = run('getent', ['passwd', user]).split(':'), uid = +fields[2], gid = +fields[3];
    await mkdir(`${dir}/home`); await chown(`${dir}/home`, uid, gid);
    run('chpasswd', [], `${user}:${password}\n`);
    const wav = Buffer.alloc(44 + 48000 * 2 * 4);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < (wav.length - 44) / 2; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 8192), 44 + i * 2);
    await writeFile(`${dir}/tone.wav`, wav);
    const env = { ...process.env }; delete env.TUXEE_HTTP_PORT; delete env.TUXEE_HTTPS_PORT;
    service = spawn('./bin/tuxee', ['serve', '--bind', '127.0.0.1:0', '--acme', 'off', '--state', `${dir}/state`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => service.once('exit', resolve));
    service.stderr.on('data', data => { if (process.env.TUXEE_TEST_DEBUG) process.stderr.write(data); });
    const base = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('server startup timeout')), 15000);
        service.stdout.on('data', data => { const match = String(data).match(/listening at (https:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
        service.once('exit', () => { clearTimeout(timeout); reject(Error('server exited')); });
    });
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--ignore-certificate-errors', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${dir}/tone.wav`] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
        window.micStreams = [];
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => { const stream = await capture(options); micStreams.push(stream); return stream; };
    });
    assert.equal((await context.request.post(base + '/api/login', { data: { username: user, password }, headers: { 'X-Tuxee-Client': 'web' } })).status(), 200);
    const me = await (await context.request.get(base + '/api/me')).json();
    api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': me.csrf, 'X-Tuxee-Client': 'web' } });
    const record = source => `tuxee-pacat --record --raw --format=s16le --rate=48000 --channels=1 --latency-msec=20 --device=${source}`;
    const response = await api('/terminals', 'POST', { name: 'Microphone test', directory: `${dir}/home`, columns: 80, rows: 24, command: `${record('tuxee-microphone')} > '${dir}/home/microphone.raw' & ${record('tuxee.monitor')} > '${dir}/home/speaker.raw' & wait` });
    assert.equal(response.status(), 201); terminal = await response.json();
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', howToSeen: true, current: 'microphone-test', workspaces: [{ id: 'microphone-test', name: 'Microphone test', columns: 4, rows: 2, active: 'microphone-panel', panels: [{ id: 'microphone-panel', kind: 'terminal', terminal: terminal.id, path: `${dir}/home`, x: 0, y: 0, w: 4, h: 2 }] }] })).status(), 200);
    page = await appPage(context); const errors = [], sockets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => { if (socket.url().endsWith('/api/microphone')) sockets.push(socket); });
    await page.goto(base); await page.locator('.terminal-view[data-state=connected]').waitFor();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/microphone-initial.png' });
    assert.equal(await page.locator('.topbar .volume-toggle').count(), 1);
    assert.equal(await page.locator('.topbar .microphone-toggle').count(), 0);
    assert.equal(await page.locator('.brand-button img').count(), 1, 'Start uses the Tuxee logo');
    await page.locator('.brand-button').click();
    assert.equal(await page.locator('.start-user').textContent(), user);
    await page.keyboard.press('Escape');
    assert.equal(sockets.length, 0); assert.equal(await page.evaluate(() => micStreams.length), 0, 'no unsolicited microphone permission');
    const micMenu = async () => { if (!await page.getByRole('slider', { name: 'Microphone', exact: true }).isVisible()) await page.locator('.volume-toggle').click(); };
    const level = async value => { await micMenu(); await page.getByRole('slider', { name: 'Microphone', exact: true }).fill(String(value)); };
    const waitFor = async (check, label) => { for (let i = 0; i < 200; i++) { if (await check()) return; await page.waitForTimeout(50); } throw Error(label); };
    const rms = async file => { const data = await readFile(`${dir}/home/${file}.raw`).catch(() => Buffer.alloc(0)); const tail = data.subarray(Math.max(0, data.length - 9600)); let sum = 0; for (let i = 0; i + 1 < tail.length; i += 2) sum += (tail.readInt16LE(i) / 32768) ** 2; return Math.sqrt(sum / Math.max(1, tail.length / 2)); };
    await micMenu();
    assert.equal(await page.getByRole('slider').count(), 2);
    assert.equal(await page.evaluate(() => micStreams.length), 0, 'opening the mixer must not request microphone permission');
    await level(100);
    await waitFor(async () => await rms('microphone') > .05, 'browser microphone did not reach Linux recorder');
    await page.waitForTimeout(1000); const full = await rms('microphone');
    assert.equal(await rms('speaker'), 0, 'microphone must not leak into speaker stream');
    await level(50); await page.waitForTimeout(500);
    const half = await rms('microphone'); assert.ok(Math.abs(half / full - .5) < .12, `microphone gain: ${full} -> ${half}`);
    await page.keyboard.press('Escape'); await page.locator('.volume-toggle').click();
    await page.getByRole('button', { name: 'Mute audio', exact: true }).click(); await page.keyboard.press('Escape');
    assert.ok((await page.locator('.volume-toggle').getAttribute('title')).includes('Microphone: 50%'));
    assert.equal(await page.locator('.volume-toggle.active').count(), 1, 'active microphone remains visible with mixer closed');
    await waitFor(async () => await rms('microphone') > .02, 'speaker mute stopped microphone');
    const other = await appPage(context); await other.goto(base); await other.locator('.volume-toggle').click();
    await other.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await other.getByText('Microphone is in use by another browser.', { exact: true }).waitFor();
    await other.waitForFunction(() => micStreams.length && micStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert.ok((await page.locator('.volume-toggle').getAttribute('title')).includes('Microphone: 50%'));
    assert.equal(await page.locator('.volume-toggle.active').count(), 1); await other.close();
    await level(0);
    await page.waitForFunction(() => micStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    await page.waitForTimeout(350); assert.equal(await rms('microphone'), 0, 'mute must leave only silence for recording apps');
    for (const invalid of ['text', 'oversized', 'flood']) {
        const result = await page.evaluate(invalid => new Promise((resolve, reject) => {
            const socket = new WebSocket(new URL('api/microphone', location.href).href.replace(/^http/, 'ws'));
            const timeout = setTimeout(() => { socket.close(); reject(Error('invalid microphone input stayed connected')); }, 5000);
            let ready = false, errors = [];
            socket.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.ready) {
                    ready = true;
                    if (invalid === 'text') socket.send('invalid');
                    else if (invalid === 'oversized') socket.send(new Uint8Array(1921));
                    else for (let i = 0; i < 50; i++) socket.send(new Uint8Array(1920));
                } else errors.push(message.text?.key);
            };
            socket.onclose = () => { clearTimeout(timeout); resolve({ ready, errors }); };
        }), invalid);
        assert.equal(result.ready, true, 'rejected input must release microphone ownership');
        if (invalid === 'text') assert.ok(result.errors.includes('audio.invalidData'), JSON.stringify({ invalid, result }));
    }
    await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await waitFor(async () => await rms('microphone') > .02, 'unmute did not restore capture');
    assert.equal(await page.getByRole('slider', { name: 'Microphone', exact: true }).inputValue(), '50');
    for (const width of [1280, 390, 320]) {
        await page.keyboard.press('Escape'); await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(300); await micMenu();
        for (const direction of ['ltr', 'rtl']) {
            await page.evaluate(direction => { document.documentElement.dir = direction; }, direction);
            const box = await page.getByRole('dialog', { name: 'Audio', exact: true }).boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width, 'mixer must fit the viewport');
            const speaker = await page.getByRole('slider', { name: 'Audio volume', exact: true }).boundingBox();
            const mic = await page.getByRole('slider', { name: 'Microphone', exact: true }).boundingBox();
            assert.ok(Math.abs(speaker.y - mic.y) < 1 && Math.abs(speaker.height - mic.height) < 1, 'sliders share a row');
            assert.ok(direction === 'ltr' ? speaker.x + speaker.width < mic.x : mic.x + mic.width < speaker.x, 'channels follow reading direction without overlap');
            assert.equal(await page.locator('.brand-button img').count(), 1);
            assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'header stays within viewport');
        }
        await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.volume-toggle').evaluate(node => node === document.activeElement), true);
        await page.locator('.theme-toggle').click(); await micMenu();
        assert.equal(await page.getByRole('slider', { name: 'Microphone', exact: true }).inputValue(), '50', 'header rebuild preserves microphone');
        assert.equal(await page.getByRole('slider', { name: 'Audio volume', exact: true }).inputValue(), '0', 'header rebuild preserves speaker mute');
        const micSlider = page.getByRole('slider', { name: 'Microphone', exact: true });
        await micSlider.focus(); await page.keyboard.press('ArrowUp'); assert.equal(await micSlider.inputValue(), '51');
        await page.keyboard.press('ArrowDown'); assert.equal(await micSlider.inputValue(), '50');
        await page.screenshot({ path: `test-results/audio-mixer-${width}.png` });
    }
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/microphone-mobile.png' });
    await page.reload(); await page.locator('.volume-toggle').waitFor();
    assert.ok((await page.locator('.volume-toggle').getAttribute('title')).includes('Microphone: 0%'));
    assert.equal(await page.locator('.volume-toggle.active').count(), 0);
    assert.equal(await page.evaluate(() => micStreams.length), 0, 'reload must require explicit unmute');
    // Permission denial and a permission result arriving after mute must both release capture.
    await page.evaluate(() => { window.realCapture = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
    await level(50); await page.getByText('Permission denied', { exact: true }).waitFor();
    assert.ok((await page.locator('.volume-toggle').getAttribute('title')).includes('Microphone: 0%'));
    assert.equal(await page.locator('.volume-toggle.active').count(), 0);
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async options => { const stream = await realCapture(options); await new Promise(resolve => { window.releasePermission = resolve; }); return stream; }; });
    await level(50); await page.waitForFunction(() => typeof releasePermission === 'function'); await level(0);
    await page.evaluate(() => releasePermission());
    await page.waitForFunction(() => micStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = realCapture; });
    await level(100); await waitFor(async () => await rms('microphone') > .05, 'capture did not restart');
    await page.evaluate(() => { const end = performance.now() + 400; while (performance.now() < end) {} });
    await page.getByText('Microphone stopped. Unmute to retry.', { exact: true }).waitFor();
    await page.waitForFunction(() => micStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    await level(100); await waitFor(async () => await rms('microphone') > .05, 'retry after stall failed');
    assert.equal((await api('/logout', 'POST')).status(), 200);
    await page.waitForFunction(() => micStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert.deepEqual(errors, []);
    console.log('PASS real browser microphone to Linux app, gain/mute, speaker isolation, exclusive ownership, compact UI, permission races, stalls, reload and logout');
} catch (error) {
    if (page) {
        console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-1500), streams: window.micStreams?.map(stream => stream.getTracks().map(track => ({ state: track.readyState, settings: track.getSettings() }))) })).catch(() => ({})));
        await page.screenshot({ path: 'test-results/microphone-failure.png' }).catch(() => {});
    }
    throw error;
} finally {
    await browser?.close();
    if (account) spawnSync('pkill', ['-KILL', '-u', user]);
    if (service && service.exitCode === null) { service.kill('SIGTERM'); const timer = setTimeout(() => service.kill('SIGKILL'), 10000); await stopped; clearTimeout(timer); }
    if (account) run('userdel', [user]);
    await rm(dir, { recursive: true, force: true });
}
