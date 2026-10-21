import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, chown, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const user = 'tuxee-poc-audio';
let account = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
if (account.status !== 0) {
    assert.equal(spawnSync('useradd', ['-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', user]).status, 0);
    account = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
}
const fields = account.stdout.trim().split(':'), uid = Number(fields[2]), gid = Number(fields[3]);
assert.equal(fields[4], 'Tuxee prototype test');
const password = randomBytes(24).toString('base64url');
assert.equal(spawnSync('chpasswd', [], { input: `${user}:${password}\n` }).status, 0);
const state = await mkdtemp('/tmp/tuxee-audio-server-'), fixture = await mkdtemp('/tmp/tuxee-audio-fixture-');
await chown(fixture, uid, gid); await mkdir('test-results', { recursive: true });
const plain = process.env.TUXEE_AUDIO_HTTP === '1';
const service = spawn('./bin/tuxee', ['serve', '--bind', plain ? '0.0.0.0:0' : '127.0.0.1:0', ...(plain ? ['--http'] : []), '--acme', 'off', '--state', state], { stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => service.once('exit', resolve));
let logs = '';
service.stderr.on('data', data => { logs = (logs + data).slice(-24000); });
const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server startup timeout')), 10000);
    service.stdout.on('data', data => {
        const match = String(data).match(/listening at (https?:\/\/\S+)/);
        if (match) {
            clearTimeout(timer);
            const address = Object.values(networkInterfaces()).flat().find(value => value.family === 'IPv4' && !value.internal)?.address;
            resolve(plain ? match[1].replace('0.0.0.0', address || '127.0.0.1') : match[1]);
        }
    });
    service.once('exit', () => { clearTimeout(timer); reject(Error('server stopped')); });
});
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--ignore-certificate-errors', '--autoplay-policy=document-user-activation-required'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, bypassCSP: !plain, viewport: { width: 1440, height: 900 } });
const probeModule = `
class Probe extends AudioWorkletProcessor {
    constructor() { super(); this.seen = false; this.zeros = 0; this.maxZeros = 0; this.frames = 0; }
    process(inputs) {
        for (const value of inputs[0]?.[0] || []) {
            if (Math.abs(value) > .0001) { this.seen = true; this.zeros = 0; }
            else if (this.seen) this.maxZeros = Math.max(this.maxZeros, ++this.zeros);
            if (++this.frames % 48000 === 0) this.port.postMessage({ frames: this.frames, maxSilenceMs: this.maxZeros / 48 });
        }
        return true;
    }
}
registerProcessor('audio-probe', Probe);
`;
await context.addInitScript(() => {
    const connect = AudioNode.prototype.connect, start = AudioBufferSourceNode.prototype.start;
    window.audioProbe = { contexts: [], created: [], maxAhead: 0, packets: 0, resets: [], maxArrivalGap: 0 }; window.audioOriginalConnect = connect;
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
        constructor(options) { super(options); window.audioProbe.created.push(this); }
    };
    AudioNode.prototype.connect = function (destination, ...args) {
        if (destination instanceof AudioDestinationNode) {
            let probe = window.audioProbe.contexts.find(p => p.context === this.context);
            if (!probe) {
                const splitter = this.context.createChannelSplitter(2), sink = this.context.createGain(); sink.gain.value = 0;
                const analysers = [this.context.createAnalyser(), this.context.createAnalyser()];
                for (let i = 0; i < 2; i++) {
                    analysers[i].fftSize = 8192; analysers[i].smoothingTimeConstant = 0;
                    connect.call(splitter, analysers[i], i); connect.call(analysers[i], sink);
                }
                connect.call(sink, destination); probe = { context: this.context, splitter, analysers };
                window.audioProbe.contexts.push(probe);
            }
            connect.call(this, probe.splitter);
        }
        return connect.call(this, destination, ...args);
    };
    AudioBufferSourceNode.prototype.start = function (when, ...args) {
        const probe = window.audioProbe, now = performance.now();
        if (probe.lastArrival) probe.maxArrivalGap = Math.max(probe.maxArrivalGap, now - probe.lastArrival);
        if (probe.lastEnd && Math.abs(when - probe.lastEnd) > .001) probe.resets.push({ at: now, gap: when - probe.lastEnd });
        probe.lastArrival = now; probe.lastEnd = when + this.buffer.duration;
        window.audioProbe.maxAhead = Math.max(window.audioProbe.maxAhead, when - this.context.currentTime);
        window.audioProbe.packets++;
        return start.call(this, when, ...args);
    };
});
const page = await context.newPage(), errors = [], sockets = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => {
    if (socket.url().endsWith('/display/audio')) {
        const item = { closed: false, bytes: 0, frames: 0 }; sockets.push(item);
        socket.on('framereceived', frame => { item.bytes += frame.payload.length; item.frames++; });
        socket.on('close', () => item.closed = true);
    }
});
let csrf, original, terminal;
const api = (path, method = 'GET', data) => context.request.fetch(base + '/api' + path, { method, data, headers: { 'X-Tuxee-CSRF': csrf || '', 'X-Tuxee-Client': 'web' } });
async function poll(check, message, count = 150) {
    for (let i = 0; i < count; i++) { if (await check()) return; await page.waitForTimeout(100); }
    throw Error(message);
}
async function spectrum(target = page) {
    return target.evaluate(() => {
        const probe = window.audioProbe.contexts.findLast(p => p.context.state === 'running');
        if (!probe) return [];
        return probe.analysers.map(analyser => {
            const frequencies = new Float32Array(analyser.frequencyBinCount), samples = new Float32Array(analyser.fftSize);
            analyser.getFloatFrequencyData(frequencies); analyser.getFloatTimeDomainData(samples);
            let bin = 1; for (let i = 2; i < frequencies.length; i++) if (frequencies[i] > frequencies[bin]) bin = i;
            return { hz: bin * probe.context.sampleRate / analyser.fftSize, db: frequencies[bin], rms: Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) };
        });
    });
}
async function audioProcesses() {
    const result = [];
    for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const status = await readFile(`/proc/${pid}/status`, 'utf8');
            if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) continue;
            const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
            if (!/tuxee-audio\/bin\/(pulseaudio|pacat)/.test(cmd)) continue;
            result.push({ pid: Number(pid), cmd, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) });
        } catch {}
    }
    return result;
}
const results = { protocol: plain ? 'http' : 'https' };
async function soundMenu(label, contextMenu = false) {
    if (contextMenu) await page.locator('.display-window').first().click({ button: 'right' });
    else await page.getByRole('button', { name: 'Window menu', exact: true }).click();
    const item = page.getByRole('menuitem', { name: label, exact: true });
    await item.waitFor(); return item;
}
try {
    assert.equal((await api('/terminals/unknown/display/audio')).status(), 401);
    await page.goto(base);
    if (plain) assert.equal(await page.evaluate(() => isSecureContext), false, 'plain-HTTP test must use an insecure origin');
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Add terminal', exact: true }).waitFor();
    const me = await (await api('/me')).json(); csrf = me.csrf; original = me.settings;
    await page.goto('about:blank');
    terminal = await (await api('/terminals', 'POST', { directory: fields[5], name: 'Audio proof', columns: 80, rows: 24 })).json();
    assert.equal((await api('/settings', 'PUT', { theme: 'dark', current: 'audio-proof', workspaces: [{ id: 'audio-proof', name: 'Audio proof', columns: 4, rows: 2, active: 'audio-shell', panels: [{ id: 'audio-shell', kind: 'terminal', terminal: terminal.id, path: fields[5], x: 0, y: 0, w: 4, h: 2 }] }] })).status(), 200);
    await page.goto(base); const view = page.locator('.terminal-view[data-state=connected]'); await view.waitFor();
    assert.deepEqual(await audioProcesses(), [], 'ordinary terminal must not start audio');
    await writeFile(`${fixture}/tone.html`, `<!doctype html><title>Audio 440 / 880 Hz</title><body style="background:#17212a;color:white;font:32px sans-serif"><h1>Stereo audio propagation</h1><p>Left: 440 Hz · Right: 880 Hz · Source: 44.1 kHz</p><canvas width="800" height="300"></canvas><script>
const audio = new AudioContext({sampleRate:44100}), merger=audio.createChannelMerger(2); merger.connect(audio.destination);
for(const [channel,hz] of [[0,440],[1,880]]) { const tone=audio.createOscillator(),gain=audio.createGain();tone.frequency.value=hz;gain.gain.value=.25;tone.connect(gain);gain.connect(merger,0,channel);tone.start(); }
audio.resume(); const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');function draw(t){ctx.fillStyle='#17212a';ctx.fillRect(0,0,800,300);ctx.fillStyle='#ffd65a';ctx.fillRect(t/5%750,100,50,50);requestAnimationFrame(draw)}requestAnimationFrame(draw);
</script>`);
    await view.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`env -0 > '${fixture}/environment'; chromium --no-sandbox --disable-dev-shm-usage --autoplay-policy=no-user-gesture-required --user-data-dir='${fixture}/chromium' --app='file://${fixture}/tone.html' > '${fixture}/chromium.log' 2>&1 &`, { delay: 1 });
    await page.keyboard.press('Enter');
    await view.locator('.terminal-display[data-state=connected]').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.display-audio').count(), 0, 'standalone sound button must be absent');
    await poll(async () => { const value = await spectrum(); return value.length === 2 && Math.abs(value[0].hz - 440) < 10 && Math.abs(value[1].hz - 880) < 10 && value.every(v => v.rms > .1); }, 'remote Chromium stereo audio did not reach frontend playback');
    results.stereo = await spectrum(); results.processes = await audioProcesses();
    await soundMenu('Mute'); await page.keyboard.press('Escape');
    if (!plain) await page.evaluate(async module => {
        const probe = window.audioProbe.contexts.findLast(p => p.context.state === 'running');
        const url = URL.createObjectURL(new Blob([module], { type: 'text/javascript' }));
        try { await probe.context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        const observer = new AudioWorkletNode(probe.context, 'audio-probe');
        observer.port.onmessage = event => window.audioContinuity = event.data;
        probe.analysers[0].connect(observer); window.audioOriginalConnect.call(observer, probe.context.destination);
    }, probeModule);
    await page.screenshot({ path: `test-results/audio-${results.protocol}.png` });
    const before = sockets.at(-1).frames, stabilitySeconds = plain ? 10 : 60;
    results.stability = [];
    for (let i = 0; i < stabilitySeconds; i++) {
        await page.waitForTimeout(1000); const value = await spectrum();
        results.stability.push(value.map(channel => channel.rms));
        assert.ok(value.length === 2 && value.every(channel => channel.rms > .1), 'continuous playback must remain audible');
    }
    results.framesPerSecond = (sockets.at(-1).frames - before) / stabilitySeconds;
    assert.ok(results.framesPerSecond > 45 && results.framesPerSecond < 55, 'PCM stream should be paced at 50 packets/s');
    if (!plain) {
        results.continuity = await page.evaluate(() => window.audioContinuity);
        results.scheduling = await page.evaluate(() => ({ resets: window.audioProbe.resets, maxArrivalGap: window.audioProbe.maxArrivalGap }));
        assert.ok(results.continuity.frames >= 48_000 * 50);
        assert.ok(results.continuity.maxSilenceMs < 20, 'uninterrupted playback must have no audible gaps');
        await page.evaluate(() => { const end = performance.now() + 80; while (performance.now() < end) {} });
        await page.waitForTimeout(1200);
        results.shortStallContinuity = await page.evaluate(() => window.audioContinuity);
        assert.ok(results.shortStallContinuity.maxSilenceMs < 20, 'buffer must cover an 80 ms rendering stall');
    }
    await page.evaluate(() => { const end = performance.now() + 400; while (performance.now() < end) {} });
    await page.waitForTimeout(1000);
    results.afterStall = await spectrum(); assert.ok(results.afterStall.every(v => v.rms > .1), 'audio must recover after main-thread stall');
    results.maxScheduledAhead = await page.evaluate(() => window.audioProbe.maxAhead);
    assert.ok(results.maxScheduledAhead <= .201, 'playback queue must stay bounded');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compact-board').waitFor(); await page.waitForTimeout(300);
    const sound = await soundMenu('Mute');
    const soundBounds = await sound.boundingBox();
    assert.ok(soundBounds.x >= 0 && soundBounds.x + soundBounds.width <= 390, 'mobile sound control must fit');
    await page.screenshot({ path: `test-results/audio-mobile-${results.protocol}.png` });
    await sound.click();
    await poll(async () => sockets.every(s => s.closed) && !(await audioProcesses()).some(p => p.cmd.includes('/pacat')), 'mute must stop capture');
    assert.equal((await audioProcesses()).filter(p => p.cmd.includes('/pulseaudio')).length, 1, 'mute must preserve app audio server');
    await (await soundMenu('Unmute', true)).click();
    await poll(async () => (await spectrum()).length === 2 && (await spectrum()).every(v => v.rms > .1), 'unmute must resume live audio');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await (await soundMenu('Mute')).click();
    await poll(async () => !(await audioProcesses()).some(p => p.cmd.includes('/pacat')), 'mute must stop capture before the autoplay check');
    const blocked = await context.newPage(), inspector = await context.newCDPSession(blocked);
    let blockedSockets = 0;
    blocked.on('websocket', socket => { if (socket.url().endsWith('/display/audio')) blockedSockets++; });
    await blocked.goto(base);
    // Playwright DOM evaluations grant user activation; inspect this untouched page through CDP.
    const autoplayState = async () => JSON.parse((await inspector.send('Runtime.evaluate', { expression: 'JSON.stringify({activated:navigator.userActivation.hasBeenActive, states:window.audioProbe.created.map(c=>c.state)})', returnByValue: true })).result.value);
    await poll(async () => (await autoplayState()).states.length > 0, 'default audio context was not created');
    assert.deepEqual(await autoplayState(), { activated: false, states: ['suspended'] }, 'fresh page must exercise real autoplay blocking');
    assert.equal(blockedSockets, 0, 'blocked playback must not capture or stream');
    await blocked.locator('.display-controls .terminal-tab').click();
    await poll(async () => (await spectrum(blocked)).length === 2 && (await spectrum(blocked)).every(v => v.rms > .1), 'ordinary interaction must unlock default audio');
    await blocked.close();
    await poll(async () => !(await audioProcesses()).some(p => p.cmd.includes('/pacat')), 'closing a listening page must stop capture');
    await soundMenu('Unmute'); await page.keyboard.press('Escape');
    await page.reload(); await page.locator('.terminal-display[data-state=connected]').waitFor();
    await page.locator('.display-controls .terminal-tab').click();
    await poll(async () => (await spectrum()).length === 2 && (await spectrum()).every(v => v.rms > .1), 'retained GUI must resume sound after reload');
    assert.equal((await api('/logout', 'POST')).status(), 200);
    await poll(async () => !(await audioProcesses()).some(p => p.cmd.includes('/pacat')), 'logout must revoke capture');
    assert.equal((await audioProcesses()).filter(p => p.cmd.includes('/pulseaudio')).length, 1, 'logout must preserve GUI audio runtime');
    await page.goto(base);
    await page.locator('[name=username]').fill(user); await page.locator('[name=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.terminal-display[data-state=connected]').waitFor();
    csrf = (await (await api('/me')).json()).csrf;
    await poll(async () => (await spectrum()).length === 2 && (await spectrum()).every(v => v.rms > .1), 'sound must survive logout and login');
    assert.equal((await api(`/terminals/${terminal.id}`, 'DELETE')).status(), 200); terminal = undefined;
    await poll(async () => (await audioProcesses()).length === 0, 'terminal closure must clean audio processes');
    results.sockets = sockets.map(({ closed, ...rest }) => ({ ...rest, closeObserved: closed })); results.remainingAudioProcesses = await audioProcesses(); assert.deepEqual(errors, []);
    await writeFile(`test-results/audio-${results.protocol}.json`, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
} catch (error) {
    await writeFile(`test-results/audio-${results.protocol}-failure.json`, JSON.stringify(results, null, 2));
    await page.screenshot({ path: `test-results/audio-failure-${results.protocol}.png` }).catch(() => {});
    await writeFile(`test-results/audio-server-${results.protocol}.log`, logs);
    console.error(logs); console.error((await readFile(`${fixture}/chromium.log`, 'utf8').catch(() => '')).slice(-4000)); throw error;
} finally {
    if (terminal) await api(`/terminals/${terminal.id}`, 'DELETE').catch(() => {});
    if (original) await api('/settings', 'PUT', original).catch(() => {});
    await browser.close(); service.kill('SIGTERM'); await stopped;
    await rm(state, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
