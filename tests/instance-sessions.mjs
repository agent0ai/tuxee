import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const containers = (process.env.TUXEE_TEST_CONTAINERS || '').split(',');
const bases = (process.env.TUXEE_TEST_URLS || '').split(',');
assert.equal(containers.length, 2, 'provide two isolated test containers');
assert.equal(bases.length, 2, 'provide their two forwarded URLs');
assert.equal(new URL(bases[0]).hostname, new URL(bases[1]).hostname);
assert.notEqual(new URL(bases[0]).port, new URL(bases[1]).port);
const user = process.env.TUXEE_TEST_USER || 'tuxee-poc-instances';
const run = (index, command, args = [], input) => {
    const result = spawnSync('docker', ['exec', '-i', containers[index], command, ...args], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} failed in test container ${index}`);
    return result.stdout.trim();
};
const ids = [], passwords = [];
for (let i = 0; i < 2; i++) {
    assert.equal(run(i, 'getent', ['passwd', user]).split(':')[4], 'Tuxee prototype test', 'refusing unrelated account');
    passwords[i] = randomBytes(24).toString('base64url');
    run(i, 'chpasswd', [], `${user}:${passwords[i]}\n`);
    ids[i] = run(i, 'cat', ['/var/lib/tuxee/instance-id']);
    assert.match(ids[i], /^[0-9a-f]{32}$/);
}
assert.notEqual(ids[0], ids[1]);
const names = ids.map(id => `tuxee_session_${id}`);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
const pages = [], terminals = [], errors = [];
const cookie = async index => (await context.cookies()).find(cookie => cookie.name === names[index]);
const me = async index => {
    const response = await context.request.get(bases[index] + '/api/me');
    assert.equal(response.status(), 200, `instance ${index} lost its login`);
    return response.json();
};
const login = async (index, restarted = false) => {
    const page = pages[index];
    await page.locator('[name=username]').fill(user);
    await page.locator('[name=password]').fill(passwords[index]);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    if (restarted) await page.getByRole('button', { name: 'Restart terminal', exact: true }).first().click();
    await page.locator('.terminal-view[data-state=connected]').first().waitFor();
    const saved = await cookie(index);
    assert.ok(saved && saved.httpOnly && saved.sameSite === 'Strict' && saved.secure === bases[index].startsWith('https:'));
};
const checkTerminal = async index => {
    await pages[index].reload();
    await pages[index].locator('.terminal-view[data-state=connected]').first().waitFor();
    const response = await context.request.get(bases[index] + '/api/terminals/' + terminals[index].id);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).pid, terminals[index].pid, `instance ${index} lost its retained shell`);
    await pages[index].locator('.terminal-view[data-state=connected] .xterm-helper-textarea').first().focus();
    await pages[index].keyboard.type(`printf 'INSTANCE_%s\\n' ${index}`);
    await pages[index].keyboard.press('Enter');
    await pages[index].locator('.xterm-rows').filter({ hasText: `INSTANCE_${index}` }).first().waitFor();
};
try {
    await context.addCookies([{ name: 'tuxee_session', value: 'unrelated-legacy-cookie', url: bases[0] }]);
    for (let i = 0; i < 2; i++) {
        const page = await context.newPage(); pages.push(page);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(bases[i]); await login(i);
        const id = await page.locator('.terminal-view[data-state=connected]').first().getAttribute('data-terminal');
        terminals[i] = await (await context.request.get(bases[i] + '/api/terminals/' + id)).json();
    }
    const secondCookie = (await cookie(1)).value, secondCSRF = (await me(1)).csrf;
    for (let i = 0; i < 2; i++) { await me(i); await checkTerminal(i); }
    console.log('PASS two localhost instances keep simultaneous browser logins and retained terminals');

    assert.equal(await pages[0].evaluate(async ({ username, password }) => (await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tuxee-Client': 'web' }, body: JSON.stringify({ username, password }),
    })).status, { username: user, password: passwords[0] }), 200);
    assert.ok((await cookie(1)).value === secondCookie && (await me(1)).csrf === secondCSRF, 're-login changed another instance session');
    await checkTerminal(0); await checkTerminal(1);
    await pages[0].getByRole('button', { name: 'User menu', exact: true }).click();
    await pages[0].getByRole('menuitem', { name: 'Log out', exact: true }).click();
    await pages[0].locator('[name=username]').waitFor();
    assert.ok(!await cookie(0), 'logout left its session cookie');
    assert.ok((await cookie(1)).value === secondCookie);
    assert.ok((await context.cookies()).some(cookie => cookie.name === 'tuxee_session'), 'logout cleared the legacy cookie');
    await checkTerminal(1); await login(0); await checkTerminal(0);
    console.log('PASS re-login and logout affect only their instance; the other browser session and shell survive');

    run(0, 'tuxee', ['restart']);
    await pages[0].locator('[name=username]').waitFor({ timeout: 30000 });
    assert.equal(run(0, 'cat', ['/var/lib/tuxee/instance-id']), ids[0]);
    assert.ok((await cookie(1)).value === secondCookie && (await me(1)).csrf === secondCSRF);
    await checkTerminal(1); await login(0, true);
    assert.equal((await context.cookies()).filter(cookie => cookie.name.startsWith('tuxee_session_')).length, 2);
    await mkdir('test-results', { recursive: true });
    for (let i = 0; i < 2; i++) await pages[i].screenshot({ path: `test-results/instance-session-${i}.png` });
    assert.deepEqual(errors, []);
    console.log('PASS restart preserves the instance ID and cookie name while the other instance stays logged in');
} finally {
    await browser.close();
}
