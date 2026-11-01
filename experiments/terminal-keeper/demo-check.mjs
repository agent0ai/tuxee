import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const container = 'tuxee-terminal-keeper-demo';
const base = 'http://localhost:18085';
const out = 'test-results/terminal-keeper';
const docker = (...args) => execFileSync('docker', args, {
    encoding: 'utf8', env: { ...process.env, DOCKER_HOST: 'unix:///root/.docker-dev/docker.sock' },
});
assert.equal(docker('inspect', '--format', '{{.HostConfig.NetworkMode}}', container).trim(), 'none');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
let csrf;
async function login() {
    const response = await context.request.post(base + '/api/login', {
        headers: { 'X-Tuxee-Client': 'web' }, data: { username: 'root', password: 'toor', language: 'en' },
    });
    assert.equal(response.status(), 200);
    ({ csrf } = await (await context.request.get(base + '/api/me')).json());
}
async function api(path, method, data) {
    const response = await context.request.fetch(base + '/api' + path, {
        method, data, headers: { 'X-Tuxee-CSRF': csrf, 'X-Tuxee-Client': 'web' },
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
}
async function terminal() {
    const session = await api('/terminals', 'POST', {
        name: 'Keeper demo', directory: '/root', columns: 120, rows: 35, command: 'exec keeper-demo',
    });
    await api('/settings', 'PUT', { theme: 'dark', current: 'keeper-demo', workspaces: [{
        id: 'keeper-demo', name: 'Keeper demo', columns: 4, rows: 2, active: 'keeper',
        panels: [{ id: 'keeper', kind: 'terminal', terminal: session.id, path: '/root', x: 0, y: 0, w: 4, h: 2 }],
    }] });
    await page.goto(base);
    await page.locator('.terminal-view[data-state="connected"]').waitFor();
    await page.waitForFunction(() => /shell PID \d+/.test(document.querySelector('.xterm-rows')?.textContent || ''));
    const text = await page.locator('.xterm-rows').innerText();
    const [, shell, helper, client] = text.match(/shell PID (\d+)\s*\|\s*helper PID (\d+)\s*\|\s*client PID (\d+)/);
    return { shell, helper, client };
}
async function waitHealthy() {
    for (let i = 0; i < 100; i++) {
        try { if ((await context.request.get(base + '/health', { timeout: 1000 })).ok()) return; } catch {}
        await page.waitForTimeout(100);
    }
    throw Error('Tuxee did not recover');
}
try {
    await login();
    const before = await terminal();
    await page.screenshot({ path: `${out}/demo-before.png` });
    docker('exec', container, 'python3', '-c', `
import json,pathlib,os,signal
r=json.loads(next(pathlib.Path('/run/tuxee').glob('*.json')).read_text())
fd=os.pidfd_open(r['pid'])
assert pathlib.Path('/proc/%s/stat'%r['pid']).read_text().rsplit(')',1)[1].split()[19] == r['start']
assert b'serve' in pathlib.Path('/proc/%s/cmdline'%r['pid']).read_bytes().split(b'\\0')
signal.pidfd_send_signal(fd,signal.SIGKILL)
os.close(fd)
`);
    await waitHealthy();
    await login();
    const afterCrash = await terminal();
    assert.equal(afterCrash.shell, before.shell);
    assert.equal(afterCrash.helper, before.helper);
    assert.notEqual(afterCrash.client, before.client);
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await page.keyboard.type(`printf '\\nSURVIVED: %s  Bash PID: %s\\n' "$DEMO_VALUE" "$$"`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('SURVIVED: still-alive'));
    await page.screenshot({ path: `${out}/demo-after-crash.png` });
    docker('exec', container, '/usr/local/bin/tuxee', 'restart');
    await page.waitForTimeout(1000);
    await waitHealthy();
    await login();
    const afterRestart = await terminal();
    assert.equal(afterRestart.shell, before.shell);
    assert.equal(afterRestart.helper, before.helper);
    await input.focus();
    await page.keyboard.type(`printf '\\nSURVIVED CRASH + RESTART: %s  Bash PID: %s\\n' "$DEMO_VALUE" "$$"`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('SURVIVED CRASH + RESTART: still-alive'));
    await page.screenshot({ path: `${out}/demo-ready.png` });
    const result = { before, afterCrash, afterRestart };
    await writeFile(`${out}/demo.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    await browser.close();
}
