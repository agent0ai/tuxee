import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const output = 'test-results/monitor-layout';
await mkdir(output, { recursive: true });
const catalog = JSON.parse(await readFile('internal/i18n/locales/en.json', 'utf8'));
const bundle = await build({ stdin: { contents: `
    import { Monitoring } from './web/monitor';
    import { setTranslations } from './web/i18n';
    setTranslations({ language: 'en', direction: 'ltr', texts: ${JSON.stringify(catalog.texts)}, languages: [], cookie: '' });
    window.Monitoring = Monitoring;
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const samples = [0, 9.9, 10, 100, 999, null];
let value = samples[0];
const preferences = { cpu: true, memory: true, swap: false, disks: ['/'], networks: ['/all'], interval: 10 };
const choices = [
    ['net-right', preferences],
    ['net-left', { ...preferences, cpu: false }],
    ['no-net', { ...preferences, networks: [] }],
    ['two-networks', { ...preferences, disks: [], networks: ['/all', 'eth0'] }],
    ['long-labels', { ...preferences, cpu: false, memory: false, disks: ['/very-long-disk-path'], networks: ['long-interface-name'] }],
    ['one', { ...preferences, memory: false, disks: [], networks: [] }],
    ['empty', { ...preferences, cpu: false, memory: false, disks: [], networks: [] }],
];
const browser = await chromium.launch({ executablePath: process.env.TUXEE_TEST_BROWSER || '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('http://monitor.test/**', route => {
    const capacity = { total: 2e12, used: value == null ? null : value * 1024 ** 2, available: 1e12, percent: 30 };
    return route.fulfill(route.request().url().endsWith('/api/metrics') ? { json: {
        cpu: { percent: value == null ? null : Math.min(value, 100), cores: 4 }, memory: capacity, swap: capacity,
        disks: ['/', '/very-long-disk-path'].map(path => ({ ...capacity, path, used: value == null ? null : value * 1e6 })),
        networks: ['/all', 'eth0', 'long-interface-name'].map(name => ({ name, receiveRate: value == null ? null : value * 1e6, sendRate: value == null ? null : value * 1e6, received: 0, sent: 0, state: 'up' })),
    } } : { contentType: 'text/html', body: '<!doctype html><div id="app" class="side-panel"><header class="topbar"><div class="workspace-controls"></div><div class="topbar-right"><div class="monitor-controls"></div></div></header></div>' });
});
try {
    await page.goto('http://monitor.test/');
    await page.addStyleTag({ path: 'web/style.css' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    let checks = 0;
    for (const font of ['sans-serif', 'DejaVu Sans', 'Noto Sans']) for (const side of ['left', 'right']) for (const [name, prefs] of choices) {
        for (const [theme, marker, zoom] of [['dark', 1, 1], ['light', 4, 1.25]]) {
            const label = `${font.replaceAll(' ', '-')}-${side}-${name}-${theme}`;
            await page.evaluate(({ font, side, theme, marker, zoom, prefs }) => {
                window.monitor?.dispose();
                document.documentElement.style.fontFamily = font;
                document.documentElement.dataset.theme = theme;
                const app = document.querySelector('#app');
                app.style.zoom = zoom;
                app.style.width = `${100 / zoom}vw`;
                app.style.height = `${100 / zoom}dvh`;
                app.dataset.panelPosition = side;
                app.style.setProperty('--server-marker-border', `${marker}px solid #249ff7`);
                window.monitor = new Monitoring(prefs, async () => {});
                document.querySelector('.monitor-controls').replaceChildren(monitor.summary(true));
            }, { font, side, theme, marker, zoom, prefs });
            await page.locator('[data-state=ready]').waitFor();
            let baseline;
            for (value of samples) {
                const old = await page.locator('.monitor-strip').elementHandle();
                await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
                await page.waitForFunction(node => !node.isConnected, old); await old.dispose();
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const geometry = await page.evaluate(() => {
                    const strip = document.querySelector('.monitor-strip'), rect = n => n.getBoundingClientRect().toJSON();
                    return {
                        bounds: rect(strip), columns: getComputedStyle(strip).gridTemplateColumns.split(' ').map(parseFloat),
                        viewport: { width: innerWidth, height: innerHeight },
                        slots: [...strip.querySelectorAll('.monitor-chip, .monitor-gauge, .monitor-value, .monitor-network-value svg')].map(rect),
                        readings: [...strip.querySelectorAll('.monitor-value')].map(n => ({ slot: rect(n), parts: [...n.children].map(rect) })),
                        networks: [...strip.querySelectorAll('.monitor-network-value')].map(n => [...n.children].map(rect)),
                    };
                });
                const inside = (child, parent) => child.left >= parent.left - .15 && child.right <= parent.right + .15;
                assert.ok(geometry.bounds.top >= 0 && geometry.bounds.bottom <= geometry.viewport.height + .1 && geometry.bounds.left >= 0 && geometry.bounds.right <= geometry.viewport.width + .1, `${label}: summary remains visible in the viewport`);
                for (const slot of geometry.slots) assert.ok(inside(slot, geometry.bounds), `${label}: metric fits sidebar`);
                for (const { slot, parts } of geometry.readings) for (const part of parts) assert.ok(inside(part, slot), `${label}: reading fits reserved slot`);
                for (const [down, up] of geometry.networks) {
                    assert.equal(down.y, up.y, `${label}: network stays on one line`);
                    assert.ok(down.right <= up.left + .1, `${label}: rates never overlap`);
                }
                if (baseline) assert.deepEqual(geometry.slots, baseline, `${label}: values never move columns, gauges, arrows or slots`);
                else baseline = geometry.slots;
                if (name === 'no-net') assert.ok(Math.abs(geometry.columns[0] - geometry.columns[1]) < .1, `${label}: narrow metrics share width evenly`);
                if (name === 'net-left' || name === 'net-right') {
                    const net = name === 'net-left' ? 0 : 1;
                    assert.ok(geometry.columns[net] > geometry.columns[1 - net], `${label}: NET expands its own column`);
                }
                if (value === 999) await page.locator('.topbar-right').screenshot({ path: `${output}/${label}.png` });
                checks++;
            }
        }
    }
    // Refit the existing summary when the marker changes, without rebuilding it.
    await page.evaluate(() => {
        monitor.dispose();
        window.monitor = new Monitoring(undefined, async () => {});
        document.querySelector('.monitor-controls').replaceChildren(monitor.summary(true));
    });
    await page.locator('[data-state=ready]').waitFor();
    for (const marker of [1, 4, 1]) {
        await page.evaluate(marker => document.querySelector('#app').style.setProperty('--server-marker-border', `${marker}px solid red`), marker);
        await page.waitForTimeout(80);
        assert.ok(await page.locator('.monitor-strip').evaluate(n => n.scrollWidth <= n.clientWidth), 'marker resize refits existing summary');
    }
    await page.evaluate(() => monitor.dispose());
    assert.deepEqual(errors, [], 'no browser errors or ResizeObserver loops');
    console.log(`PASS ${checks} monitor layouts: three fonts, both sides/themes, marker widths, fractional zoom, metric choices and stable numeric updates`);
} finally { await browser.close(); }
