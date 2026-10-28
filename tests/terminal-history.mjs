import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// This suite deliberately kills/restarts its disposable Docker runtime.
const container = process.env.TUXEE_TEST_CONTAINER, base = process.env.TUXEE_TEST_URL;
assert.ok(container && base, 'provide a disposable TUXEE_TEST_CONTAINER and its forwarded TUXEE_TEST_URL');
const docker = (...args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
};
const run = (command, ...args) => docker('exec', container, command, ...args);
const users = [`tuxee-history-${process.pid}-a`, `tuxee-history-${process.pid}-b`];
const passwords = users.map(() => randomBytes(24).toString('base64url'));
const home = user => `/home/${user}`;
const folder = (user, id) => `${home(user)}/.local/state/tuxee/terminals/${id}`;
const exists = path => spawnSync('docker', ['exec', container, 'test', '-e', path]).status === 0;
const saved = (user, id) => JSON.parse(run('cat', `${folder(user, id)}/input-history.json`));
const eventually = async (check, label) => {
    for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(label);
};
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const contexts = [], errors = [];
try {
    for (let i = 0; i < users.length; i++) {
        run('useradd', '-m', '-s', '/bin/bash', '-c', 'Tuxee prototype test', users[i]);
        const result = spawnSync('docker', ['exec', '-i', container, 'chpasswd'], { input: `${users[i]}:${passwords[i]}\n`, encoding: 'utf8' });
        assert.equal(result.status, 0);
    }
    const login = async (context, index) => {
        await eventually(async () => {
            try { return (await context.request.get(base + '/health', { timeout: 1000 })).ok(); } catch { return false; }
        }, 'runtime failed to become ready');
        const response = await context.request.post(base + '/api/login', { data: { username: users[index], password: passwords[index] }, headers: { 'X-Tuxee-Client': 'web' } });
        assert.equal(response.status(), 200, await response.text());
        return (await response.json()).csrf;
    };
    const client = async index => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
        let csrf = await login(context, index);
        return {
            context, relogin: async () => { csrf = await login(context, index); },
            api: (path, method = 'GET', data, headers = {}) => context.request.fetch(base + '/api' + path, {
                method, data, headers: { 'X-Tuxee-Client': 'web', 'X-Tuxee-CSRF': csrf, ...headers }
            })
        };
    };
    const a = await client(0), b = await client(1);
    const create = async (client, name = 'History') => {
        const response = await client.api('/terminals', 'POST', { name, columns: 80, rows: 24 });
        assert.equal(response.status(), 201, await response.text()); return response.json();
    };
    const history = async (client, id, text) => {
        const response = await client.api(`/terminals/${id}/input-history`, text === undefined ? 'GET' : 'POST', text === undefined ? undefined : { text });
        assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const terminal = await create(a), neighbour = await create(a), otherUser = await create(b);
    assert.ok(exists(`${folder(users[0], terminal.id)}/meta.json`), 'creation prepares terminal folder');
    assert.ok(!exists(`${home(users[0])}/.config/tuxee/terminals`), 'history must not create configuration directories');
    const uid = run('id', '-u', users[0]);
    assert.equal(run('stat', '-c', '%u:%a', folder(users[0], terminal.id)), `${uid}:700`);
    const settings = { theme: 'dark', current: 'history', workspaces: [{ id: 'history', name: 'History', columns: 4, rows: 2, active: 'terminal', panels: [
        { id: 'terminal', kind: 'terminal', terminal: terminal.id, path: home(users[0]), x: 0, y: 0, w: 4, h: 2 }
    ] }] };
    assert.equal((await a.api('/settings', 'PUT', settings)).status(), 200);
    const page = await a.context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const connected = async page => page.locator('.terminal-view[data-state=connected]').waitFor();
    await page.goto(base); await connected(page);
    const drawer = page.locator('.terminal-input');
    const toggle = page.getByRole('button', { name: 'Toggle terminal input', exact: true });
    const previous = page.getByRole('button', { name: 'Previous input', exact: true });
    const submit = async (page, text, key = 'Enter') => {
        const drawer = page.locator('.terminal-input');
        await drawer.fill(text);
        const save = page.waitForResponse(response => response.url().endsWith('/input-history') && response.request().method() === 'POST');
        await drawer.press(key);
        assert.equal((await save).status(), 200);
    };
    await toggle.click();
    assert.equal(await previous.isDisabled(), true);
    const first = ": 'first 日本語 🦊\nsecond line'";
    await submit(page, first);
    await submit(page, ": 'inserted'", 'Control+Enter');
    await page.locator('.xterm-helper-textarea').press('Enter');
    assert.deepEqual(saved(users[0], terminal.id), [first, ": 'inserted'"]);
    assert.equal(run('stat', '-c', '%u:%a', `${folder(users[0], terminal.id)}/input-history.json`), `${uid}:600`);
    await page.reload(); await connected(page); await toggle.click(); await previous.click();
    assert.equal(await drawer.inputValue(), ": 'inserted'", 'reload restores history');
    await previous.click(); assert.equal(await drawer.inputValue(), first, 'multiline Unicode preserved');
    assert.deepEqual(await history(a, neighbour.id), [], 'terminal histories are isolated');
    assert.deepEqual(await history(b, otherUser.id), [], 'account histories are isolated');
    assert.equal((await b.api(`/terminals/${terminal.id}/input-history`)).status(), 404);
    assert.equal((await b.api(`/terminals/${terminal.id}/input-history`, 'POST', { text: 'wrong user' })).status(), 404);
    assert.equal((await a.api(`/terminals/${terminal.id}/input-history`, 'POST', { text: 'no csrf' }, { 'X-Tuxee-CSRF': '' })).status(), 403);
    assert.equal((await a.api(`/terminals/${terminal.id}/input-history`, 'POST', { text: 'x'.repeat(65537) })).status(), 400);
    assert.equal(run('su', '-s', '/bin/sh', users[1], '-c', `test ! -r '${folder(users[0], terminal.id)}/input-history.json' && printf isolated`), 'isolated');
    console.log('PASS private files, multiline/Unicode reload, terminal/account isolation, CSRF and entry-size bounds');

    const second = await client(0), phone = await second.context.newPage();
    await phone.goto(base); await phone.locator('.terminal-view[data-state=viewing]').waitFor();
    await phone.locator('[data-action=take-control]').click();
    await connected(phone);
    await phone.setViewportSize({ width: 390, height: 800 });
    await phone.getByRole('button', { name: 'Toggle terminal input', exact: true }).click();
    await phone.getByRole('button', { name: 'Previous input', exact: true }).click();
    assert.equal(await phone.locator('.terminal-input').inputValue(), ": 'inserted'");
    await submit(phone, ": 'phone'");
    await phone.close();
    await page.reload(); await connected(page); await toggle.click();
    await previous.click(); assert.equal(await drawer.inputValue(), ": 'phone'");
    assert.deepEqual(await history(a, terminal.id, ''), [first, ": 'inserted'", ": 'phone'"]);
    await Promise.all(Array.from({ length: 12 }, (_, i) => history(i % 2 ? second : a, terminal.id, `concurrent ${i}`)));
    const concurrent = await history(a, terminal.id);
    assert.equal(concurrent.length, 15); assert.equal(new Set(concurrent).size, 15, 'concurrent appends lost entries');
    for (let i = 0; i < 52; i++) await history(a, terminal.id, `bounded ${i}`);
    await history(a, terminal.id, 'bounded 51');
    assert.deepEqual(saved(users[0], terminal.id), Array.from({ length: 50 }, (_, i) => `bounded ${i + 2}`));
    let releaseSave, startedSave;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise(resolve => { startedSave = resolve; });
    await page.route('**/input-history', async route => {
        if (route.request().method() === 'POST') { startedSave(); await heldSave; }
        await route.continue();
    });
    await drawer.fill(": 'before logout'"); await drawer.press('Enter'); await saveStarted;
    await page.getByRole('button', { name: 'User menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[name=username]').count(), 0, 'logout abandoned the pending history save');
    releaseSave();
    await page.locator('[name=username]').waitFor();
    await page.close();
    await a.relogin();
    assert.equal((await history(a, terminal.id)).at(-1), ": 'before logout'", 'logout must flush live history');
    console.log('PASS file ownership, Unicode, reload, another device, logout, account/terminal isolation, CSRF, bounds and concurrent appends');

    const resetPage = await a.context.newPage(); await resetPage.goto(base); await connected(resetPage);
    await resetPage.getByRole('button', { name: 'Toggle terminal input', exact: true }).click();
    await resetPage.locator('.terminal-input').fill('unsent draft');
    await resetPage.getByRole('button', { name: 'Reset terminal', exact: true }).click();
    await resetPage.getByRole('button', { name: 'Kill and reset', exact: true }).click();
    await eventually(async () => (await resetPage.locator('.terminal-view').getAttribute('data-terminal')) !== terminal.id, 'reset did not replace terminal');
    await connected(resetPage);
    const replacement = await resetPage.locator('.terminal-view').getAttribute('data-terminal');
    assert.equal(await resetPage.locator('.terminal-input').inputValue(), 'unsent draft');
    assert.equal(await resetPage.getByRole('button', { name: 'Previous input', exact: true }).isDisabled(), true);
    assert.deepEqual(await history(a, replacement), []);
    assert.equal(JSON.parse(run('cat', `${folder(users[0], terminal.id)}/meta.json`)).state, 'closed');
    await resetPage.close();
    assert.equal((await a.api(`/terminals/${neighbour.id}`, 'DELETE')).status(), 200);
    assert.equal(JSON.parse(run('cat', `${folder(users[0], neighbour.id)}/meta.json`)).state, 'closed');
    const killed = await create(a);
    await history(a, killed.id, 'before kill');
    run('kill', '-KILL', '--', `-${killed.pid}`);
    await eventually(async () => (await (await a.api(`/terminals/${killed.id}`)).json()).exited, 'killed shell did not exit');
    assert.deepEqual(saved(users[0], killed.id), ['before kill']);
    assert.ok([400, 404].includes((await a.api(`/terminals/${killed.id}/input-history`, 'POST', { text: 'late write' })).status()));
    const afterKill = await create(a);
    assert.ok(exists(folder(users[0], killed.id)), 'lost unclosed archive: killed');
    const exited = await create(a);
    const socketPage = await a.context.newPage();
    await socketPage.goto(base + '/health');
    await socketPage.evaluate(async id => {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/terminals/${id}/ws`);
            ws.onmessage = event => {
                if (typeof event.data !== 'string') return;
                const message = JSON.parse(event.data);
                if (message.sequence) ws.send(JSON.stringify({ type: 'rendered', sequence: message.sequence }));
                if (message.type === 'snapshot') ws.send(new TextEncoder().encode('exit\r'));
                if (message.type === 'exit') { ws.close(); resolve(); }
            };
            ws.onerror = reject;
        });
    }, exited.id);
    await socketPage.close();
    await eventually(async () => (await (await a.api(`/terminals/${exited.id}`)).json()).exited, 'shell was not reaped');
    await a.relogin();
    assert.ok(exists(folder(users[0], exited.id)), 'lost unclosed archive: exited');
    assert.ok(exists(folder(users[0], replacement)), 'cleanup removed a detached live terminal');
    console.log('PASS reset preserves draft with fresh history; close retains history; SIGKILL and ordinary exit preserve unclosed archives');

    await history(a, afterKill.id, 'before server crash');
    await history(b, otherUser.id, 'other account before crash');
    const serverPID = run('pgrep', '-f', '^/usr/local/bin/tuxee serve');
    assert.match(serverPID, /^\d+$/);
    run('kill', '-KILL', serverPID);
    assert.ok(exists(folder(users[0], afterKill.id)), 'abrupt server death should leave files until activity');
    await a.relogin();
    assert.ok(exists(folder(users[0], afterKill.id)), 'lost unclosed archive: afterKill');
    assert.ok(exists(folder(users[1], otherUser.id)), 'one user login cleaned another user');
    await b.relogin();
    assert.ok(exists(folder(users[1], otherUser.id)), 'lost other account archive');
    assert.equal((await (await a.api(`/terminals/${afterKill.id}`)).json()).exited, true);

    const beforeRestart = await create(a); await history(a, beforeRestart.id, 'before container restart');
    docker('restart', container);
    await a.relogin();
    assert.ok(exists(folder(users[0], beforeRestart.id)), 'lost unclosed archive: beforeRestart');
    const beforeHardStop = await create(a); await history(a, beforeHardStop.id, 'before hard container stop');
    docker('kill', '--signal', 'KILL', container); docker('start', container);
    assert.ok(exists(folder(users[0], beforeHardStop.id)), 'hard stop unexpectedly cleaned history');
    await a.relogin();
    assert.ok(exists(folder(users[0], beforeHardStop.id)), 'lost unclosed archive: beforeHardStop');
    const fresh = await create(a); assert.deepEqual(await history(a, fresh.id), []);
    await a.api(`/terminals/${fresh.id}`, 'DELETE');
    assert.deepEqual(errors, []);
    console.log('PASS real server SIGKILL, graceful Docker restart, hard Docker restart and per-user archives');
} finally {
    await browser.close();
    for (const user of users) {
        const result = spawnSync('docker', ['exec', container, 'getent', 'passwd', user], { encoding: 'utf8' });
        if (result.stdout.trim().split(':')[4] === 'Tuxee prototype test') {
            spawnSync('docker', ['exec', container, 'pkill', '-KILL', '-u', user]);
            run('userdel', '-r', user);
        }
    }
}
