import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = { ...process.env };
for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) delete env[key];
const state = await mkdtemp('/tmp/tuxee-login-picker-');
let server, display, browser;
async function poll(check, message) {
    for (let i = 0; i < 40; i++) { if (await check()) return; await delay(50); }
    throw Error(message);
}
function xrun(command, args) {
    const result = spawnSync(command, args, { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
const popup = () => {
    for (const line of xrun('xwininfo', ['-root', '-tree']).split('\n')) {
        const match = line.match(/\(has no name\): \(\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
        if (match && +match[1] > 50 && +match[2] > 50) return { x: +match[3], y: +match[4] };
    }
};
try {
    let base = process.env.TUXEE_TEST_URL;
    if (!base) {
        await copyFile(process.env.TUXEE_TEST_BINARY || 'bin/tuxee', state + '/tuxee');
        server = spawn(state + '/tuxee', ['serve', '--http', '--bind', '127.0.0.1:0', '--state', state + '/state'], { stdio: ['ignore', 'pipe', 'ignore'] });
        base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('server startup timed out')), 10000);
            server.stdout.on('data', data => { const match = String(data).match(/listening at (http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
            server.once('exit', () => { clearTimeout(timer); reject(Error('server exited')); });
        });
    }
    display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1418x901x24', '-nolisten', 'tcp', '-ac'], { env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    env.DISPLAY = await new Promise((resolve, reject) => {
        display.stdio[3].once('data', data => resolve(':' + String(data).trim()));
        display.once('exit', () => reject(Error('Xvfb failed')));
    });
    browser = await chromium.launch({ executablePath: process.env.TUXEE_TEST_BROWSER || '/usr/bin/chromium', headless: false,
        args: ['--no-sandbox', '--window-position=0,0', '--window-size=1418,901'], env });
    const page = await browser.newPage({ viewport: null }), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); const language = page.locator('[name=language]'); await language.waitFor();
    await page.locator('[name=username]').fill('unsent username');
    await page.locator('[name=password]').fill('unsent password');
    const reset = async () => {
        await page.keyboard.press('Escape'); await language.selectOption('en');
        await page.waitForFunction(() => document.documentElement.lang === 'en' && !document.querySelector('[name=language]').disabled);
        await poll(() => !popup(), 'previous picker did not close');
    };
    const point = async (select = language) => {
        const page = select.page();
        const box = await select.boundingBox(), session = await page.context().newCDPSession(page);
        const { bounds } = await session.send('Browser.getWindowForTarget'); await session.detach();
        const height = await page.evaluate(() => document.documentElement.clientHeight);
        return { x: Math.round(bounds.left + box.x + box.width / 2), y: Math.round(bounds.top + bounds.height - height + box.y + box.height / 2) };
    };
    const press = async (select = language) => { const { x, y } = await point(select); xrun('xdotool', ['mousemove', String(x), String(y), 'mousedown', '1']); };
    for (const hold of [150, 400]) {
        await reset(); await press(); await delay(hold);
        assert.equal(popup(), undefined, 'mouse press must not open the picker');
        xrun('xdotool', ['mouseup', '1']); await poll(popup, 'release must open the picker');
        assert.equal(await language.inputValue(), 'en', 'opening release must not select an option');
        const menu = popup(); xrun('xdotool', ['mousemove', String(menu.x + 50), String(menu.y + 12), 'click', '1']);
        await page.waitForFunction(() => document.documentElement.lang === 'ar');
        await poll(() => !popup(), 'deliberate selection must close, without reopening');
        assert.equal(await page.locator('[name=username]').inputValue(), 'unsent username');
        assert.equal(await page.locator('[name=password]').inputValue(), 'unsent password');
    }
    for (const cancel of ['outside', 'Escape', 'pointercancel', 'blur']) {
        await reset(); await press();
        if (cancel === 'outside') xrun('xdotool', ['mousemove', '20', '300']);
        else if (cancel === 'Escape') await page.keyboard.press('Escape');
        else await page.evaluate(type => window.dispatchEvent(new Event(type)), cancel);
        xrun('xdotool', ['mouseup', '1']); await delay(100);
        assert.equal(popup(), undefined, `${cancel} must cancel opening`);
        assert.equal(await language.inputValue(), 'en');
    }
    await language.focus(); xrun('xdotool', ['mousemove', '20', '300', 'key', 'alt+Down']); await poll(popup, 'keyboard opens the native picker');
    xrun('xdotool', ['key', 'Home', 'Down', 'Return']);
    await page.waitForFunction(() => document.documentElement.lang === 'bg');
    assert.equal(await language.inputValue(), 'bg', 'keyboard selection still works');
    await reset();
    await page.evaluate(() => {
        const select = document.querySelector('[name=language]');
        for (const pointerType of ['touch', 'pen']) {
            const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType, button: 0 });
            if (!select.dispatchEvent(event)) throw Error(pointerType + ' input was intercepted');
        }
    });
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 740 }, hasTouch: true, isMobile: true });
    const touch = await touchContext.newPage(); touch.on('pageerror', error => errors.push(error.message));
    await touch.goto(base); await touch.locator('[name=language]').tap();
    assert.equal(await touch.locator('[name=language]').inputValue(), 'en', 'touch opening preserves selection');
    await touch.keyboard.press('Escape'); await touchContext.close();
    const bundle = await build({ stdin: { contents: `
        import { el, popover } from './web/ui';
        window.mountSelect = (kind, count = 40) => {
            const select = el('select'); select.id = 'shared-select';
            for (let n = 1; n <= count; n++) { const option = el('option', '', 'Item ' + n); option.value = String(n); select.append(option); }
            select.value = String(Math.min(count, 8)); window.changes = 0; select.onchange = () => window.changes++;
            const host = el(kind === 'dialog' ? 'dialog' : 'div'); host.append(select);
            if (kind === 'popover') window.dismissSelect = popover({ x: 100, y: 150 }, host).close;
            else { document.body.append(host); if (kind === 'dialog') host.showModal(); window.dismissSelect = () => host.remove(); }
        };
    `, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
    const fixture = await browser.newPage({ viewport: null }); fixture.on('pageerror', error => errors.push(error.message));
    await fixture.setContent('<style>select{font:16px sans-serif;width:220px}body{padding:100px}.popover-menu{position:fixed;inset:auto;margin:0;padding:8px}</style>');
    await fixture.addScriptTag({ content: bundle.outputFiles[0].text });
    const select = fixture.locator('#shared-select');
    for (const [kind, count] of [['plain', 40], ['dialog', 40], ['popover', 3]]) {
        await fixture.evaluate(([kind, count]) => window.mountSelect(kind, count), [kind, count]);
        await press(select); await delay(150);
        assert.equal(popup(), undefined, `${kind}: mouse press must not open the picker`);
        xrun('xdotool', ['mouseup', '1']); await poll(popup, `${kind}: release must open the picker`);
        assert.equal(await select.inputValue(), String(Math.min(count, 8)), `${kind}: opening release must preserve selection`);
        const menu = popup(); xrun('xdotool', ['mousemove', String(menu.x + 50), String(menu.y + 12), 'click', '1']);
        await poll(() => !popup(), `${kind}: deliberate selection must close the picker`);
        assert.equal(await select.inputValue(), '1');
        assert.equal(await fixture.evaluate(() => window.changes), 1, `${kind}: exactly one change`);
        await fixture.evaluate(() => window.dismissSelect());
    }
    for (const cancel of ['disabled', 'removed']) {
        await fixture.evaluate(() => window.mountSelect('plain')); await press(select); await delay(50);
        await select.evaluate((node, cancel) => { if (cancel === 'disabled') node.disabled = true; else node.remove(); }, cancel);
        xrun('xdotool', ['mouseup', '1']); await delay(100);
        assert.equal(popup(), undefined, `${cancel} select must not open`);
        await fixture.evaluate(() => window.dismissSelect());
    }
    await fixture.evaluate(() => {
        for (const kind of ['multiple', 'listbox', 'disabled', 'fieldset', 'touch', 'pen', 'secondary']) {
            window.mountSelect('plain'); const node = document.querySelector('#shared-select');
            if (kind === 'multiple') node.multiple = true;
            if (kind === 'listbox') node.size = 4;
            if (kind === 'disabled') node.disabled = true;
            if (kind === 'fieldset') { const field = document.createElement('fieldset'); field.disabled = true; node.before(field); field.append(node); }
            const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: ['touch', 'pen'].includes(kind) ? kind : 'mouse', button: kind === 'secondary' ? 2 : 0 });
            if (!node.dispatchEvent(event)) throw Error(kind + ' must retain native behavior');
            window.dismissSelect();
        }
    });
    await fixture.close();
    await page.bringToFront();
    await page.addInitScript(() => { Object.defineProperty(HTMLSelectElement.prototype, 'showPicker', { value: undefined, configurable: true }); });
    await page.reload(); await language.waitFor();
    assert.equal(await language.evaluate(select => select.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }))), true, 'unsupported browsers keep native opening');
    await language.focus(); await page.keyboard.press('Alt+ArrowDown'); await poll(popup, 'native fallback still opens');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log('Native selects: login and shared dynamic/plain/dialog/popover controls, mouse release/selection, cancellation, keyboard, touch, disabled/listbox guards and unsupported-API fallback passed.');
} finally {
    if (browser) await browser.close();
    for (const child of [server, display]) if (child && child.exitCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped;
    }
    await rm(state, { recursive: true, force: true });
}
